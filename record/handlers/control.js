const { workerData, parentPort } = require('worker_threads');
const { redisHelper, logger, config } = require('common');

let running = true;
const workerFunc = async (taskID) => {
  logger.log('recording control workerFunc begin...');
  const key = redisHelper.getCtrlSignalKey(taskID);
  const cli = await redisHelper.createClient('blpop');
  while (running) {
    const action = await redisHelper.blpop(cli, key, 2);
    if (action == redisHelper.CtrlSignalPause) {
      logger.log('receive pause signal in worker');
      parentPort.postMessage('pause');
    } else if (action == redisHelper.CtrlSignalResume) {
      logger.log('receive resume signal in worker');
      parentPort.postMessage('resume');
    } else if (action == redisHelper.CtrlSignalStop) {
      logger.log('receive stop signal in worker');
      parentPort.postMessage('stop');
    } else if (action == redisHelper.CtrlSignalRefresh) {
      logger.log('receive refresh signal in worker');
      parentPort.postMessage('refresh');
    }
  }

  redisHelper.close(cli);
  logger.log('recording control workerFunc exit');
};

parentPort.on('close', () => {
  running = false;
});

logger.updatePermanentIndex('TaskID', workerData.TaskID);
logger.updatePermanentIndex('Version', config.version);
workerFunc(workerData.TaskID);
