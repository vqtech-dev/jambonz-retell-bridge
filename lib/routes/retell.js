const useDialSipEndpointMethod = Number(process.env.USE_DIAL_SIP_ENDPOINT_METHOD) || 0;
const assert = require('assert');
const {registerCall, getE164, validateCountryCode} = require('../../lib/utils');
const DEFAULT_COUNTRY = process.env.DEFAULT_COUNTRY || false;
const OVERRIDE_FROM_USER = process.env.OVERRIDE_FROM_USER || false;

// Your own DID(s) -- used as a fallback signal to detect a Retell-originated
// transfer leg in case the X-Authenticated-User header isn't present due to
// Carrier IP-matching bypassing Client digest auth. Comma-separated if you
// ever add more numbers.
const OWN_DIDS = (process.env.OWN_DIDS || '+12297406150')
  .split(',')
  .map((n) => n.trim())
  .filter(Boolean);

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
    session.locals = {logger: logger.child({call_sid: session.call_sid})};
    let {from, to, direction, call_sid} = session;
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
      pstn_trunk: process.env.PSTN_TRUNK_NAME,
      retell_username: process.env.RETELL_SIP_CLIENT_USERNAME,
      auth_user_header_ci: authUserHeader,
      to: session.to,
      from: session.from,
      own_dids: OWN_DIDS
    }, 'Retell routing debug');

    if (session.direction === 'inbound' &&
      process.env.PSTN_TRUNK_NAME && process.env.RETELL_SIP_CLIENT_USERNAME &&
      authUserHeader) {

      /* Primary detection: check if the call is coming from Retell via the
         sip credential we provisioned there (case-insensitive header lookup) */
      const username = authUserHeader.split('@')[0];
      if (username === process.env.RETELL_SIP_CLIENT_USERNAME) {
        logger.info(`call ${session.call_sid} is coming from Retell (matched via auth header)`);
        outboundFromRetell = true;
        detectionMethod = 'auth-header';
      }
    }

    if (!outboundFromRetell &&
      session.direction === 'inbound' &&
      process.env.PSTN_TRUNK_NAME &&
      OWN_DIDS.includes(from)) {

      /* Fallback detection: if the auth header wasn't set (e.g. Carrier
         IP-matching bypassed Client digest auth entirely) but the 'from'
         on this inbound leg is our own DID rather than an external caller,
         this is almost certainly Retell calling back to execute a transfer,
         not a genuine new inbound call from the PSTN. */
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
      let headers = {}
      if (outboundFromRetell) {
        /* call is coming from Retell, so we will forward it to the original dialed number */

        // Strip a leading '1' for lookup consistency, then normalize back to
        // 11-digit form to match how NURSE_LINE_DID is expected to be set.
        const digitsOnly = to.replace(/\D/g, '').replace(/^1/, '');
        const lookupKey = `1${digitsOnly}`;
        const internalExtension = INTERNAL_EXTENSION_MAP[lookupKey];

        if (internalExtension) {
          session.locals.logger.info(
            `${to} is an internal extension (${internalExtension}), dialing on-net instead of via PSTN`
          );
          target = [
            {
              type: 'phone',
              number: internalExtension,
              trunk: process.env.PSTN_TRUNK_NAME
            }
          ];
        } else {
          target = [
            {
              type: 'phone',
              number: to,
              trunk: process.env.PSTN_TRUNK_NAME
            }
          ];
        }

        /* Workaround for SIPGATE, put User ID as from and CLI in header */
        if (OVERRIDE_FROM_USER) {
          //headers["P-Preferred-Identity"] = `${from}@SIPGATE_DOMAIN`;
          from = OVERRIDE_FROM_USER;
        }
      }
      else if (useDialSipEndpointMethod) {
        /* https://docs.retellai.com/make-calls/custom-telephony#method-2-dial-to-sip-endpoint */
        const retell_call_id = await registerCall(logger, {
          agent_id: process.env.RETELL_AGENT_ID,
          from,
          to,
          direction,
          call_sid,
          retell_llm_dynamic_variables: {
            /* https://docs.retellai.com/retell-llm/dynamic-variables#phone-calls-with-your-own-numbers-custom-twilio */
            user_name: 'John Doe',
            user_email: 'john@example.com'
          }
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

        /**
         * Note: below we are forwarding the incoming call to Retell using the same dialed number.
         * This presumes you have added this number to your Retell account.
         * If you added a different number, you can change the `to` variable.
         */
        // If default country code is set then ensure to is in e.164 format
        const dest = DEFAULT_COUNTRY ? await getE164(logger, to, DEFAULT_COUNTRY) : to
        target = [
          {
            type: 'phone',
            number: dest,
            trunk: process.env.RETELL_TRUNK_NAME
          }
        ];
      }

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
  logger.info({refer_details}, `session ${session.call_sid} received refer`);

  session
    .sip_refer({
      referTo: refer_details.refer_to_user,
      referredBy: evt.to,
      actionHook: '/referComplete'

    })
    .reply();
};

const onClose = (session, code, reason) => {
  delete sessions[session.call_sid]
  const {logger} = session.locals;
  clearInterval(session.locals.keepAlive); // remove keep alive
  logger.info({session, code, reason}, `session ${session.call_sid} closed`);
};

const onError = (session, err) => {
  const {logger} = session.locals;
  logger.info({err}, `session ${session.call_sid} received error`);
};

const onDialAction = (session, evt) => {
  const {logger} = session.locals;
  if (evt.dial_call_status != 'completed') {
    logger.info(`outbound dial failed with ${evt.dial_call_status}, ${evt.dial_sip_status}`);
    session
      .sip_decline({status: evt.dial_sip_status})
      .reply();
  }
}

/* When the refer completes if we have an adulted call scenario hangup the original A leg */
const onReferComplete = (session, evt) => {
  const {logger} = session.locals;
  logger.info({evt}, 'referComplete');
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
