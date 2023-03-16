const dateFormat = require('dateformat');
const { scf, config, redisHelper, logger } = require('common');

function replaceTaskTimeToStr(task) {
  if (task.CreateTime) {
    task.CreateTime = dateFormat(task.CreateTime * 1000, 'yyyy-mm-dd HH:MM:ss');
  }
  if (task.StartTime) {
    task.StartTime = dateFormat(task.StartTime * 1000, 'yyyy-mm-dd HH:MM:ss');
  }
  if (task.CancelTime) {
    task.CancelTime = dateFormat(task.CancelTime * 1000, 'yyyy-mm-dd HH:MM:ss');
  }
  if (task.StopTime) {
    task.StopTime = dateFormat(task.StopTime * 1000, 'yyyy-mm-dd HH:MM:ss');
  }
  if (task.FinishTime) {
    task.FinishTime = dateFormat(task.FinishTime * 1000, 'yyyy-mm-dd HH:MM:ss');
  }

  return task;
}

function isEmptyStr(str) {
  return !!(!str || str === 'null' || str === 'undefined' || str.match(/^[\s]*$/));
}

/**
 * @description: 开始录制
 * @param {*} data 开始录制请求参数
 * example:
 * {
 *      "RecordURL": "http://xxx",
 *      "CallbackURL": "http://xxx",
 *      "Width": 1280,
 *      "Height": 720
 * }
 * @return {*}
 */
