import { OutputVideoInfo, TaskInfo } from "../interface";

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const MultiStream = require('multistream');

const { workerData, parentPort } = require('worker_threads');

const { scf, config, redisHelper, logger, invokeCallback, removeHeartbeat } = require('common');

async function updateStatusToUpload(taskID: string, oRequestID: string) {
  // 0 update taskinfo
  try {
    await redisHelper.updateTaskInfo(redisHelper.getTaskInfoKey(taskID), {
      Status: 'upload',
    });
  } catch (err) {
    // todo what to do with err
  }

  // // 1 add first upload heartbeat
  // const member = redisHelper.getHeartbeatMemberKey(taskID, oRequestID);
  // const ts = new Date().getTime();
  // try {
  //   await redisHelper.zadd(redisHelper.getHeartbeatKey(), ts, member);
  //   logger.log('add upload heartbeat succ,', member, ts);
  // } catch (err) {
  //   logger.log('[Error]add upload heartbeat failed,', member, ts, err);
  //
  //   // todo what to do with err
  // }

  // 1. clear transcode heartbeat
  await removeHeartbeat('transcode', taskID, oRequestID, parentPort, null, 'status-change');
}

// 合并视频源文件
async function concat(srcDir: string, dstDir: string) {
  if (fs.existsSync(dstDir)) {
    fs.rmdirSync(dstDir, { force: true, recursive: true });
  }
  fs.mkdirSync(dstDir, { recursive: true });

  const saveFp = path.join(dstDir, new Date().getTime().toString() + '.webm');
  const files = fs.readdirSync(srcDir);
  files.sort((a: string, b: string) => {
    const asplit = a.split('.');
    const bsplit = b.split('.');
    const len = asplit.length < bsplit.length ? asplit.length : bsplit.length;
    for (let i = 0; i < len; i++) {
      if (asplit[i] > bsplit[i]) {
        return 1;
      } else if (asplit[i] < bsplit[i]) {
        return -1;
      }
    }

    return 0;
  });

  logger.log(`Concating files number: ${files.length}`);
  const streams = [];
  const writeStream = fs.createWriteStream(saveFp);
  for (let i = 0; i < files.length; i++) {
    try {
      logger.log('handling file name:', files[i], 'index:', i);
      const fp = path.join(srcDir, files[i]);
      streams.push(fs.createReadStream(fp));
    } catch (err) {
      logger.log('[Error]concat files failed with err', err);
      throw err;
    }
  }
  const multiStream = new MultiStream(streams);
  return new Promise((resolve, reject) => {
    multiStream
      .pipe(writeStream)
      .on('error', (err: any) => {
        reject(err);
      })
      .on('finish', () => {
        resolve(true);
      });
  });
}

async function ffmpegTranscode(srcDir: string, dstDir: string) {
  const ffmpegTranscodeFunc = async (filename: string) => {
    const outputOptions = [
      '-async', '1',
      '-c:a aac',
      '-c:v copy',
      '-threads 0',
      '-max_muxing_queue_size 2048',
      '-max_interleave_delta 0',
      '-y',
    ];
    const fp = path.join(srcDir, filename);
    logger.log('transcoding file', fp);

    const dotIndex = filename.lastIndexOf('.');
    const saveFp = path.join(dstDir, filename.substring(0, dotIndex) + '.mp4');
    try {
      await new Promise<void>((resolve, reject) => {
        ffmpeg(fp)
          .outputOptions(outputOptions)
          .on('start', async (commandLine: string) => {
            logger.log('transcode begin...');
            logger.log(`FFMPEG COMMAND : ${commandLine}`);
          })
          .on('progress', async (data: string) => {
            // logger.log('transcoding ...');
          })
          .on('stderr', function (stderrLine: string) {
            logger.log('Stderr output: ' + stderrLine);
          })
          .on('error', function (err: any) {
            reject(err);
          })
          .on('end', () => {
            logger.log('transcode finished!');
            resolve();
          })
          .save(saveFp);
      });
    } catch (err) {
      logger.log('[Error]transcode failed,', err.message);
      throw err;
    }
  };

  try {
    if (!fs.existsSync(srcDir)) {
      logger.log('[Error]raw dir not exist, no need to transcode');
      throw 'raw dir not exist, no need to transcode';
    }

    if (fs.existsSync(dstDir)) {
      fs.rmdirSync(dstDir, { force: true, recursive: true });
    }
    fs.mkdirSync(dstDir, { recursive: true });

    const files = fs.readdirSync(srcDir);
    for (let i = 0; i < files.length; i++) {
      await ffmpegTranscodeFunc(files[i]);
    }
  } catch (err) {
    logger.log('[Error]transcode handling failed, err', err);
    throw err;
  }
}

