const useDialSipEndpointMethod = Number(process.env.USE_DIAL_SIP_ENDPOINT_METHOD) || 0;
const assert = require('assert');
const {registerCall, getE164, validateCountryCode} = require('../../lib/utils');
const {
  DEFAULTS,
  resolveTenantByDid,
  resolveTenantByOwnDid,
  resolveTransferTenant,
  tenantDynamicVariables,
  buildSkySwitchTransferHeaders,
  isRetellAuthUser,
  getTenantDids
} = require('../tenant-config');
const DEFAULT_COUNTRY = process.env.DEFAULT_COUNTRY || false;
const OVERRIDE_FROM_USER = process.env.OVERRIDE_FROM_USER || false;

// Legacy global defaults remain as fallbacks when TENANT_CONFIG omits a field.
const SKYSWITCH_CARRIER_NAME = DEFAULTS.skyswitch_outbound_carrier;
const SKYSWITCH_SIP_REALM = DEFAULTS.skyswitch_sip_realm;
const SKYSWITCH_REGISTER_USERNAME = DEFAULTS.skyswitch_register_username;
const SKYSWITCH_EXTENSION_DOMAIN = DEFAULTS.skyswitch_extension_domain;

// Your own DID(s) -- used as a fallback signal to detect a Retell-originated
// transfer leg in case the X-Authenticated-User header isn't present due to
// Carrier IP-matching bypassing Client digest auth. Comma-separated if you
// ever add more numbers. TENANT_CONFIG keys are merged in automatically.
const tenantDids = getTenantDids();
const OWN_DIDS = [...new Set([
  ...(process.env.OWN_DIDS || '+12297406150').split(',').map((n) => n.trim()).filter(Boolean),
  ...tenantDids
])];

// Internal SkySwitch extensions that transfers may target. These are
// provisioned users on the domain, not outside lines -- SkySwitch's edge
// rejects them (403, no CDR trace) if dialed as a full external DID through
// the PSTN trunk. On-net transfers must dial the short extension instead.
// Add more NURSE_LINE_DID / NURSE_LINE_EXTENSION style pairs here as needed.
const INTERNAL_EXTENSION_MAP = {};
if (process.env.NURSE_LINE_DID && process.env.NURSE_LINE_EXTENSION) {
  INTERNAL_EXTENSION_MAP[process.env.NURSE_LINE_DID] = process.env.NURSE_LINE_EXTENSION;
}

assert.ok(useDialSipEndpointMethod === 1 || process.env.RETELL_TRUNK_NAME,
  // eslint-disable-next-line max-len
  'RETELL_TRUNK_NAME env required when using elastic sip trunking method; it must contain the name of the jambonz BYOC trunk that connects to retell');

// IF a default country code has been set check its the right format,
if (DEFAULT_COUNTRY){
  validateCountryCode(DEFAULT_COUNTRY);
}
const sessions = {};

const logTransferSipResponse = (logger, context, evt) => {
  const sipStatus = Number(evt.dial_sip_status || evt.sip_status || 0);
  const payload = {
    ...context,
    dial_call_status: evt.dial_call_status,
    dial_sip_status: sipStatus,
    sip_reason: evt.sip_reason,
    termination_reason: evt.termination_reason,
    is_busy: sipStatus === 486,
    is_forbidden: sipStatus === 403,
    is_proxy_auth_required: sipStatus === 407,
    is_not_found: sipStatus === 404,
    is_decline: sipStatus === 603,
    carrier: context.carrier || SKYSWITCH_CARRIER_NAME,
    evt
  };

  if (sipStatus >= 400) {
    logger.warn(payload, 'Transfer leg SIP error response');
  } else {
    logger.info(payload, 'Transfer leg SIP response');
  }
  return sipStatus;
};

/* Build a lowercase-keyed copy of headers so lookups are case-insensitive.
   SIP/HTTP transport layers frequently normalize header casing, and an
   exact-case lookup like headers['X-Authenticated-User'] can silently
   return undefined even when the header is present under a different case. */
const getHeaderCaseInsensitive = (headers, name) => {
  const target = name.toLowerCase();
  const foundKey = Object.keys(headers || {}).find((k) => k.toLowerCase() === target);
  return foundKey ? headers[foundKey] : undefined;
};