async function start(data, taskID, appId) {
  logger.updateOnetimeIndex('Total', 1);
  logger.log('[Report]task event, total');

  // 0. check params
  if (!data || !data['RecordURL']) {
    logger.log(`[Error]RecordURL is missing`);

    return {
      ErrorCode: 'InvalidParam',
      ErrorMessage: 'RecordURL is missing',
    };
  }

  if (data['Width'] && (data['Width'] < 0 || data['Width'] > config.maxWidth)) {
    logger.log('[Error]invalid width');

    return {
      ErrorCode: 'InvalidParam',
      ErrorMessage: `Width must in range [1, ${config.maxWidth}]`,
    };
  }

  if (data['Height'] && (data['Height'] < 0 || data['Height'] > config.maxHeight)) {
    logger.log('[Error]invalid height');

    return {
      ErrorCode: 'InvalidParam',
      ErrorMessage: `Height must in range [1, ${config.maxHeight}]`,
    };
  }

  if (
    (data['MaxDurationLimit'] && data['MaxDurationLimit'] < 0) ||
    data['MaxDurationLimit'] > config.maxRecordDurationLimit
  ) {
    logger.log('[Error]invalid MaxDurationLimit');

    return {
      ErrorCode: 'InvalidParam',
      ErrorMessage: `MaxDurationLimit must in range [0, ${config.maxRecordDurationLimit}]`,
    };
  }

  if (data['Output'] && data['Output']['Video']) {
    const outputVideoInfo = data['Output']['Video'];

    if (!outputVideoInfo['Muxer']) {
      return {
        ErrorCode: 'InvalidParam',
        ErrorMessage: `Muxer must set in OutputVideo`,
      };
    }

    if (!(outputVideoInfo['Muxer'] in config.allowVideoFormat)) {
      return {
        ErrorCode: 'InvalidParam',
        ErrorMessage: `OutputVideoFormat must be one of ${config.allowVideoFormat}`,
      };
    }

    if (outputVideoInfo['Muxer'] === 'hls') {
      if (outputVideoInfo['EncryptKey'] && !outputVideoInfo['AuthUrl']) {
        return {
          ErrorCode: 'InvalidParam',
          ErrorMessage: `The AuthUrl must be set with EncryptKey`,
        };
      }
    }
  }

  // Vod参数校验
  if (data['Output'] && data['Output']['Vod']) {
	const vodConfig = data['Output']['Vod'];

	if (vodConfig['MediaInfo']) {
	  const vodMediaInfo = vodConfig['MediaInfo'];
	  if (vodMediaInfo['MediaName'] && isEmptyStr(vodMediaInfo['MediaName'])) {
		return {
		  ErrorCode: 'InvalidParam',
		  ErrorMessage: `Vod.MediaInfo.MediaName is invalid, please check.`,
		};
	  }

	  if (vodMediaInfo['StorageRegion'] && isEmptyStr(vodMediaInfo['StorageRegion'])) {
		return {
		  ErrorCode: 'InvalidParam',
		  ErrorMessage: `Vod.MediaInfo.StorageRegion is invalid, please check.`,
		};
	  }

	  if (vodMediaInfo['ExpireTime'] && isEmptyStr(vodMediaInfo['ExpireTime'])) {
		return {
		  ErrorCode: 'InvalidParam',
		  ErrorMessage: `Vod.MediaInfo.ExpireTime is invalid, please check.`,
		};
	  }
	}

	if (vodConfig['ProcedureInfo']) {
	  const procedureInfo = vodConfig['ProcedureInfo'];
	  if (procedureInfo['Procedure'] && isEmptyStr(procedureInfo['Procedure'])) {
		return {
		  ErrorCode: 'InvalidParam',
		  ErrorMessage: `Vod.ProcedureInfo.Procedure is invalid, please check.`,
		};
	  }
	}
  }

  if (process.env.DOUBLE_RECORD === 'OPEN') {
	logger.log('invoking scf:WebRecord...');
	// let requestID = '';
	try {
	  // 加上appid前缀
	  const doubleTaskID = appId + '_' + taskID;
	  const res = await scf.web_record(data, doubleTaskID, 'Start');
	  logger.log('invoking scf:web_record rsp', res);

      // requestID = res['RequestId'];
    } catch (err) {
      logger.log('[Warn]web_record failed, err: ', err);
    }
  }

  // 1. create taskinfo
  const taskInfo = {
    TaskID: taskID,
    CreateTime: Math.round(new Date().getTime() / 1000),
    Param: data,
    Status: 'normal',
    RetryNum: 0,
  };
  logger.updatePermanentIndex('TaskID', taskID);

  logger.updateOnetimeIndex('Action', 'create');
  logger.log('[Report]task action event: create');

  logger.log('taskinfo:', taskInfo);

  // 2. save taskinfo to redis
  const taskInfoKey = redisHelper.getTaskInfoKey(taskID);
  try {
    let expireTime = 0;
    if (process.env.REDIS_TASK_EXPIRE) {
      expireTime = parseInt(process.env.REDIS_TASK_EXPIRE);
    }
    await redisHelper.setString(taskInfoKey, JSON.stringify(taskInfo), expireTime);
    logger.log('save taskinfo succ, ', taskInfoKey, '=>', JSON.stringify(taskInfo));
  } catch (err) {
    logger.log('[Error]save taskinfo failed, err: ', err);

    return {
      ErrorCode: 'InternalError',
      ErrorMessage: 'create task failed(' + err.message + ')',
    };
  }

  // 3. invoke scf:record
  logger.log('invoking scf:record...');
  let requestID = '';
  let res = {};
  try {
    if (config.startMethod === 'ASYNC'){
      res = await scf.asyncInvoke(
          config.scf.recordFunctionName,
          {
            TaskID: taskID,
          },
      );
      logger.log('async invoking scf:record rsp', res);
      requestID = res['RequestId'];
    }else{
      res = await scf.invoke(
          config.scf.recordFunctionName,
          {
            TaskID: taskID,
          },
      );
    }

    logger.log('sync invoking scf:record rsp', res);
    requestID = res['RequestId'];
  }catch (err) {
    logger.log('[Error] kk invoke record function failed, err: ', err);

    // remove taskinfo from redis
    await redisHelper.delete(taskInfoKey);

    return {
      ErrorCode: 'InternalError',
      ErrorMessage: 'start record failed(' + err + ')',
    };
  }

  // 4. update taskInfo
  if (requestID === '') {
    await redisHelper.delete(taskInfoKey);
    return {
      ErrorCode: 'InternalError',
      ErrorMessage: 'start record failed',
    };
  }
  try {
    await redisHelper.updateTaskInfo(taskInfoKey, {
      InvokedRequestID: requestID,
      Status: 'recording',
    });
  } catch (err) {
    await redisHelper.delete(taskInfoKey);

    return Promise.resolve({
      ErrorCode: 'InternalError',
      ErrorMessage: 'create task failed(' + err.message + ')',
    });
  }

  // 5. add first record heartbeat ts to zset
  const member = redisHelper.getHeartbeatMemberKey(taskID, requestID);
  const ts = new Date().getTime();
  try {
    await redisHelper.zadd(redisHelper.getHeartbeatKey(), ts, member);
    logger.log('add record heartbeat succ,', member, ts);
  } catch (err) {
    logger.log('[Error]add record heartbeat failed,', member, ts, err);

    // todo what to do with err
  }

  // 6. response to user
  const rsp = {
    TaskID: taskID,
  };

  logger.updateOnetimeIndex('Running', 1);
  logger.log('[Report]task count up');

  return rsp;
}

