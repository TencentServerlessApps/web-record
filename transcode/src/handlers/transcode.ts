import { Worker } from 'worker_threads';
import { TaskInfo, TranscodeEvent } from '../interface';
import path from 'path';
const { config, redisHelper, logger, initLockWorker, removeHeartbeat } = require('common');

let lockWorker: Worker | null = null;

let heartbeatIntervalObj: NodeJS.Timeout | null = null;
let transcodeWorker: Worker | null = null;

const startWorker = (file: string, wkOpts: WorkerOptions & { eval?: boolean, workerData?: any }) => {
  wkOpts.eval = true;
  if (!wkOpts.workerData) {
    wkOpts.workerData = {};
  }
  wkOpts.workerData.__filename = file;
  return new Worker(`
          const wk = require('worker_threads');
          let file = wk.workerData.__filename;
          delete wk.workerData.__filename;
          require(file);
      `,
      wkOpts
  );
}


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

  if (transcodeWorker) {
    transcodeWorker.terminate();
    transcodeWorker = null;
    logger.log('terminate transcodeWorker');
  }

  redisHelper.close();
}



export async function runTranscode(event: TranscodeEvent, requestID: string) {
  let res = 'OK';
  const taskID = event['TaskID'];
  try {
    if (event['Force']) {
      // 强制转码(后门参数，一般用于转码失败后，手动重启转码进程)
      logger.updateOnetimeIndex('Action', 'transcode');
      logger.log('[Report]task action event: transcode');
      await transcode(event, requestID);
    } else {
      const tiStr = await redisHelper.getString(redisHelper.getTaskInfoKey(taskID));
      const ti = JSON.parse(tiStr);
      switch (ti['Status']) {
        case 'canceled':
        case 'transcode':
          logger.updateOnetimeIndex('Action', 'transcode');
          logger.log('[Report]task action event: transcode');
          await transcode(event, requestID);
          break;
        default:
          logger.log(`invalid status, cant perform transcode in state ${ti['Status']}`);
          res = 'invalid status';
          break;
      }
    }
  } catch (err) {
    logger.log('[Error]run exception', err);
    res = 'run exception' + err.message;
    // todo what to do with err
  }

  await cleanup();

  return res;
};

const transcode = async ({ TaskID }: { TaskID: string }, requestID: string) => {
  return new Promise<void>(async (resolve, reject) => {
    logger.log('begin transcode with taskID', TaskID, 'requestID', requestID);
    // 1. active heartbeat
    const heartbeatMember = redisHelper.getHeartbeatMemberKey(TaskID, requestID);
    const updateHeartbeat = async () => {
      const ts = new Date().getTime();
      try {
        await redisHelper.zadd(redisHelper.getHeartbeatKey(), ts, heartbeatMember);
        logger.log('add transcode heartbeat succ', heartbeatMember, ts);
      } catch (err) {
        logger.log('[Error]add transcode heartbeat failed', heartbeatMember, ts, err);

        // todo what to do with err
      }
    };
    updateHeartbeat();
    heartbeatIntervalObj = setInterval(updateHeartbeat, config.heartbeatInterval);

    // 加锁，防止当前操作被多个函数执行，
    // 如果加锁失败，表示可能存在其他函数在执行当前操作，此函数先退出
    try {
      lockWorker = await initLockWorker('transcode', TaskID);
    } catch (err) {
      // remove transcode heartbeat
      await removeHeartbeat(
          'transcode',
          TaskID,
          requestID,
          null,
          heartbeatIntervalObj,
          'get-lock-failed',
      );

      reject(err);
      return;
    }

    // 2. start a worker to do the transcoding things
    const workerData = {
      TaskID: TaskID,
      RequestID: requestID,
    };

    const taskInfoStr = await redisHelper.getString(redisHelper.getTaskInfoKey(TaskID));
    const taskInfo: TaskInfo = JSON.parse(taskInfoStr);


    if ((taskInfo.StorageType ?? 'cfs') == 'cos') {
      transcodeWorker = startWorker(path.join(__dirname, 'cos-transcode-worker.ts'), {
        workerData
      });
    }
    else {
      transcodeWorker = startWorker(path.join(__dirname, 'cfs-transcode-worker.ts'), {
        workerData,
      });
    }

    transcodeWorker
        .once('online', () => {
          logger.log('transcode worker ready');
        })
        .once('error', (err) => {
          logger.log('[Error]transcode worker err', err);
          reject(err);
        })
        .once('exit', (code) => {
          logger.log('transcode worker exit code', code);
          resolve();
        })
        .on('message', (msg) => {
          if (msg == 'stop') {
            if (heartbeatIntervalObj) {
              clearInterval(heartbeatIntervalObj);
              heartbeatIntervalObj = null;
              logger.log('clear heartbeat interval object');
            }
          }
        });
  });
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