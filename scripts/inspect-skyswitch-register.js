#!/usr/bin/env node
/**
 * Pull jambonz carrier/gateway config and infer the SIP REGISTER jambonz sends.
 * Does not capture live packets — use SkySwitch NMS trace or jambonz support for raw SIP.
 *
 * Required env: JAMBONZ_API_KEY, JAMBONZ_ACCOUNT_SID
 * Optional: SKYSWITCH_CARRIER_SID (default: SkySwitch-JambonzRetell carrier)
 */
const dns = require('dns').promises;
const {request} = require('undici');

const BASE_URL = (process.env.JAMBONZ_API_BASE_URL || 'https://api.jambonz.cloud/v1').replace(/\/$/, '');
const API_KEY = process.env.JAMBONZ_API_KEY;
const ACCOUNT_SID = process.env.JAMBONZ_ACCOUNT_SID;
const CARRIER_SID = process.env.SKYSWITCH_CARRIER_SID || '4617760b-aa27-4f1d-a18a-e796bd464b4c';
const CARRIER_NAME = process.env.SKYSWITCH_CARRIER_NAME || 'SkySwitch-JambonzRetell';

const headers = {
  Authorization: `Bearer ${API_KEY}`,
  'Content-Type': 'application/json'
};

const api = async(method, path) => {
  const {statusCode, body} = await request(`${BASE_URL}${path}`, {method, headers});
  const text = await body.text();
  const data = text ? JSON.parse(text) : {};
  if (statusCode >= 400) {
    throw new Error(`${method} ${path} (${statusCode}): ${JSON.stringify(data)}`);
  }
  return data;
};

const resolveTarget = async(gw) => {
  const host = gw.ipv4;
  const port = gw.port || 5060;
  const protocol = gw.protocol || 'udp';
  let addresses = [];
  try {
    if (port && port !== 5060) {
      addresses = await dns.resolve4(host);
    } else {
      try {
        const srv = await dns.resolveSrv(`_sip._${protocol}.${host}`);
        addresses = srv.map((r) => `${r.name}:${r.port}`);
      } catch {
        addresses = await dns.resolve4(host);
      }
    }
  } catch (err) {
    addresses = [`DNS lookup failed: ${err.message}`];
  }
  return {host, port, protocol, addresses};
};

const buildExpectedRegister = ({carrier, gw, resolved}) => {
  const realm = carrier.register_sip_realm;
  const user = carrier.register_username;
  const targetIp = Array.isArray(resolved.addresses) && typeof resolved.addresses[0] === 'string'
    && !resolved.addresses[0].includes('failed')
    ? resolved.addresses[0].split(':')[0]
    : resolved.host;
  const transport = (gw.protocol || 'udp').toUpperCase();

  return {
    summary: 'Inferred from jambonz carrier + gateway config (not a live capture)',
    register_to: `${targetIp}:${gw.port || 5060}`,
    transport: transport,
    request_uri: `sip:${realm}`,
    to_header: `<sip:${user}@${realm}>`,
    from_header: `<sip:${user}@${realm}>`,
    contact_expected: `sip:${user}@<jambonz-sbc-ip>:5060;transport=${(gw.protocol || 'udp').toLowerCase()}`,
    jambonz_signaling_ip: '54.236.168.131 (jambonz.cloud static SIP IP per docs)',
    auth_flow: 'REGISTER -> 401/407 -> REGISTER with Authorization (digest)',
    sample_first_register: [
      `REGISTER sip:${realm} SIP/2.0`,
      `Via: SIP/2.0/${transport} 54.236.168.131:5060;branch=z9hG4bK...`,
      `From: <sip:${user}@${realm}>;tag=...`,
      `To: <sip:${user}@${realm}>`,
      `Call-ID: ...`,
      `CSeq: 1 REGISTER`,
      `Contact: <sip:${user}@54.236.168.131:5060;transport=${(gw.protocol || 'udp').toLowerCase()}>`,
      `Expires: 3600`,
      `Max-Forwards: 70`,
      `Content-Length: 0`,
      ''
    ].join('\r\n')
  };
};