/**
 * @description: 停止录制
 * @param {*} data 停止录制请求参数
 * example:
 * {
 *      "TaskID": "6e0a6f09-27f2-4979-8c03-05edd08e15eb"
 * }
 * @return {*}
 */
async function stop(data, appId) {
  if (!data || !data['TaskID']) {
    return {
      ErrorCode: 'InvalidParam',
      ErrorMessage: 'TaskID missing.',
    };
  }

  const taskID = data['TaskID'];
  logger.updatePermanentIndex('TaskID', taskID);

  try {
    // 0. check if need to cancel
    const taskInfoKey = redisHelper.getTaskInfoKey(taskID);
    const taskJsonStr = await redisHelper.getString(taskInfoKey);
    const ti = JSON.parse(taskJsonStr);
    if (!(ti.Status == 'normal' || ti.Status == 'recording' || ti.Status == 'paused')) {
      logger.log('no need to cancel this task, task status', ti.Status);
      return {
        TaskID: taskID,
      };
    }

    if (process.env.DOUBLE_RECORD === 'OPEN') {
      logger.log('invoking scf:WebRecord Stop...');
      // let requestID = '';
      try {
        data['MaxDurationLimit'] = 0;
        data['RecordURL'] = '';
        // 清理TaskID
        if ('TaskID' in data) {
          delete data.TaskID;
        }
        // 加上appid前缀
        const doubleTaskID = appId + '_' + taskID;
        const res = await scf.web_record(data, doubleTaskID, "Stop");
        logger.log('invoking scf:web_record Stop rsp', res);

        // requestID = res['RequestId'];
      } catch (err) {
        logger.log('[Warn]web_record Stop failed, err: ', err);
      }
    }

    // 1. update taskinfo
    await redisHelper.updateTaskInfo(taskInfoKey, {
      Status: 'canceled',
      CancelTime: Math.round(new Date().getTime() / 1000),
    });

    // 2. send stop signal
    const stopSignalKey = redisHelper.getCtrlSignalKey(taskID);
    await redisHelper.rpush(stopSignalKey, redisHelper.CtrlSignalStop);
    logger.log('send stop signal succ,', stopSignalKey);
  } catch (err) {
    logger.log('[Error]send stop signal failed, taskID:', taskID, 'err:', err);

    if (err.message == 'key not found') {
      return {
        ErrorCode: 'InvalidParam',
        ErrorMessage: 'invalid task id, task not found',
      };
    }

    return {
      ErrorCode: 'InternalError',
      ErrorMessage: err.message,
    };
  }

  return {
    TaskID: taskID,
  };
}

/**
 * @description: 获取任务信息
 * @param {*} data 请求参数
 * example:
 * {
 *      "TaskID": "6e0a6f09-27f2-4979-8c03-05edd08e15eb"
 * }
 * @return {*}
 */