const service = ({logger, makeService}) => {
  const svc = makeService({path: '/retell'});

  svc.on('session:new', async(session) => {
    sessions[session.call_sid] = session;
    session.locals = {logger: logger.child({call_sid: session.call_sid}), tenant: null};
    let {from, to, direction, call_sid} = session;

    const {tenant: inboundTenant} = resolveTenantByDid(to);
    if (inboundTenant) {
      session.locals.tenant = inboundTenant;
    }

    logger.info({session}, `new incoming call: ${session.call_sid}`);

    /* Send ping to keep alive websocket as some platforms timeout, 25sec as 30sec timeout is not uncommon */
    session.locals.keepAlive = setInterval(() => {
      session.ws.ping();
    }, 25000);

    /* Full header dump -- confirms exact casing Jambonz is sending and
       surfaces any other field that could identify the leg's origin. */
    logger.info({
      allHeaderKeys: Object.keys(session.sip.headers || {}),
      allHeaders: session.sip.headers
    }, 'FULL SIP HEADERS DUMP');

    const authUserHeader = getHeaderCaseInsensitive(session.sip.headers, 'X-Authenticated-User');

    let outboundFromRetell = false;
    let detectionMethod = 'none';

    logger.info({
      direction: session.direction,
      skyswitch_carrier: SKYSWITCH_CARRIER_NAME,
      retell_trunk: process.env.RETELL_TRUNK_NAME,
      retell_username: process.env.RETELL_SIP_CLIENT_USERNAME,
      auth_user_header_ci: authUserHeader,
      to: session.to,
      from: session.from,
      own_dids: OWN_DIDS
    }, 'Retell routing debug');

    if (session.direction === 'inbound' &&
      authUserHeader &&
      isRetellAuthUser(authUserHeader)) {

      /* Primary detection: Retell transfer leg authenticated via tenant or global SIP credential. */
      const {tenant: retellTenant} = resolveTransferTenant({
        storedTenant: session.locals.tenant,
        from,
        authUserHeader
      });
      session.locals.tenant = retellTenant;
      logger.info(`call ${session.call_sid} is coming from Retell (matched via auth header)`);
      outboundFromRetell = true;
      detectionMethod = 'auth-header';
    }

    if (!outboundFromRetell &&
      session.direction === 'inbound' &&
      OWN_DIDS.includes(from)) {

      /* Fallback detection: Retell transfer leg identified by practice DID in From. */
      const {tenant: didTenant} = resolveTenantByOwnDid(from);
      if (didTenant) {
        session.locals.tenant = didTenant;
      }
      logger.info(
        `call ${session.call_sid} is coming from Retell (matched via own-DID fallback, auth header was absent)`
      );
      outboundFromRetell = true;
      detectionMethod = 'own-did-fallback';
    }

    logger.info({detectionMethod, outboundFromRetell}, 'Routing decision made');

    session
      .on('/refer', onRefer.bind(null, session))
      .on('close', onClose.bind(null, session))
      .on('error', onError.bind(null, session))
      .on('/dialAction', onDialAction.bind(null, session))
      .on('/referComplete', onReferComplete.bind(null, session));

    try {
      let target;
      let headers = {};

      if (outboundFromRetell) {
        /* Warm transfer leg: use the tenant's outbound SkySwitch carrier and SIP identity. */
        const tenant = resolveTransferTenant({
          storedTenant: session.locals.tenant,
          from,
          authUserHeader
        });
        session.locals.tenant = tenant;
        const outboundCarrier = tenant.skyswitch_outbound_carrier;
        const extensionDomain = tenant.skyswitch_extension_domain;

        const digitsOnly = to.replace(/\D/g, '').replace(/^1/, '');
        const lookupKey = `1${digitsOnly}`;
        const internalExtension = INTERNAL_EXTENSION_MAP[lookupKey];

        if (internalExtension) {
          session.locals.logger.info({
            to,
            internalExtension,
            carrier: outboundCarrier,
            domain: extensionDomain,
            customer_id: tenant.customer_id
          }, 'Transfer target is on-net extension, dialing via registered carrier');

          target = [
            {
              type: 'phone',
              number: internalExtension,
              trunk: outboundCarrier
            }
          ];
        } else {
          session.locals.logger.info({
            to,
            carrier: outboundCarrier,
            customer_id: tenant.customer_id,
            sip_realm: tenant.skyswitch_sip_realm
          }, 'Transfer target is external PSTN, dialing via registered carrier');

          target = [
            {
              type: 'phone',
              number: to,
              trunk: outboundCarrier
            }
          ];
        }

        headers = buildSkySwitchTransferHeaders(from, tenant, headers);

        if (OVERRIDE_FROM_USER) {
          from = OVERRIDE_FROM_USER;
          headers['P-Asserted-Identity'] = `<sip:${OVERRIDE_FROM_USER}>`;
          headers['P-Preferred-Identity'] = `<sip:${OVERRIDE_FROM_USER}>`;
          session.locals.logger.info({
            override_from_user: OVERRIDE_FROM_USER,
            headers
          }, 'Applying outbound SIP identity override');
        }
      }
      else if (useDialSipEndpointMethod) {
        /* https://docs.retellai.com/make-calls/custom-telephony#method-2-dial-to-sip-endpoint */
        const {tenant, error: tenantError} = resolveTenantByDid(to);
        if (tenantError) {
          logger.warn({to, tenantError}, 'Tenant lookup failed for registerCall');
        }
        const retell_call_id = await registerCall(logger, {
          agent_id: tenant?.retell_agent_id || process.env.RETELL_AGENT_ID,
          from,
          to,
          direction,
          call_sid,
          retell_llm_dynamic_variables: tenant
            ? tenantDynamicVariables(tenant)
            : {}
        });
        logger.info({retell_call_id}, 'Call registered');
        target = [
          {
            type: 'sip',
            sipUri: `sip:${retell_call_id}@5t4n6j0wnrl.sip.livekit.cloud`
          }
        ];
      }
      else {
        /* https://docs.retellai.com/make-calls/custom-telephony#method-1-elastic-sip-trunking-recommended */
        const tenant = session.locals.tenant || resolveTenantByDid(to).tenant;
        const retellTrunk = tenant?.retell_trunk_name || process.env.RETELL_TRUNK_NAME;

        const dest = DEFAULT_COUNTRY ? await getE164(logger, to, DEFAULT_COUNTRY) : to;
        target = [
          {
            type: 'phone',
            number: dest,
            trunk: retellTrunk
          }
        ];
      }

      const activeTenant = session.locals.tenant;
      logger.info({
        outbound_transfer_debug: true,
        outboundFromRetell,
        callerId: from,
        target,
        headers,
        customer_id: activeTenant?.customer_id,
        skyswitch_carrier: activeTenant?.skyswitch_outbound_carrier || SKYSWITCH_CARRIER_NAME,
        retell_trunk: activeTenant?.retell_trunk_name || process.env.RETELL_TRUNK_NAME
      }, 'FINAL JAMBONZ OUTBOUND TRANSFER');

      session
        .dial({
          callerId: from,
          answerOnBridge: true,
          anchorMedia: true,
          referHook: '/refer',
          actionHook: '/dialAction',
          target,
          headers
        })
        .hangup()
        .send();
    } catch (err) {
      session.locals.logger.info({err}, `Error to responding to incoming call: ${session.call_sid}`);
      session.close();
    }
  });
};

