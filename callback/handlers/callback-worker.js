const { config, redisHelper, logger, removeHeartbeat } = require('common');
const axios = require('axios');
const { workerData, parentPort } = require('worker_threads');

const callbackFunc = async () => {
  const ti = workerData.TaskInfo;
  const taskID = ti.TaskID;
  const requestID = workerData.RequestID;

  // 2. update taskinfo
  try {
    await redisHelper.updateTaskInfo(redisHelper.getTaskInfoKey(taskID), {
      Status: 'callback',
      InvokedRequestID: requestID,
    });
  } catch (err) {
    if (err.message && err.message.includes('update status failed')) {
      await removeHeartbeat(
        'callback',
        taskID,
        requestID,
        parentPort,
        null,
        'status-change-failed',
      );
    }

    return err;
  }

  // 3. callback result to user
  let succ = false;
  let lastErrorMessage = '';
  if (ti.Param && ti.Param.CallbackURL) {
    logger.log('need to callback to url', ti.Param.CallbackURL);
    const callbackURL = ti.Param.CallbackURL;

    let data = ti;
    data.Param = null;
    data.InvokedRequestID = '';
    if (data.TempData) {
      data.TempData = null;
    }

    const jsonStr = JSON.stringify(data, (key, value) => {
      if (value) {
        return value;
      }
    });

    data = JSON.parse(jsonStr);

    const retries = 5;
    for (let i = 0; i < retries; i++) {
      try {
        // callback url timeout is 2s
        const rsp = await axios.default.post(callbackURL, data, { timeout: 2000 });
        logger.log('callback succ, data:', data, 'rsp:', rsp.data);

        succ = true;
        break;
      } catch (err) {
        logger.log('[Error]callback failed, err:', err.code, err.message);
        lastErrorMessage = '' + err.code + '(' + err.message + ')';

        await new Promise((resolve) => {
          setTimeout(() => {
            resolve();
          }, 1000);
        });
      }
    }
  } else {
    succ = true;
  }

  // 4. update taskinfo
  try {
    const data = {
      Status: 'finished',
      InvokedRequestID: requestID,
    };
    if (!succ) {
      data.Result = ti.Result;
      if (!data.Result) {
        data.Result = {};
      }
      data.Result.ErrorCode = 'CallbackFailed';
      data.Result.ErrorMessage =
        'Callback failed even after all tries. last error message:' + lastErrorMessage;

      // log failed event
      logger.updateOnetimeIndex('ErrorCode', data.Result.ErrorCode);
      logger.updateOnetimeIndex('ErrorMessage', data.Result.ErrorMessage);
      logger.log('task failed event:', data.Result);
    }

    await redisHelper.updateTaskInfo(redisHelper.getTaskInfoKey(taskID), data);
  } catch (err) {
    if (err.message && err.message.includes('update status failed')) {
      await removeHeartbeat(
        'callback',
        taskID,
        requestID,
        parentPort,
        null,
        'status-change-failed',
      );
    }

    return err;
  }

  // 5. clear heartbeat
  await removeHeartbeat('callback', taskID, requestID, parentPort, null, 'status-change');
};

async function worker() {
  logger.updatePermanentIndex('TaskID', workerData.TaskInfo.TaskID);
  logger.updatePermanentIndex('Version', config.version);
  logger.log('upload worker begin with workerData', workerData);
  await callbackFunc();
  redisHelper.close();
}
worker();

process.on('unhandledRejection', (e) => {
  throw e;
});
