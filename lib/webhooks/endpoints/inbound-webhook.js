const router = require('express').Router();
const {resolveTenantByDid, tenantDynamicVariables} = require('../../tenant-config');

router.post('/', (req, res) => {
  const {logger} = req.app.locals;
  const payload = req.body;
  logger.info({payload}, 'inbound webhook');

  const calledDid = payload.to_number
    || payload.call_inbound?.to_number
    || payload.to
    || payload.call_inbound?.to;

  const {tenant, error} = resolveTenantByDid(calledDid);
  if (error) {
    logger.warn({calledDid, error}, 'Tenant lookup failed for inbound webhook');
    return res.status(400).json({error});
  }

  const dynamicVariables = tenantDynamicVariables(tenant);
  logger.info({calledDid, dynamicVariables}, 'Resolved tenant for inbound call');

  res.json({
    call_inbound: {
      dynamic_variables: dynamicVariables,
      metadata: {
        customer_id: tenant.customer_id,
        location_id: tenant.location_id,
        called_did: tenant.called_did
      }
    }
  });
});

module.exports = router;