async function describe(data) {
  if (!data || !data['TaskID']) {
    logger.log(`[Error]TaskID is missing`);

    return {
      ErrorCode: 'InvalidParam',
      ErrorMessage: 'TaskID is missing',
    };
  }

  const taskID = data['TaskID'];
  logger.updatePermanentIndex('TaskID', taskID);

  try {
    const res = await redisHelper.getString(redisHelper.getTaskInfoKey(taskID));
    const ti = JSON.parse(res);
    ti.Param = null;
    ti.InvokedRequestID = '';

    const jsonStr = JSON.stringify(ti, (key, value) => {
      if (value) {
        return value;
      }
    });
    const rspData = JSON.parse(jsonStr);

    return rspData;
  } catch (err) {
    logger.log('[Error]get taskInfo failed,', err);

    if (err.message == 'key not found') {
      return {
        ErrorCode: 'InvalidParam',
        ErrorMessage: 'invalid task id, task not found',
      };
    }

    return {
      ErrorCode: 'InternalError',
      ErrorMessage: err.message,
    };
  }
}

async function pause(data, appId) {
  if (!data || !data['TaskID']) {
    logger.log(`[Error]TaskID is missing`);

    return {
      ErrorCode: 'InvalidParam',
      ErrorMessage: 'TaskID is missing',
    };
  }

  const taskID = data['TaskID'];
  logger.updatePermanentIndex('TaskID', taskID);

  try {
    // 0. check if task can be paused
    const taskInfoKey = redisHelper.getTaskInfoKey(taskID);
    const taskJsonStr = await redisHelper.getString(taskInfoKey);
    const ti = JSON.parse(taskJsonStr);
    if (!(ti.Status == 'normal' || ti.Status == 'recording' || ti.Status == 'paused')) {
      logger.log('can not pause a task in status', ti.Status);
      return {
        ErrorCode: 'InvalidStatus',
        ErrorMessage: `can't pause a task in status ${ti.Status}`,
      };
    }

    if (ti.Status == 'paused') {
      return {
        TaskID: taskID,
      };
    }

    if (process.env.DOUBLE_RECORD === 'OPEN') {
      logger.log('invoking scf:WebRecord Pause...');
      // let requestID = '';
      try {
        data['MaxDurationLimit'] = 0;
        data['RecordURL'] = '';
        // 清理TaskID
        if ('TaskID' in data) {
          delete data.TaskID;
        }
        // 加上appid前缀
        const doubleTaskID = appId + '_' + taskID;
        const res = await scf.web_record(data, doubleTaskID, "Pause");
        logger.log('invoking scf:web_record Pause rsp', res);

        // requestID = res['RequestId'];
      } catch (err) {
        logger.log('[Warn]web_record Pause failed, err: ', err);
      }
    }

    // 1. update taskinfo
    await redisHelper.updateTaskInfo(taskInfoKey, {
      Status: 'paused',
    });

    // 2. send pause signal
    const ctrlSignalKey = redisHelper.getCtrlSignalKey(taskID);
    await redisHelper.rpush(ctrlSignalKey, redisHelper.CtrlSignalPause);
    logger.log('send pause signal succ, ', taskID);
  } catch (err) {
    logger.log('[Error]send pause signal failed, taskID:', taskID, 'err:', err);

    if (err.message == 'key not found') {
      return {
        ErrorCode: 'InvalidParam',
        ErrorMessage: 'invalid task id, task not found',
      };
    }

    return {
      ErrorCode: 'InternalError',
      ErrorMessage: err.message,
    };
  }

  return {
    TaskID: taskID,
  };
}

