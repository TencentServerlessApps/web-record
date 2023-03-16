const { Worker } = require('worker_threads');
const path = require('path');
const { config, redisHelper, logger, initLockWorker, removeHeartbeat } = require('common');

let extendLockIntervalObj = null;
let lock = null;
let heartbeatIntervalObj = null;
let worker = null;
let lockWorker = null;

async function cleanup() {
  try {
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
      logger.log('unlock upload lock');
      try {
        await lock.unlock();
        lock = null;
      } catch (err) {
        logger.log('unlock err', err);
      }
    }

    redisHelper.close();
  } catch (err) {
    logger.log(err);
    process.exit();
  }
}

const uploader = {};
uploader.run = async (event, requestID) => {
  let res = 'OK';
  const taskID = event['TaskID'];
  try {
    const tiStr = await redisHelper.getString(redisHelper.getTaskInfoKey(taskID));
    const ti = JSON.parse(tiStr);
    switch (ti['Status']) {
      case 'upload':
        await uploader.upload(taskID, requestID);
        break;
      default:
        logger.log(`invalid status, cant perform upload in state ${ti['Status']}`);
        res = 'invalid status';
        break;
    }
  } catch (err) {
    logger.log('[Error]run exception', err);
    res = 'run exception' + err.message;
  }

  await cleanup();

  return res;
};

uploader.upload = async (taskID, requestID) => {
  return new Promise(async (resolve, reject) => {
    logger.log('begin upload with taskID', taskID, 'requestID', requestID);

    // 1. active heartbeat
    const heartbeatMember = redisHelper.getHeartbeatMemberKey(taskID, requestID);
    heartbeatIntervalObj = setInterval(async () => {
      const ts = new Date().getTime();
      try {
        await redisHelper.zadd(redisHelper.getHeartbeatKey(), ts, heartbeatMember);
        logger.log('add upload heartbeat succ', heartbeatMember, ts);
      } catch (err) {
        logger.log('[Error]add upload heartbeat failed', heartbeatMember, ts, err);

        // todo what to do with err
      }
    }, config.heartbeatInterval);

    // 加锁，防止当前操作被多个函数执行，
    // 如果加锁失败，表示可能存在其他函数在执行当前操作，此函数先退出
    try {
      lockWorker = await initLockWorker('upload', taskID);
    } catch (err) {
      // remove heartbeat
      await removeHeartbeat(
        'upload',
        taskID,
        requestID,
        null,
        heartbeatIntervalObj,
        'get-lock-failed',
      );

      reject(err);
      return;
    }

    // 2. start a worker to do the upload things
    worker = new Worker(path.join(__dirname, 'transcode.js'), {
      workerData: {
        TaskID: taskID,
        RequestID: requestID,
      },
    });
    worker
      .once('online', () => {
        logger.log('upload worker ready');
      })
      .once('error', (err) => {
        logger.log('[Error]upload worker err', err);
        reject(err);
      })
      .once('exit', (code) => {
        logger.log('upload worker exit code', code);
        resolve();
      })
      .on('message', (msg) => {
        if (msg === 'stop') {
          if (heartbeatIntervalObj) {
            logger.log('clear upload heartbeat interval');
            clearInterval(heartbeatIntervalObj);
            heartbeatIntervalObj = null;
          }
        }
      });
  });
};

module.exports = uploader;