async function ffmpegTranscodeHls(srcDir: string, dstDir: string, outputVideoInfo: OutputVideoInfo, taskID: string, targetName: string) {
  async function ffmpegTranscodeFunc(filename: string, encryptOptions: string[], targetName: string) {

    let outputOptions = [
      '-threads 0',
      '-c:v copy',
      '-hls_time 30',
      '-hls_list_size 0'
    ];
    if (encryptOptions.length) {
      outputOptions.push(...encryptOptions);
    }

    const fp = path.join(srcDir, filename);
    logger.log('transcoding file', fp);

    // const dotIndex = filename.lastIndexOf('.');
    const saveFp = path.join(dstDir, `/${targetName}.m3u8`);
    try {
      await new Promise<void>((resolve, reject) => {
        ffmpeg(fp)
          .outputOptions(outputOptions)
          .on('start', async (commandLine: string) => {
            logger.log('transcode begin...');
            logger.log(`FFMPEG COMMAND : ${commandLine}`);
          })
          .on('progress', async () => {
            // logger.log('transcoding ...');
          })
          .on('stderr', function (stderrLine: string) {
            logger.log('Stderr output: ' + stderrLine);
          })
          .on('error', function (err: any) {
            reject(err);
          })
          .on('end', () => {
            logger.log('transcode finished!');

            resolve();
          })
          .save(saveFp);
      });
    } catch (err) {
      logger.log('[Error]transcode failed,', err.message);
      throw err;
    }
  };

  try {
    let encryptOptions: string[] = [];
    if (outputVideoInfo.EncryptKey && outputVideoInfo.AuthUrl) {
      const encryptKeyInfoPath = config.tmpDir + taskID + config.hlsEncryptKeyInfoFile
      const encryptKeyPath = config.tmpDir + taskID + config.hlsEncryptKeyFile

      let content = outputVideoInfo.AuthUrl +
        '\n' +
        encryptKeyPath
      if (outputVideoInfo.EncryptIv && outputVideoInfo.EncryptIv !== '') {
        content += content + '\n' + outputVideoInfo.EncryptIv
      }

      fs.writeFileSync(encryptKeyPath, outputVideoInfo.EncryptKey);
      fs.writeFileSync(encryptKeyInfoPath, content);
      encryptOptions = ['-hls_key_info_file', encryptKeyInfoPath];
    }

    if (!fs.existsSync(srcDir)) {
      logger.log('[Error]raw dir not exist, no need to transcode');
      throw 'raw dir not exist, no need to transcode';
    }

    if (fs.existsSync(dstDir)) {
      fs.rmdirSync(dstDir, { force: true, recursive: true });
    }
    fs.mkdirSync(dstDir, { recursive: true });

    const files = fs.readdirSync(srcDir);
    for (let i = 0; i < files.length; i++) {
      await ffmpegTranscodeFunc(files[i], encryptOptions, targetName);
    }
  } catch (err) {
    logger.log('[Error]transcode handling failed, err', err);
    throw err;
  }
}


async function transcode(taskID: string, requestID: string) {
  logger.log('begin transcode with taskID', taskID, 'requestID', requestID);
  // 1. update taskinfo
  const taskInfo = await redisHelper.updateTaskInfo(redisHelper.getTaskInfoKey(taskID), {
    Status: 'transcode',
    InvokedRequestID: requestID,
  }) as TaskInfo;

  const videoDir = path.join(config.videoRootDir, taskID);
  const videoRawDir = path.join(videoDir, 'raw');

  // 2. concat
  const videoConcatedDir = path.join(videoDir, 'concated');
  try {
    await concat(videoRawDir, videoConcatedDir);
    logger.log('concat video succ');
  } catch (err) {
    logger.log('[Error]concat video failed with err', err);
    const data = {
      Status: 'callback',
      Result: {
        ErrorCode: 'InternalError',
        ErrorMessage: 'video concat failed(' + err.message + ')',
      },
    };
    await invokeCallback('transcode', taskID, requestID, data);
    await removeHeartbeat('transcode', taskID, requestID, parentPort, null, 'status-change');
    return;
  }

  // 3. transcode
  const videoTranscodedDir = path.join(videoDir, 'transcoded');
  fs.mkdirSync(videoTranscodedDir, { recursive: true });
  try {
    const paramInfo = taskInfo.Param;
    const targetName = (taskInfo.Param?.Output?.Vod?.MediaInfo?.MediaName ?? taskInfo.Param?.Output?.Cos?.TargetName) ?? 'playlist';
    if (paramInfo && paramInfo.Output && paramInfo.Output.Video) {
      const outputVideoInfo = paramInfo.Output.Video
      if (outputVideoInfo.Muxer === 'hls') {
        await ffmpegTranscodeHls(videoConcatedDir, videoTranscodedDir,
          outputVideoInfo, taskID, targetName);
      }else{
        await ffmpegTranscode(videoConcatedDir, videoTranscodedDir);
      }
    } else {
      await ffmpegTranscode(videoConcatedDir, videoTranscodedDir);
    }

    logger.log('transcode video succ');
  } catch (err) {
    logger.log('[Error]transcode video failed with err', err);

    // 如果任务持续时长小于2s, 则忽略此次错误
    if (taskInfo && taskInfo.StartTime && taskInfo.StopTime && taskInfo.StopTime - taskInfo.StartTime < 2) {
      logger.log(
        `task lasts time is too short(${taskInfo.StopTime - taskInfo.StartTime}s)` +
        'to be recorded, ignore the transcode err.',
      );
    } else {
      const data = {
        Status: 'callback',
        Result: {
          ErrorCode: 'InternalError',
          ErrorMessage: 'video transcode failed(' + err.message + ')',
        },
      };
      await invokeCallback('transcode', taskID, requestID, data);
      await removeHeartbeat('transcode', taskID, requestID, parentPort, null, 'status-change');
      return;
    }
  }

  // 4. invoke scf:upload & update taskinfo
  await updateStatusToUpload(taskID, requestID);
}

async function worker() {
  logger.log('start cfs transcode worker');
  logger.updatePermanentIndex('TaskID', workerData.TaskID);
  logger.updatePermanentIndex('Version', config.version);
  logger.log('transcode worker begin with workerData', workerData);
  await transcode(workerData.TaskID, workerData.RequestID);
  redisHelper.close();
}
worker();
