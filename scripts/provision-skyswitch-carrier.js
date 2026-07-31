#!/usr/bin/env node
/**
 * Provision the SkySwitch-JambonzRetell registration carrier on jambonz.
 *
 * Creates a separate registration trunk (trunk_type=reg) that registers
 * KickCalltest@visionquest.22393.service to 22393.hpbx.outboundproxy.com over UDP.
 * Does NOT modify any existing Retell-Trunk carrier.
 *
 * Required env:
 *   JAMBONZ_ACCOUNT_SID
 *   JAMBONZ_API_KEY
 *   JAMBONZ_SERVICE_PROVIDER_SID
 *
 * Optional env (defaults match working Vqtech/SkySwitch jambonz carrier):
 *   JAMBONZ_API_BASE_URL          https://api.jambonz.cloud/v1
 *   SKYSWITCH_CARRIER_NAME        SkySwitch-JambonzRetell
 *   SKYSWITCH_REGISTER_USERNAME   KickCalltest
 *   SKYSWITCH_REGISTER_PASSWORD   (required)
 *   SKYSWITCH_SIP_REALM           visionquest.22393.service
 *   SKYSWITCH_REGISTRAR_HOST      22393.hpbx.outboundproxy.com
 *   SKYSWITCH_REGISTRAR_PORT      5060
 *   SKYSWITCH_REGISTRAR_PROTOCOL  udp
 *   JAMBONZ_APPLICATION_SID       attach inbound calls to this app (optional)
 */
const {request} = require('undici');
const carrierConfig = require('../config/skyswitch-jambonz-retell-carrier.json');

const BASE_URL = (process.env.JAMBONZ_API_BASE_URL || 'https://api.jambonz.cloud/v1').replace(/\/$/, '');
const ACCOUNT_SID = process.env.JAMBONZ_ACCOUNT_SID;
const API_KEY = process.env.JAMBONZ_API_KEY;
const SP_SID = process.env.JAMBONZ_SERVICE_PROVIDER_SID;

const CARRIER_NAME = process.env.SKYSWITCH_CARRIER_NAME || carrierConfig.name;
const REGISTER_USERNAME = process.env.SKYSWITCH_REGISTER_USERNAME || carrierConfig.register_username;
const REGISTER_PASSWORD = process.env.SKYSWITCH_REGISTER_PASSWORD;
const REGISTER_REALM = process.env.SKYSWITCH_SIP_REALM || carrierConfig.register_sip_realm;
const REGISTRAR_HOST = process.env.SKYSWITCH_REGISTRAR_HOST || carrierConfig.sip_gateway.ipv4;
const REGISTRAR_PORT = Number(process.env.SKYSWITCH_REGISTRAR_PORT || carrierConfig.sip_gateway.port);
const REGISTRAR_PROTOCOL = process.env.SKYSWITCH_REGISTRAR_PROTOCOL || carrierConfig.sip_gateway.protocol;
const APPLICATION_SID = process.env.JAMBONZ_APPLICATION_SID;

const headers = {
  Authorization: `Bearer ${API_KEY}`,
  'Content-Type': 'application/json'
};

const api = async(method, path, body) => {
  const {statusCode, body: resBody} = await request(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await resBody.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {raw: text};
  }
  if (statusCode >= 400) {
    throw new Error(`${method} ${path} failed (${statusCode}): ${JSON.stringify(data)}`);
  }
  return {statusCode, data};
};

const listAccountCarriers = async() => {
  const {data} = await api('GET', `/Accounts/${ACCOUNT_SID}/VoipCarriers`);
  return Array.isArray(data) ? data : [];
};

const listCarrierGateways = async(voipCarrierSid) => {
  const {data} = await api('GET', `/SipGateways?voip_carrier_sid=${voipCarrierSid}`);
  return Array.isArray(data) ? data : [];
};