async function resume(data, appId) {
  if (!data || !data['TaskID']) {
    logger.log(`[Error]TaskID is missing`);

    return {
      ErrorCode: 'InvalidParam',
      ErrorMessage: 'TaskID is missing',
    };
  }

  const taskID = data['TaskID'];
  logger.updatePermanentIndex('TaskID', taskID);

  try {
    // 0. check if task can be paused
    const taskInfoKey = redisHelper.getTaskInfoKey(taskID);
    const taskJsonStr = await redisHelper.getString(taskInfoKey);
    const ti = JSON.parse(taskJsonStr);
    if (!(ti.Status == 'recording' || ti.Status == 'paused')) {
      logger.log('can not pause a task in status', ti.Status);
      return {
        ErrorCode: 'InvalidStatus',
        ErrorMessage: `can't resume a task in status ${ti.Status}`,
      };
    }

    if (process.env.DOUBLE_RECORD === 'OPEN') {
      logger.log('invoking scf:WebRecord Resume...');
      // let requestID = '';
      try {
        data['MaxDurationLimit'] = 0;
        data['RecordURL'] = '';
        // 清理TaskID
        if ('TaskID' in data) {
          delete data.TaskID;
        }
        // 加上appid前缀
        const doubleTaskID = appId + '_' + taskID;
        const res = await scf.web_record(data, doubleTaskID, "Resume");
        logger.log('invoking scf:web_record Resume rsp', res);

        // requestID = res['RequestId'];
      } catch (err) {
        logger.log('[Warn]web_record Resume failed, err: ', err);
      }
    }

    // 1. update taskinfo
    await redisHelper.updateTaskInfo(taskInfoKey, {
      Status: 'recording',
    });

    // 2. send resume signal
    const ctrlSignalKey = redisHelper.getCtrlSignalKey(taskID);
    await redisHelper.rpush(ctrlSignalKey, redisHelper.CtrlSignalResume);
    logger.log('send resume signal succ, ', taskID);
  } catch (err) {
    logger.log('[Error]send resume signal failed, taskID:', taskID, 'err:', err);

    if (err.message == 'key not found') {
      return {
        ErrorCode: 'InvalidParam',
        ErrorMessage: 'invalid task id, task not found',
      };
    }

    return {
      ErrorCode: 'InternalError',
      ErrorMessage: err.message,
    };
  }

  return {
    TaskID: taskID,
  };
}

async function refresh(data, appId) {
  if (!data || !data['TaskID']) {
    return {
      ErrorCode: 'InvalidParam',
      ErrorMessage: 'TaskID missing.',
    };
  }

  const taskID = data['TaskID'];
  logger.updatePermanentIndex('TaskID', taskID);

  try {
    // 0. check if need to cancel
    const taskInfoKey = redisHelper.getTaskInfoKey(taskID);
    const taskJsonStr = await redisHelper.getString(taskInfoKey);
    const ti = JSON.parse(taskJsonStr);
    if (!(ti.Status == 'recording' || ti.Status == 'paused')) {
      logger.log('no need to refresh this task, task status', ti.Status);
      return {
        TaskID: taskID,
      };
    }

    if (process.env.DOUBLE_RECORD === 'OPEN') {
      logger.log('invoking scf:WebRecord Refresh...');
      // let requestID = '';
      try {
        data['MaxDurationLimit'] = 0;
        data['RecordURL'] = '';
        // 清理TaskID
        if ('TaskID' in data) {
          delete data.TaskID;
        }
        // 加上appid前缀
        const doubleTaskID = appId + '_' + taskID;
        const res = await scf.web_record(data, doubleTaskID, "Refresh");
        logger.log('invoking scf:web_record Refresh rsp', res);

        // requestID = res['RequestId'];
      } catch (err) {
        logger.log('[Warn]web_record Refresh failed, err: ', err);
      }
    }

    // 2. send refresh signal
    const ctrlSignalKey = redisHelper.getCtrlSignalKey(taskID);
    await redisHelper.rpush(ctrlSignalKey, redisHelper.CtrlSignalRefresh);
    logger.log('send refresh signal succ,', ctrlSignalKey);
  } catch (err) {
    logger.log('[Error]send refresh signal failed, taskID:', taskID, 'err:', err);

    if (err.message == 'key not found') {
      return {
        ErrorCode: 'InvalidParam',
        ErrorMessage: 'invalid task id, task not found',
      };
    }

    return {
      ErrorCode: 'InternalError',
      ErrorMessage: err.message,
    };
  }

  return {
    TaskID: taskID,
  };
}