const compareToSkySwitch = (expected) => ({
  skyswitch_expects: {
    registrar_host: 'nms5-atl.dialtoen.com',
    registrar_ip: '207.254.80.47',
    transport: 'TCP',
    realm: 'visionquest.22393.service',
    username: 'KickCalltest',
    working_trace_contact: 'sip:1009@16.54.193.92:5080;transport=tcp (registered device)'
  },
  checks: [
    {
      field: 'Gateway host',
      jambonz: expected.register_to,
      skyswitch: 'nms5-atl.dialtoen.com:5060 (TCP)',
      match: expected.register_to.includes('207.254.80.47') || expected.register_to.includes('dialtoen.com')
    },
    {
      field: 'Transport',
      jambonz: expected.transport,
      skyswitch: 'TCP',
      match: expected.transport === 'TCP'
    },
    {
      field: 'SIP realm in Request-URI',
      jambonz: expected.request_uri,
      skyswitch: 'sip:visionquest.22393.service',
      match: expected.request_uri === 'sip:visionquest.22393.service'
    },
    {
      field: 'AOR (To/From user@realm)',
      jambonz: expected.to_header,
      skyswitch: 'KickCalltest@visionquest.22393.service',
      match: expected.to_header.includes('KickCalltest') && expected.to_header.includes('visionquest.22393.service')
    }
  ]
});

const main = async() => {
  if (!API_KEY || !ACCOUNT_SID) {
    console.error('Set JAMBONZ_API_KEY and JAMBONZ_ACCOUNT_SID');
    process.exit(1);
  }

  const carrier = await api('GET', `/VoipCarriers/${CARRIER_SID}`);
  const gateways = await api('GET', `/SipGateways?voip_carrier_sid=${CARRIER_SID}`);
  const outboundGws = gateways.filter((g) => g.outbound);

  console.log(JSON.stringify({
    carrier: {
      name: carrier.name,
      voip_carrier_sid: carrier.voip_carrier_sid,
      trunk_type: carrier.trunk_type,
      requires_register: carrier.requires_register,
      register_username: carrier.register_username,
      register_sip_realm: carrier.register_sip_realm,
      register_from_user: carrier.register_from_user,
      register_status: carrier.register_status,
      is_active: carrier.is_active
    },
    outbound_gateways: outboundGws.map((g) => ({
      sip_gateway_sid: g.sip_gateway_sid,
      ipv4: g.ipv4,
      port: g.port,
      protocol: g.protocol,
      outbound: g.outbound,
      is_active: g.is_active
    }))
  }, null, 2));

  for (const gw of outboundGws) {
    const resolved = await resolveTarget(gw);
    const expected = buildExpectedRegister({carrier, gw, resolved});
    const comparison = compareToSkySwitch(expected);

    console.log('\n--- Expected REGISTER (inferred) ---');
    console.log(JSON.stringify({resolved, expected, comparison}, null, 2));
    console.log('\n--- Sample first REGISTER ---\n');
    console.log(expected.sample_first_register);
  }

  console.log('\n--- How to capture RAW SIP from jambonz ---');
  console.log([
    '1. jambonz.cloud does not expose Homer/pcap to tenants — open a jambonz support ticket',
    '   and ask for SIP REGISTER trace for carrier SkySwitch-JambonzRetell at timestamp X.',
    '2. On SkySwitch NMS, enable packet/trace capture on KickCalltest device and trigger',
    '   a re-register by toggling the carrier off/on in jambonz portal.',
    '3. Compare incoming REGISTER source IP to 54.236.168.131 and transport to TCP.',
    '4. register_status above shows last SIP response code/reason from jambonz SBC.'
  ].join('\n'));
};

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
