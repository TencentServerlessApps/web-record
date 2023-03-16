const { workerData, parentPort } = require('worker_threads');
const { redisHelper, logger, config } = require('common');

let intervalObj = null;
let autoStopCheckerObj = null;
const taskInfo = workerData.TaskInfo;
const requestID = workerData.RequestID;

function cleanup() {
  if (intervalObj) {
    clearInterval(intervalObj);
    intervalObj = null;
    logger.log('clear heartbeat interval object');
  }

  if (autoStopCheckerObj) {
    clearInterval(autoStopCheckerObj);
    autoStopCheckerObj = null;
    logger.log('clear auto stop checker');
  }

  redisHelper.close();
}

const workerFunc = async () => {
  logger.log('recording heartbeat workerFunc begin...');
  const taskID = taskInfo.TaskID;
  const heartbeatMember = redisHelper.getHeartbeatMemberKey(taskID, requestID);
  let isAutoStoped = false;
  intervalObj = setInterval(async () => {
    const ts = new Date().getTime();
    try {
      // add heartbeat
      await redisHelper.zadd(redisHelper.getHeartbeatKey(), ts, heartbeatMember);
      logger.log('add record heartbeat succ', heartbeatMember, ts);
    } catch (err) {
      logger.log('[Error]add record heartbeat failed', heartbeatMember, ts, err);
      if (err.message && err.message.includes('update status failed')) {
        cleanup();
      }
      // todo what to do with err
    }
  }, config.heartbeatInterval);
  let startTime = taskInfo['StartTime'];
  if (!taskInfo['StartTime']) {
    startTime = Math.round(new Date().getTime() / 1000);
  }
  autoStopCheckerObj = setInterval(async () => {
    // check if need to auto stop
    try {
      const ts = new Date().getTime();
      const maxLimit = taskInfo.Param.MaxDurationLimit || config.maxRecordDurationLimit;
      if (ts - startTime * 1000 >= maxLimit * 1000 && !isAutoStoped) {
        const stopSignalKey = redisHelper.getCtrlSignalKey(taskID);
        await redisHelper.rpush(stopSignalKey, redisHelper.CtrlSignalStop);

        logger.updateOnetimeIndex('Action', 'autoStop');
        logger.log(
          '[Report]task action event: autoStop',
          'maxlimit',
          maxLimit,
          'startTime',
          startTime,
          'now',
          ts / 1000,
        );

        // update task status to canceled
        const data = {
          Status: 'canceled',
          CancelTime: Math.round(new Date().getTime() / 1000),
        };
        await redisHelper.updateTaskInfo(redisHelper.getTaskInfoKey(taskID), data);
        isAutoStoped = true;

        logger.log('send stop signal succ(timeout),', stopSignalKey);
      }
    } catch (err) {
      if (err.message && err.message.includes('update status failed')) {
        cleanup();
      }
    }
  }, 1000);

  logger.log('recording control workerFunc exit');
};

parentPort.once('message', (msg) => {
  if (msg == 'stop') {
    cleanup();
  } else if (msg.StartTime) {
    taskInfo.StartTime = msg.StartTime;
  }
});

parentPort.on('close', () => {
  cleanup();
});

logger.updatePermanentIndex('TaskID', taskInfo.TaskID);
logger.updatePermanentIndex('Version', config.version);

workerFunc();
