const redisHelper = require('./redis');
const logger = require('./log');

async function removeHeartbeat(
  module,
  taskID,
  requestID,
  heartbeatWorker,
  heartbeatIntervalObj,
  reason,
) {
  const heartbeatMember = redisHelper.getHeartbeatMemberKey(taskID, requestID);
  try {
    if (heartbeatWorker && heartbeatWorker.postMessage) {
      heartbeatWorker.postMessage('stop');
    }

    if (heartbeatIntervalObj) {
      clearInterval(heartbeatIntervalObj);
    }

    await redisHelper.zrem(redisHelper.getHeartbeatKey(), heartbeatMember);
    logger.log('remove %s heartbeat succ %s, reason %s', module, heartbeatMember, reason);
  } catch (err) {
    logger.log('[Error]remove %s heartbeat failed', module, heartbeatMember, err, reason);
    // todo what to do with err
  }
}

module.exports = removeHeartbeat;