const main = async() => {
  if (!ACCOUNT_SID || !API_KEY || !SP_SID) {
    console.error('Missing required env: JAMBONZ_ACCOUNT_SID, JAMBONZ_API_KEY, JAMBONZ_SERVICE_PROVIDER_SID');
    process.exit(1);
  }
  if (!REGISTER_PASSWORD) {
    console.error('Missing required env: SKYSWITCH_REGISTER_PASSWORD');
    process.exit(1);
  }

  console.log(`Provisioning carrier "${CARRIER_NAME}" on account ${ACCOUNT_SID}`);

  const carriers = await listAccountCarriers();
  let carrier = carriers.find((c) => c.name === CARRIER_NAME);

  const carrierPayload = {
    service_provider_sid: SP_SID,
    account_sid: ACCOUNT_SID,
    name: CARRIER_NAME,
    description: carrierConfig.description,
    trunk_type: 'reg',
    requires_register: true,
    register_username: REGISTER_USERNAME,
    register_sip_realm: REGISTER_REALM,
    register_password: REGISTER_PASSWORD,
    e164_leading_plus: true,
    is_active: true
  };
  if (APPLICATION_SID) {
    carrierPayload.application_sid = APPLICATION_SID;
  }

  if (carrier) {
    console.log(`Carrier exists (${carrier.voip_carrier_sid}), updating registration settings`);
    await api('PUT', `/VoipCarriers/${carrier.voip_carrier_sid}`, carrierPayload);
  } else {
    console.log('Creating new registration carrier');
    const {data} = await api('POST', `/Accounts/${ACCOUNT_SID}/VoipCarriers`, carrierPayload);
    carrier = {voip_carrier_sid: data.sid, name: CARRIER_NAME};
    console.log(`Created carrier sid=${carrier.voip_carrier_sid}`);
  }

  const gateways = await listCarrierGateways(carrier.voip_carrier_sid);
  const gatewayPayload = {
    voip_carrier_sid: carrier.voip_carrier_sid,
    ipv4: REGISTRAR_HOST,
    port: REGISTRAR_PORT,
    protocol: REGISTRAR_PROTOCOL,
    netmask: 32,
    outbound: true,
    inbound: false,
    is_active: true
  };

  const existingGw = gateways.find((g) => g.ipv4 === REGISTRAR_HOST && g.port === REGISTRAR_PORT);
  if (existingGw) {
    console.log(`SIP gateway exists (${existingGw.sip_gateway_sid}), updating to ${REGISTRAR_PROTOCOL}`);
    await api('PUT', `/SipGateways/${existingGw.sip_gateway_sid}`, {
      ...gatewayPayload,
      sip_gateway_sid: existingGw.sip_gateway_sid
    });
  } else {
    console.log(`Creating outbound SIP gateway ${REGISTRAR_HOST}:${REGISTRAR_PORT} (${REGISTRAR_PROTOCOL})`);
    const {data} = await api('POST', '/SipGateways', gatewayPayload);
    console.log(`Created gateway sid=${data.sid}`);
  }

  for (const gw of gateways) {
    if (gw.outbound && gw.ipv4 !== REGISTRAR_HOST && gw.is_active) {
      console.log(`Deactivating stale outbound gateway ${gw.ipv4}:${gw.port} (${gw.sip_gateway_sid})`);
      await api('PUT', `/SipGateways/${gw.sip_gateway_sid}`, {
        ipv4: gw.ipv4,
        port: gw.port,
        netmask: gw.netmask,
        voip_carrier_sid: gw.voip_carrier_sid,
        inbound: gw.inbound,
        outbound: false,
        is_active: false,
        protocol: gw.protocol
      });
    }
  }

  console.log('\nDone. Carrier configuration:');
  console.log(JSON.stringify({
    name: CARRIER_NAME,
    voip_carrier_sid: carrier.voip_carrier_sid,
    trunk_type: 'reg',
    register_username: REGISTER_USERNAME,
    register_sip_realm: REGISTER_REALM,
    registrar: `${REGISTRAR_HOST}:${REGISTRAR_PORT}`,
    protocol: REGISTRAR_PROTOCOL,
    application_sid: APPLICATION_SID || '(not set — assign in portal or set JAMBONZ_APPLICATION_SID)'
  }, null, 2));
  console.log('\nSet on the bridge app:');
  console.log(`  SKYSWITCH_CARRIER_NAME=${CARRIER_NAME}`);
  console.log(`  SKYSWITCH_SIP_REALM=${REGISTER_REALM}`);
  console.log(`  SKYSWITCH_REGISTER_USERNAME=${REGISTER_USERNAME}`);
};

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
