const redisHelper = require('./redis');
const logger = require('./log');
const scf = require('./scf');
const config = require('./config');

async function invokeCallback(module, taskID, oRequestID, data) {
  // 0 update taskinfo
  if (data) {
    try {
      await redisHelper.updateTaskInfo(redisHelper.getTaskInfoKey(taskID), data);
    } catch (err) {
      return err;
    }
  }

  // 1 invoke scf:callback
  logger.log('invoking scf:callback from %s ...', module);
  let requestID = '';
  try {
    const res = await scf.invoke(config.scf.callbackFunctionName, { TaskID: taskID });
    logger.log(res);

    requestID = res['RequestId'];
  } catch (err) {
    logger.log('[Error]invoke callback function failed, err: ', err);

    return;
  }

  // 2 update taskinfo
  try {
    await redisHelper.updateTaskInfo(redisHelper.getTaskInfoKey(taskID), {
      InvokedRequestID: requestID,
      Status: 'callback',
    });
  } catch (err) {
    return err;
  }

  // 3 add first callback heartbeat
  const member = redisHelper.getHeartbeatMemberKey(taskID, requestID);
  const ts = new Date().getTime();
  try {
    await redisHelper.zadd(redisHelper.getHeartbeatKey(), ts, member);
    logger.log('add callback heartbeat succ,', member, ts);
  } catch (err) {
    logger.log('[Error]add callback heartbeat failed,', member, ts, err);

    // todo what to do with err
  }
}

module.exports = invokeCallback;
