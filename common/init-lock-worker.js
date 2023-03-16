const { Worker } = require('worker_threads');
const path = require('path');
const logger = require('./log');

async function initLockWorker(module, taskID) {
  // 加锁，防止当前操作被多个函数执行，
  // 如果加锁失败，表示可能存在其他函数在执行当前操作，此函数先退出
  const lockKey = `${module}lock:${taskID}`;
  const lockWorker = new Worker(path.join(__dirname, 'lock.js'), {
    workerData: {
      key: lockKey,
    },
  });
  // 重写 worker terminate 方法，当 worker 正常退出时，删除对应的锁
  lockWorker.terminate = () => {
    lockWorker.postMessage('unlock');
  };

  async function waitLock() {
    return new Promise((resolve, reject) => {
      lockWorker.on('message', (action) => {
        switch (action) {
          case 'success':
            resolve();
          case 'fail':
            reject('Fail to acquire lock');
        }
      });
    });
  }

  try {
    await waitLock();
    logger.log(`[${module}] get lock succ, now %d`, Date.now());
  } catch (err) {
    logger.log(`[${module}] waitLock can not get lock for, err `, err, ', now exit');
    // 如果拿不到锁，则退出，抛出异常
    throw err;
  }
  return lockWorker;
}

module.exports = initLockWorker;

process.on('unhandledRejection', (e) => {
  throw e;
});
