const service = ({logger, makeService}) => {
  const svc = makeService();

  svc.on('session:new', (session) => {
    logger.info({session}, `new session: ${session.call_sid}`);

    session.on('close', (code, reason) => {
      logger.info({session, code, reason}, `session ${session.call_sid} closed`);
    });

    session.on('error', (err) => {
      logger.error({err}, `session ${session.call_sid} error`);
    });

    setTimeout(() => {
      // session.sip.headers['X-Retell-Call-Sid']
    }, 25000);

    let outboundFromRetell = false;

    // Standardized header parsing checks both casings safely
    const authUser = session.sip?.headers?.['X-Authenticated-User'] || session.sip?.headers?.['x-authenticated-user'];

    logger.info({ 
      direction: session.direction, 
      pstn_trunk: process.env.PSTN_TRUNK_NAME, 
      retell_username: process.env.RETELL_SIP_CLIENT_USERNAME, 
      auth_user: authUser, 
      to: session.to, 
      from: session.from 
    }, 'Retell routing debug');

    if (session.direction === 'inbound' && process.env.PSTN_TRUNK_NAME && process.env.RETELL_SIP_CLIENT_USERNAME && authUser) {
      const username = authUser.split('@')[0]; // Extract string safely
      if (username === process.env.RETELL_SIP_CLIENT_USERNAME) {
        outboundFromRetell = true;
      }
    }

    if (outboundFromRetell) {
      session.dial({
        target: [
          {
            type: 'phone',
            number: session.to,
            trunk: process.env.PSTN_TRUNK_NAME
          }
        ]
      });
    } else {
      session.dial({
        target: [
          {
            type: 'phone',
            number: session.to,
            trunk: process.env.RETELL_TRUNK_NAME
          }
        ]
      });
    }
  });
};

module.exports = service;