const onRefer = (session, evt) => {
  const {logger} = session.locals;
  const {refer_details} = evt;
  logger.info({
    refer_details,
    carrier: session.locals.tenant?.skyswitch_outbound_carrier || SKYSWITCH_CARRIER_NAME,
    register_username: session.locals.tenant?.skyswitch_register_username || SKYSWITCH_REGISTER_USERNAME,
    sip_realm: session.locals.tenant?.skyswitch_sip_realm || SKYSWITCH_SIP_REALM,
    customer_id: session.locals.tenant?.customer_id
  }, `session ${session.call_sid} received REFER for warm transfer`);

  session
    .sip_refer({
      referTo: refer_details.refer_to_user,
      referredBy: evt.to,
      actionHook: '/referComplete'
    })
    .reply();
};

const onClose = (session, code, reason) => {
  delete sessions[session.call_sid];
  const {logger} = session.locals;
  clearInterval(session.locals.keepAlive);
  logger.info({session, code, reason}, `session ${session.call_sid} closed`);
};

const onError = (session, err) => {
  const {logger} = session.locals;
  logger.info({err, carrier: SKYSWITCH_CARRIER_NAME}, `session ${session.call_sid} received error`);
};

const onDialAction = (session, evt) => {
  const {logger} = session.locals;
  const sipStatus = logTransferSipResponse(logger, {
    hook: 'dialAction',
    call_sid: session.call_sid,
    parent_call_sid: session.parent_call_sid,
    carrier: session.locals.tenant?.skyswitch_outbound_carrier || SKYSWITCH_CARRIER_NAME,
    customer_id: session.locals.tenant?.customer_id
  }, evt);

  if (evt.dial_call_status != 'completed') {
    logger.warn({
      dial_call_status: evt.dial_call_status,
      dial_sip_status: sipStatus,
      carrier: session.locals.tenant?.skyswitch_outbound_carrier || SKYSWITCH_CARRIER_NAME,
      customer_id: session.locals.tenant?.customer_id,
      likely_cause: sipStatus === 403 ? 'trunk=user or auth failure — verify registered carrier is used'
        : sipStatus === 486 ? 'destination busy'
          : sipStatus === 407 ? 'proxy auth challenge not satisfied on transfer leg'
            : 'see dial_sip_status'
    }, 'Outbound transfer dial failed');

    session
      .sip_decline({status: evt.dial_sip_status})
      .reply();
  }
};

/* When the refer completes if we have an adulted call scenario hangup the original A leg */
const onReferComplete = (session, evt) => {
  const {logger} = session.locals;
  logTransferSipResponse(logger, {
    hook: 'referComplete',
    call_sid: session.call_sid,
    parent_call_sid: session.parent_call_sid,
    refer_to: evt.refer_to,
    final_referred_call_status: evt.final_referred_call_status
  }, evt);

  if (session.parent_call_sid) {
    logger.info(`Sending hangup to parent session ${session.parent_call_sid}`);
    const parentSession = sessions[session.parent_call_sid];
    parentSession
      .hangup()
      .send();
  } else {
    logger.info('No parent session');
  }
};

module.exports = service;
