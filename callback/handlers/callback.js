const { Worker } = require('worker_threads');
const { config, redisHelper, logger, initLockWorker } = require('common');
const path = require('path');

let extendLockIntervalObj = null;
let lock = null;

let heartbeatIntervalObj = null;
let worker = null;
let lockWorker = null;

async function cleanup() {
  logger.log('cleanup...');

  if (lockWorker) {
    lockWorker.terminate();
    lockWorker = null;
    logger.log('terminate lockWorker');
  }
  if (heartbeatIntervalObj) {
    clearInterval(heartbeatIntervalObj);
    heartbeatIntervalObj = null;
    logger.log('clear heartbeat interval object');
  }

  if (extendLockIntervalObj) {
    clearInterval(extendLockIntervalObj);
    extendLockIntervalObj = null;
    logger.log('clear extend lock interval');
  }

  if (lock && lock.unlock) {
    logger.log('unlock callback lock');
    try {
      await lock.unlock();
      lock = null;
    } catch (err) {
      logger.log('unlock err', err);
    }
  }

  redisHelper.close();
}

const callback = {};

async function callbackFunc(event, requestID) {
  return new Promise(async (resolve, reject) => {
    const taskID = event['TaskID'];
    logger.log('invoke callback with event', event);

    logger.updateOnetimeIndex('Action', 'callback');
    logger.log('[Report]task action event: callback');

    let ti = {};
    try {
      const res = await redisHelper.getString(redisHelper.getTaskInfoKey(taskID));
      ti = JSON.parse(res);

      if (ti.Result && ti.Result.ErrorCode) {
        // log failed event
        logger.updateOnetimeIndex('ErrorCode', ti.Result.ErrorCode);
        logger.updateOnetimeIndex('ErrorMessage', ti.Result.ErrorMessage);
        logger.log('task failed event:', ti.Result);
      }
    } catch (err) {
      logger.log('[Error]get taskinfo failed, err', err);
      reject(err);
      return;
    }

    if (!ti) {
      logger.log('[Error]get taskinfo failed, ti is null');
      reject('task info not found');
      return;
    }

    if (ti['Status'] == 'callback') {
      // 1. active heartbeat
      const heartbeatMember = redisHelper.getHeartbeatMemberKey(taskID, requestID);
      heartbeatIntervalObj = setInterval(async () => {
        const ts = new Date().getTime();
        try {
          await redisHelper.zadd(redisHelper.getHeartbeatKey(), ts, heartbeatMember);
          logger.log('add callback heartbeat succ', heartbeatMember, ts);
        } catch (err) {
          logger.log('[Error]add callback heartbeat failed', heartbeatMember, ts, err);

          // todo what to do with err
        }
      }, config.heartbeatInterval);

      // 加锁，防止当前操作被多个函数执行，
      // 如果加锁失败，表示可能存在其他函数在执行当前操作，此函数先退出
      try {
        lockWorker = await initLockWorker('callback', taskID);
      } catch (err) {
        reject(err);
        return;
      }

      // 2. start a worker to do the callback things
      worker = new Worker(path.join(__dirname, 'callback-worker.js'), {
        workerData: {
          TaskInfo: ti,
          RequestID: requestID,
        },
      });
      worker
        .once('online', () => {
          logger.log('callback worker ready');
        })
        .once('error', (err) => {
          logger.log('[Error]callback worker err', err);
          reject(err);
        })
        .once('exit', (code) => {
          logger.log('callback worker exit code', code);
          resolve();
        })
        .on('message', (msg) => {
          if (msg == 'stop') {
            if (heartbeatIntervalObj) {
              logger.log('clear callback heartbeat interval');
              clearInterval(heartbeatIntervalObj);
              heartbeatIntervalObj = null;
            }
          }
        });
    } else {
      logger.log(`invalid status, cant perform callback in state ${ti['Status']}`);
      resolve();
    }
  });
}

callback.run = async (event, requestID) => {
  try {
    await callbackFunc(event, requestID);
  } catch (err) {
    logger.log('[Error]run exception, err', err);
  }

  await cleanup();
  return 'OK';
};

module.exports = callback;
