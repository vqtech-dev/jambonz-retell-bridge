module.exports = {
  apps : [{
    name: 'retellai-shim',
    script: 'app.js',
    instance_var: 'INSTANCE_ID',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      LOGLEVEL: 'info',
      HTTP_PORT: 3000,
      JAMBONZ_ACCOUNT_SID: 'your_account_sid',
      JAMBONZ_API_KEY: 'your_api_key',
      JAMBONZ_REST_API_BASE_URL: 'https://jambonz.cloud/api/v1', // or replace with your own self-hosted jambonz URL
      RETELL_API_KEY: 'your_retell_api_key',
      RETELL_AGENT_ID: 'your_retell_agent_id',
      RETELL_TRUNK_NAME: 'Retell-Trunk',
      SKYSWITCH_CARRIER_NAME: 'SkySwitch-JambonzRetell',
      SKYSWITCH_SIP_REALM: 'visionquest.22393.service',
      SKYSWITCH_REGISTER_USERNAME: 'KickCalltest',
      SKYSWITCH_EXTENSION_DOMAIN: 'visionquest.22393.service',
      OWN_DIDS: '+12297406150',
      TENANT_CONFIG: '{"+1DEMO_DID_HERE":{"customer_id":"demo-open-dental","location_id":"353034","skyswitch_outbound_carrier":"SkySwitch-JambonzRetell","skyswitch_sip_realm":"visionquest.22393.service","skyswitch_register_username":"JambonzRetell","retell_trunk_name":"Retell-73hR8GtTmfVmdn7kUbc1Fz"},"+1WOODS_DID_HERE":{"customer_id":"woods-medical","location_id":"355231","skyswitch_outbound_carrier":"SkySwitch-JambonzRetell-Woods","skyswitch_sip_realm":"woods.SKYSWITCH_DOMAIN_HERE.service","skyswitch_register_username":"JambonzRetellWoods"}}'
    }
  }]
};
