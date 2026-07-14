const useDialSipEndpointMethod = Number(process.env.USE_DIAL_SIP_ENDPOINT_METHOD) || 0;
const assert = require('assert');
const {registerCall, getE164, validateCountryCode} = require('../../lib/utils');
const DEFAULT_COUNTRY = process.env.DEFAULT_COUNTRY || false;
const OVERRIDE_FROM_USER = process.env.OVERRIDE_FROM_USER || false;

assert.ok(useDialSipEndpointMethod === 1 || process.env.RETELL_TRUNK_NAME,
  'RETELL_TRUNK_NAME env required when using elastic sip trunking method; it must contain the name of the jambonz BYOC trunk that connects to retell');

const service = ({logger, makeService}) => {
  const svc = makeService({path: '/retell'});
  const sessions = {};

  if (DEFAULT_COUNTRY){
    validateCountryCode(DEFAULT_COUNTRY);
  }

  svc.on('session:new', async(session) => {
    sessions[session.call_sid] = session;
    session.locals = {logger: logger.child({call_sid: session.call_sid})};
    let {from, to, direction, call_sid} = session;
    
    logger.info({session}, `new incoming call: ${session.call_sid}`);

    /* Send ping to keep alive websocket as some platforms timeout */
    session.locals.keepAlive = setInterval(() => {
      session.ws.ping();
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
        logger.info(`call ${session.call_sid} is coming from Retell`);
        outboundFromRetell = true;
      }
    }

    session
      .on('/refer', onRefer.bind(null, session))
      .on('close', onClose.bind(null, sessions, session))
      .on('error', onError.bind(null, session))
      .on('/dialAction', onDialAction.bind(null, session))
      .on('/referComplete', onReferComplete.bind(null, sessions, session));

    try {
      let target;
      let headers = {};

      if (outboundFromRetell) {
        /* call is coming from Retell, so we will forward it to the original dialed number over SkySwitch */
        target = [
          {
            type: 'phone',
            number: session.to,
            trunk: process.env.PSTN_TRUNK_NAME
          }
        ];
        if (OVERRIDE_FROM_USER) {
          from = OVERRIDE_FROM_USER;
        }
      } else if (useDialSipEndpointMethod) {
        const retell_call_id = await registerCall(logger, {
          agent_id: process.env.RETELL_AGENT_ID,
          from,
          to,
          direction,
          call_sid,
          retell_llm_dynamic_variables: {
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
      } else {
        const dest = DEFAULT_COUNTRY ? await getE164(logger, to, DEFAULT_COUNTRY) : to;
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
      session.locals.logger.info({err}, `Error responding to incoming call: ${session.call_sid}`);
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

const onClose = (sessions, session, code, reason) => {
  delete sessions[session.call_sid];
  const {logger} = session.locals;
  clearInterval(session.locals.keepAlive);
  logger.info({session, code, reason}, `session ${session.call_sid} closed`);
};

const onError = (session, err) => {
  const {logger} = session.locals;
  logger.info({err}, `session ${session.call_sid} received error`);
};

const onDialAction = (session, evt) => {
  const {logger} = session.locals;
  if (evt.dial_call_status !== 'completed') {
    logger.info(`outbound dial failed with ${evt.dial_call_status}, ${evt.dial_sip_status}`);
    session
      .sip_decline({status: evt.dial_sip_status})
      .reply();
  }
};

const onReferComplete = (sessions, session, evt) => {
  const {logger} = session.locals;
  logger.info({evt}, 'referComplete');
  if (session.parent_call_sid) {
    logger.info(`Sending hangup to parent session ${session.parent_call_sid}`);
    const parentSession = sessions[session.parent_call_sid];
    if (parentSession) {
      parentSession.hangup().send();
    }
  } else {
    logger.info('No parent session');
  }
};

module.exports = service;