/**
 * @description: 获取任务详细信息
 * @param {*} data 请求参数
 * example:
 * {
 *      "TaskID": "6e0a6f09-27f2-4979-8c03-05edd08e15eb"
 * }
 * @return {*}
 */
async function describeDetail(data) {
  if (!data || !data['TaskID']) {
    logger.log(`[Error]TaskID is missing`);

    return {
      ErrorCode: 'InvalidParam',
      ErrorMessage: 'TaskID is missing',
    };
  }

  const taskID = data['TaskID'];
  logger.updatePermanentIndex('TaskID', taskID);

  try {
    const res = await redisHelper.getString(redisHelper.getTaskInfoKey(taskID));
    const ti = JSON.parse(res);

    // 任务信息中的时间替换成本地时间字符串，增加可读性
    return replaceTaskTimeToStr(ti);
  } catch (err) {
    logger.log('[Error]get taskInfo failed,', err);

    if (err.message == 'key not found') {
      return {
        ErrorCode: 'InvalidParam',
        ErrorMessage: 'invalid task id, task not found',
      };
    }

    return {
      ErrorCode: 'InternalError',
      ErrorMessage: err.message,
    };
  }
}

/**
 * @description: 获取任务列表
 * @param {*} data 任务过滤信息
 * example:
 * {
 *   "Status": "Running", // running, finished, all
 *   "StartTime": "2021-04-23 08:00:00",
 *   "EndTime": "2021-04-23 08:00:00"
 * }
 * @return {*}
 */
async function list(data) {
  if (!data || !data['Status']) {
    logger.log('[Error]Status is missing');

    return {
      ErrorCode: 'InvalidParam',
      ErrorMessage: 'Status is missing',
    };
  }

  if (data.Status != 'all' && data.Status != 'running' && data.Status != 'finished') {
    logger.log('[Error]invalid Status');
    return {
      ErrorCode: 'InvalidParam',
      ErrorMessage: 'Status need to be one of all, running, finished',
    };
  }

  if (data.StartTime && data.StartTime.length != '2021-04-23 08:00:00'.length) {
    logger.log('[Error]invalid StartTime');
    return {
      ErrorCode: 'InvalidParam',
      ErrorMessage: 'StartTime need to be a string with format: 2021-04-23 08:00:00',
    };
  }

  if (data.StartTime && data.EndTime.length != '2021-04-23 08:00:00'.length) {
    logger.log('[Error]invalid EndTime');
    return {
      ErrorCode: 'InvalidParam',
      ErrorMessage: 'EndTime need to be a string with format: 2021-04-23 08:00:00',
    };
  }

  try {
    const keys = await redisHelper.scanAll('tasks:*', 1000);
    if (!keys || keys.length == 0) {
      return {
        Total: 0,
        Tasks: [],
      };
    }

    const tasks = [];
    const promises = keys.map(async (key) => {
      try {
        const jsonStr = await redisHelper.getString(key);
        if (!jsonStr) {
          return;
        }

        let task = JSON.parse(jsonStr);
        if (data.Status == 'running' && task.Status == 'finished') {
          return;
        } else if (data.Status == 'finished' && task.Status != 'finished') {
          return;
        }

        if (data.StartTime) {
          const st = Math.round(Date.parse(data.StartTime) / 1000);
          if (task.CreateTime < st) {
            return;
          }
        }

        if (data.EndTime) {
          const et = Math.round(Date.parse(data.EndTime) / 1000);
          if (task.CreateTime > et) {
            return;
          }
        }

        // 任务信息中的时间替换成本地时间字符串，增加可读性
        task = replaceTaskTimeToStr(task);
        tasks.push(task);
      } catch (err) {
        logger.log('foreach err', err);
      }
    });

    await Promise.all(promises);

    // 按任务创建时间从大到小排序
    tasks.sort((a, b) => {
      if (a.CreateTime < b.CreateTime) {
        return 1;
      } else if (a.CreateTime > b.CreateTime) {
        return -1;
      }
      return 0;
    });

    return {
      Total: tasks.length,
      Tasks: tasks,
    };
  } catch (err) {
    logger.log('[Error]list tasks failed, err', err);
    return {
      ErrorCode: 'InternalError',
      ErrorMessage: err.message,
    };
  }
}

