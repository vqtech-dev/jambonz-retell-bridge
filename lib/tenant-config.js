const DEFAULTS = {
  skyswitch_outbound_carrier: process.env.SKYSWITCH_CARRIER_NAME
    || process.env.PSTN_TRUNK_NAME
    || 'SkySwitch-JambonzRetell',
  skyswitch_sip_realm: process.env.SKYSWITCH_SIP_REALM || 'visionquest.22393.service',
  skyswitch_register_username: process.env.SKYSWITCH_REGISTER_USERNAME || 'KickCalltest',
  skyswitch_extension_domain: process.env.SKYSWITCH_EXTENSION_DOMAIN
    || process.env.SKYSWITCH_SIP_REALM
    || 'visionquest.22393.service',
  retell_trunk_name: process.env.RETELL_TRUNK_NAME || '',
  retell_sip_client_username: process.env.RETELL_SIP_CLIENT_USERNAME || ''
};

const normalizePhone = (value) => {
  if (!value) return '';
  const digits = String(value).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return value.startsWith('+') ? value : `+${digits}`;
};

const loadTenants = () => {
  const raw = (process.env.TENANT_CONFIG || '').trim();
  if (!raw) return {};
  return JSON.parse(raw);
};

const TENANTS_BY_DID = loadTenants();

const getTenantDids = () => Object.keys(TENANTS_BY_DID);

const enrichTenant = (tenant, calledDid = '') => ({
  ...tenant,
  called_did: calledDid || tenant.called_did || '',
  skyswitch_outbound_carrier: tenant.skyswitch_outbound_carrier || DEFAULTS.skyswitch_outbound_carrier,
  skyswitch_sip_realm: tenant.skyswitch_sip_realm || DEFAULTS.skyswitch_sip_realm,
  skyswitch_register_username: tenant.skyswitch_register_username || DEFAULTS.skyswitch_register_username,
  skyswitch_extension_domain: tenant.skyswitch_extension_domain || tenant.skyswitch_sip_realm || DEFAULTS.skyswitch_extension_domain,
  retell_trunk_name: tenant.retell_trunk_name || DEFAULTS.retell_trunk_name,
  retell_sip_client_username: tenant.retell_sip_client_username || DEFAULTS.retell_sip_client_username
});

const resolveTenantByDid = (did) => {
  const normalized = normalizePhone(did);
  if (!normalized) {
    return { tenant: null, error: 'Missing called number (to_number)' };
  }

  const tenant = TENANTS_BY_DID[normalized];
  if (!tenant) {
    return { tenant: null, error: `Unknown DID: ${normalized}` };
  }

  return {
    tenant: enrichTenant(tenant, normalized),
    error: null
  };
};

const resolveTenantByOwnDid = (did) => {
  const normalized = normalizePhone(did);
  if (!normalized) {
    return { tenant: null, error: null };
  }
  return resolveTenantByDid(normalized);
};

const resolveTenantByRetellUsername = (authUserHeader) => {
  if (!authUserHeader) {
    return { tenant: null, error: null };
  }

  const username = authUserHeader.split('@')[0];
  for (const did of getTenantDids()) {
    const tenant = enrichTenant(TENANTS_BY_DID[did], did);
    if (tenant.retell_sip_client_username && tenant.retell_sip_client_username === username) {
      return { tenant, error: null };
    }
  }

  if (DEFAULTS.retell_sip_client_username && DEFAULTS.retell_sip_client_username === username) {
    return { tenant: enrichTenant({}, ''), error: null };
  }

  return { tenant: null, error: null };
};

const tenantDynamicVariables = (tenant) => ({
  location_id: tenant.location_id || '',
  customer_id: tenant.customer_id || '',
  called_did: tenant.called_did || ''
});

const buildSkySwitchTransferHeaders = (callerId, tenant, extraHeaders = {}) => {
  const headers = {...extraHeaders};
  const registeredIdentity = `<sip:${tenant.skyswitch_register_username}@${tenant.skyswitch_sip_realm}>`;

  headers['P-Asserted-Identity'] = `"${callerId}" ${registeredIdentity}`;
  headers['P-Preferred-Identity'] = `"${callerId}" ${registeredIdentity}`;

  return headers;
};

const isRetellAuthUser = (authUserHeader) => {
  if (!authUserHeader) return false;
  const username = authUserHeader.split('@')[0];
  if (DEFAULTS.retell_sip_client_username && username === DEFAULTS.retell_sip_client_username) {
    return true;
  }
  return getTenantDids().some((did) => {
    const tenant = TENANTS_BY_DID[did];
    return tenant.retell_sip_client_username && tenant.retell_sip_client_username === username;
  });
};

const resolveTransferTenant = ({storedTenant, from, authUserHeader}) => {
  if (storedTenant) {
    return storedTenant;
  }

  const byDid = resolveTenantByOwnDid(from);
  if (byDid.tenant) {
    return byDid.tenant;
  }

  const byRetell = resolveTenantByRetellUsername(authUserHeader);
  if (byRetell.tenant) {
    return byRetell.tenant;
  }

  return enrichTenant({});
};

module.exports = {
  DEFAULTS,
  normalizePhone,
  resolveTenantByDid,
  resolveTenantByOwnDid,
  resolveTenantByRetellUsername,
  resolveTransferTenant,
  tenantDynamicVariables,
  buildSkySwitchTransferHeaders,
  isRetellAuthUser,
  getTenantDids
};
