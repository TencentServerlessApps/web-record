const { Worker } = require('worker_threads');
const {
  scf,
  config,
  redisHelper,
  logger,
  invokeCallback,
  initLockWorker,
  removeHeartbeat,
} = require('common');

let lockWorker = null;
let extendLockIntervalObj = null;
let lock = null;
async function cleanup() {
  try {
    logger.log('cleanup...');

    if (lockWorker) {
      lockWorker.terminate();
      lockWorker = null;
      logger.log('terminate lockWorker');
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

async function restart(funcName, data, status, taskInfo) {
  logger.log('restart with data:', data, funcName, status);

  if (!data || !data['TaskID']) {
    logger.log('[Error]TaskID missing');
    return;
  }

  logger.updateOnetimeIndex('Action', `reinvoke-${status}`);
  logger.log('[Report]task action event: ' + `reinvoke-${status}`);

  try {
    const taskID = data['TaskID'];
    const oldInvokedRequestID = data['InvokedRequestID'];

    // 1. reinvoke scf:record
    let curRequestID = taskInfo['InvokedRequestID'];
    // 向前兼容
    let retryNum = 0;
    if ('RetryNum' in taskInfo) {
      retryNum = taskInfo['RetryNum'];
    }

    if (oldInvokedRequestID == curRequestID) {
      const res = await scf.reinvoke(funcName, { TaskID: taskID }, oldInvokedRequestID);
      curRequestID = res['RequestId'];
    } else {
      try {
        await scf.terminate(funcName, oldInvokedRequestID);
      } catch (err) {
        throw err;
      }
    }

    // 2. update taskinfo
    await redisHelper.updateTaskInfo(redisHelper.getTaskInfoKey(taskID), {
      InvokedRequestID: curRequestID,
      Status: status,
      RetryNum: retryNum + 1,
    });

    // 3. remove old heartbeat
    await removeHeartbeat(funcName, taskID, oldInvokedRequestID, null, null, 'restart');

    // 4. add new heartbeat
    const newMember = redisHelper.getHeartbeatMemberKey(taskID, curRequestID);
    const ts = new Date().getTime();
    try {
      await redisHelper.zadd(redisHelper.getHeartbeatKey(), ts, newMember);
      logger.log('add heartbeat succ,', newMember, funcName, ts);
    } catch (err) {
      logger.log('[Error]add heartbeat failed,', newMember, funcName, ts, err);

      // todo what to do with err
    }
  } catch (err) {
    logger.log('[Error]restart scf failed,', funcName, 'err', err);
    return;
  }
}

async function reinvoke(member) {
  const strs = member.split(':');
  if (strs.length != 2) {
    logger.log('[Error]invalid member key', member);
    return;
  }
  const taskID = strs[0];
  const requestID = strs[1];

  logger.updatePermanentIndex('TaskID', taskID);
  logger.log('reinvoke with member', member);

  let ti = {};
  try {
    const tiStr = await redisHelper.getString(redisHelper.getTaskInfoKey(taskID));
    ti = JSON.parse(tiStr);
  } catch (err) {
    logger.log('[Error]get taskinfo failed, err', err);

    if (err.message == 'key not found') {
      await redisHelper.zrem(redisHelper.getHeartbeatKey(), member);
      return;
    }

    return;
    // todo what to do with err
  }

  // 如果任务状态已经是finished, 直接清掉redis中的心跳记录, 避免任务一直滞留在redis中重复触发重试
  if (ti['Status'] == 'finished') {
    logger.log('task has already been finished, ', taskID);
    await redisHelper.zrem(redisHelper.getHeartbeatKey(), member);
    return;
  }

  // 判断是否超过最大重试次数，直接进入callback
  if ('RetryNum' in ti) {
    if (ti['RetryNum'] > config.maxRetryNum) {
      const data = {
        Status: 'callback',
        Result: {
          ErrorCode: 'InternalErr',
          ErrorMessage: 'this task already exceed maxRetryNum',
        },
      };
      logger.log('[Error]this task already exceed maxRetryNum:', config.maxRetryNum);
      await invokeCallback(ti['Status'], taskID, requestID, data);
      return;
    }
  }

  // 2. reinvoke scf according to task status
  const data = {
    TaskID: taskID,
    InvokedRequestID: requestID,
  };
  const status = ti['Status'];
  switch (status) {
    case 'normal':
    case 'recording':
      await restart(config.scf.recordFunctionName, data, 'recording', ti);
      break;
    case 'paused':
      await restart(config.scf.recordFunctionName, data, 'paused', ti);
      break;
    case 'canceled':
    case 'transcode':
      await restart(config.scf.transcodeFunctionName, data, 'transcode', ti);
      break;
    case 'upload':
      await restart(config.scf.uploadFunctionName, data, 'upload', ti);
      break;
    case 'callback':
      await restart(config.scf.callbackFunctionName, data, 'callback', ti);
      break;
    case 'finished':
      logger.log('task has already been finished, ', taskID);
      await redisHelper.zrem(redisHelper.getHeartbeatKey(), member);
      break;
    default:
      logger.log('[Warning]invalid status:', status);
      await redisHelper.zrem(redisHelper.getHeartbeatKey(), member);
  }
}

const diagnose = {};
diagnose.run = async (timeout) => {
  // 给disgnose加锁，防止当前操作被多个diagnose执行
  // 如果加锁失败，表示可能存在其他diagnose在执行当前操作，此函数先退出
  try {
    lockWorker = await initLockWorker('diagnose', 0);
  } catch (err) {
    logger.log('get diagnose lock failed');
    await cleanup();
    return;
  }
  try {
    let startTime = Date.now();
    // 1. scan heartbeat zset
    const members = await redisHelper.zrange(
      redisHelper.getHeartbeatKey(),
      0,
      new Date().getTime() - 2 * config.heartbeatInterval - 1000,
    );
    if (!members || members.length == 0) {
      logger.log('no timeout member found');
      redisHelper.close();
      await cleanup();
      return;
    }
    logger.log('timeout member found. count', members.length, members);

    for (let i = 0; i < members.length; i++) {
      await reinvoke(members[i]);
      // 运行超时前提前退出，30s buffer cleanup
      if (Date.now() - startTime >= timeout - 30000) {
        logger.log('function timeout soon, ', timeout);
        break;
      }
      const rnd = Math.floor(Math.random() * 50);
      await new Promise((resolve) => {
        setTimeout(() => {
          resolve();
        }, rnd);
      });
    }
  } catch (err) {
    logger.log('[Error]diagnose failed,', err);
  }
  await cleanup();
};

process.on('uncaughtException', async (e) => {
  logger.log(`process error: `, e);

  try {
    await cleanup();
  } catch (err) {
    logger.log(`clean up error: ${err}`);
  }

  process.exit();
});

module.exports = diagnose;