async function forcestop(data) {
  if (!data || !data['TaskID']) {
    return {
      ErrorCode: 'InvalidParam',
      ErrorMessage: 'TaskID missing.',
    };
  }

  const taskID = data['TaskID'];
  logger.updatePermanentIndex('TaskID', taskID);

  try {
    // 1. update taskinfo
    const taskInfoKey = redisHelper.getTaskInfoKey(taskID);

    const res = await redisHelper.getString(taskInfoKey);
    let ti = JSON.parse(res);
    let cancalTime = ti.CancelTime;
    if (!ti.CancelTime) {
      cancalTime = Math.round(new Date().getTime() / 1000);
    }

    ti = await redisHelper.updateTaskInfo(taskInfoKey, {
      Status: 'canceled',
      CancelTime: cancalTime,
    });

    // 2. send stop signal
    const stopSignalKey = redisHelper.getCtrlSignalKey(taskID);
    await redisHelper.rpush(stopSignalKey, redisHelper.CtrlSignalStop);
    logger.log('send stop signal succ,', stopSignalKey);

    // 3. terminate scf:record
    await new Promise((resolve) => {
      setTimeout(() => {
        resolve();
      }, 2000);
    });
    scf.terminate(config.scf.recordFunctionName, ti.InvokedRequestID);
  } catch (err) {
    logger.log('[Error]send stop signal failed, taskID:', taskID, 'err:', err);

    return {
      ErrorCode: 'InternalError',
      ErrorMessage: err.message,
    };
  }

  return {
    TaskID: taskID,
  };
}

const recorder = {};
recorder.start = async (data, taskID, appId) => {
  logger.log('start task with data', data);
  return await start(data, taskID, appId);
};

recorder.stop = async (data, appId) => {
  logger.updateOnetimeIndex('Action', 'stop');
  logger.log('[Report]task action event: stop');

  logger.log('stop task with data', data);
  return await stop(data, appId);
};

recorder.describe = async (data) => {
  logger.updateOnetimeIndex('Action', 'describe');
  logger.log('[Report]task action event: describe');

  logger.log('describe task with data', data);
  return await describe(data);
};

recorder.pause = async (data, appId) => {
  logger.updateOnetimeIndex('Action', 'pause');
  logger.log('[Report]task action event: pause');

  logger.log('pause task with data', data);
  return await pause(data, appId);
};

recorder.resume = async (data, appId) => {
  logger.updateOnetimeIndex('Action', 'resume');
  logger.log('[Report]task action event: resume');

  logger.log('resume task with data', data);
  return await resume(data, appId);
};

recorder.refresh = async (data, appId) => {
  logger.updateOnetimeIndex('Action', 'refresh');
  logger.log('[Report]task action event: refresh');

  logger.log('refresh task with data', data);
  return await refresh(data, appId);
};

recorder.describeDetail = async (data) => {
  logger.log('describeDetail task with data', data);
  return await describeDetail(data);
};

recorder.list = async (data) => {
  logger.log('list tasks with data', data);
  return await list(data);
};

recorder.forcestop = async (data) => {
  logger.updateOnetimeIndex('Action', 'forceStop');
  logger.log('[Report]task action event: forceStop');
  logger.log('force stop task with data', data);
  return await forcestop(data);
};

module.exports = recorder;
