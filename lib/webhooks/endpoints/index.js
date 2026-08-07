const router = require('express').Router();

router.use('/agent-events', require('./agent-events'));
router.use('/health', require('./health'));
router.use('/inbound-webhook', require('./inbound-webhook'));
router.use('/success', require('./success'));

module.exports = router;
