const { workerData, parentPort } = require('worker_threads');
const redisHelper = require('./redis');
const logger = require('./log');

/**
 * 将 Lock 的获取和更新放入 Worker 中
 * 避免主线程因为同步 I/O 或 CPU 密集型任务阻塞宏时间队列
 * 导致错过 Lock 更新
 */
let lock = null;
async function workerFunc() {
  const lockTTL = 10000;
  try {
    lock = await redisHelper.lock(workerData.key, lockTTL);
    parentPort.postMessage('success');
    logger.log('get lock succ, expiration %d, now %d', lock.expiration, Date.now());
    // 释放锁
    parentPort.on('message', async (action) => {
      if (action === 'unlock') {
        logger.log(`unlock ${workerData.key}`);
        try {
          await lock.unlock();
          lock = null;
        } catch (err) {
          logger.log(`unlock ${workerData.key} err `, err);
        }
        // 释放锁之后子进程退出
        process.exit(0);
      }
    });

    // active extend lock timer
    setInterval(async () => {
      try {
        const now = Date.now();
        if (lock && lock.expiration > now && lock.expiration - now < lockTTL / 2) {
          lock = await lock.extend(lockTTL);
          logger.log('extend lock succ, expiration %d, now %d', lock.expiration, Date.now());
        }
      } catch (err) {
        logger.log('extend lock failed, err', err);
      }
    }, 2000);
  } catch (err) {
    parentPort.postMessage('fail');
    logger.log('can not get lock, err: ', err, ', now exit');
    lock = null;
    return;
  }
}

workerFunc();
