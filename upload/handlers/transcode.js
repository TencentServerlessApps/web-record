const path = require('path');
const fs = require('fs');
const COS = require('cos-nodejs-sdk-v5');
const {workerData} = require('worker_threads');
const exec = require('child_process').exec;
const {scf, config, redisHelper, logger, removeHeartbeat} = require('common');

let monitorInterval = null;
const cosRetry = 5;

const sleep = async (ms) => {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const exponentialBackoffSleep = async (base, exp, max) => {
  let ms = base * (1 << exp);
  if (max && ms > max) {
    ms = max;
  }
  ms = Math.random() * (ms / 2) + (ms / 2);
  return sleep(ms);
}

const getBucketRegion = (taskInfo) => {
  logger.log("task info", taskInfo);
  // 确定bucket参数值
  let {bucket} = config.cos;
  let cosParam = {};
  if (taskInfo['Param'] && taskInfo['Param']['Output']) {
    const taskOutPutInfo = taskInfo['Param']['Output'];
    if (taskOutPutInfo['Cos']) {
      cosParam = taskOutPutInfo['Cos'];
    }
  }
  const region = (cosParam && cosParam.Region) || config.cos.region || config.region;
  if (cosParam && cosParam.Bucket) {
    bucket = cosParam.Bucket;
  }

  return {bucket, region};
}

const isExceedLimit = async (cos, uploadKey, taskInfo) => {
  let isExceedLimit = true;

  if (!process.env.MAX_FILE_SIZE_MB) {
    return false;
  }
  let env_max_file_size = process.env.MAX_FILE_SIZE_MB;

  // check目标文件是否存在，并返回文件大小
  const {bucket, region} = getBucketRegion(taskInfo);
  console.log(`DistInfo: ${uploadKey}`);

  const res = await cos.headObject({
    Bucket: bucket,
    Region: region,
    Key: uploadKey,
  });
  console.log(`head object data: ${JSON.stringify(res, null, 4)}`);

  if (res.statusCode === 200) {
    const fileSize = parseInt(res.headers['content-length']);

    const size_limit = parseInt(env_max_file_size) * 1024 * 1024;
    if (fileSize <= size_limit) {
      isExceedLimit = false;
    } else {
      const err = {
        message: `[Error]file size ${fileSize} exceed limit ${size_limit}`,
      };
      console.log(err.message);
    }
  }

  return isExceedLimit;
}

const getTaskInfo = async (taskID) => {
  let taskInfo = {};
  try {
    const tiStr = await redisHelper.getString(redisHelper.getTaskInfoKey(taskID));
    taskInfo = JSON.parse(tiStr);
  } catch (err) {
    if (err.message && err.message.includes('update status failed')) {
      return err;
    }
  }

  return taskInfo;
}

const downloadFileToStream = async (cos, key, taskInfo, targetStream) => {
  const {bucket: bucket, region: region} = getBucketRegion(taskInfo);
  for (let i = 0; i < cosRetry; i++) {
    try {
      const res = await cos.getObject({
        Region: region,
        Bucket: bucket,
        Key: key,
        Output: targetStream
      });

      if (res.statusCode === 200) {
        logger.log(`download and transcode file success, key: ${key}`);
        return;
      } else {
        throw res;
      }
    } catch (err) {
      logger.log(`attempts ${i} download and transcode file error: ${key}, ${err}`);
      if (i + 1 === cosRetry) {
        logger.log(`download and transcode fail: ${key} after ${cosRetry} attempts`);
        throw err;
      }
    }
    await exponentialBackoffSleep(1000, i, 1000 * 30);
  }
}

const transcode = async (taskID, requestID) => {
  logger.log('begin transcode with taskID', taskID, 'requestID', requestID);

  const binRoot = path.join(__dirname, '..', 'bin', '*')
  const chmodProcess = exec('cp ' + binRoot + ' /tmp && chmod 755 /tmp/ffmpeg /tmp/ffprobe', function (error, stdout, stderr) {
    if (error) {
      console.log('chmod error: ' + error);
      return;
    }
    console.log('chmod stdout: ', stdout);
    console.log('chmod stderr: ', stderr);
  });

  let chmodPromise = new Promise(resolve => chmodProcess.on('close', (code) => {
    console.log('close code: ' + code);
    resolve();
  }));

  await chmodPromise;

  const taskInfo = await getTaskInfo(taskID);
  const cos = new COS({
    Timeout: 60000,
    SecretId: process.env.TENCENTCLOUD_SECRETID,
    SecretKey: process.env.TENCENTCLOUD_SECRETKEY,
    SecurityToken: process.env.TENCENTCLOUD_SESSIONTOKEN,
  });

  let workDir = "/tmp";
  if (process.env.WORK_DIR) {
    workDir = process.env.WORK_DIR;
  }

  // 启动 ffmpeg 转码进程
  let ffmpegLastWorkTs = Date.now();
  // 文件目标存储名称
  let cosParam = {};
  if (taskInfo['Param'] && taskInfo['Param']['Output']) {
    const taskOutPutInfo = taskInfo['Param']['Output'];
    if (taskOutPutInfo['Cos']) {
      cosParam = taskOutPutInfo['Cos'];
    }
  }
  let targetDir = taskID;
  if (cosParam['TargetDir']) {
    targetDir = cosParam['TargetDir'];
  }

  let distFileName = taskInfo['TempData']['DistFileName'];
  let localVideoDir = path.join(workDir, taskID);
  if (!fs.existsSync(localVideoDir)) {
    fs.mkdir(localVideoDir, function (error) {
      if (error) {
        console.log(error);
        return false;
      }
      console.log('create dir success', localVideoDir);
    });
  }
  const outputFile = `${localVideoDir}/${distFileName}`;
  let uploadKey = `${targetDir}/${distFileName}`;

  // check文件是否过大
  const isExceed = await isExceedLimit(cos, uploadKey, taskInfo);
  if (isExceed) {
    const err = {
      message: `[Error]file size exceed limit，please set bigger memory and env[WORK_DIR=/dev/shm]`,
    };
    console.log(err.message);
    throw err;
  }

  console.log('start transcode');
  // 将视频文件下载并写入 ffmpeg stdin 流
  const command = '/tmp/ffmpeg'.concat(' -f mp4 -i pipe: -c copy -movflags faststart -f mp4 ', outputFile);
  console.log('ffmpeg command:', command);
  const ffmpegProcess = exec(command);
  ffmpegProcess.stderr.on('data', (data) => {
    console.log(`stderr: ${data}`);
    ffmpegLastWorkTs = Date.now();
  });
  let ffmpegEnd = false;
  let ffmpegPromise = new Promise(resolve => ffmpegProcess.on('close', (code) => {
    console.log('closing code: ' + code);
    resolve();
    ffmpegEnd = true;
  }));

  await downloadFileToStream(cos, uploadKey, taskInfo, ffmpegProcess.stdin);
  console.log('download complete');
  ffmpegProcess.stdin.end();
  await ffmpegPromise;

  try {
    const fileExist = fs.existsSync(outputFile);
    if (!fileExist) {
      logger.log('file not exist, no need to upload, filepath', outputFile);
      return;
    }

    if (fileExist) {
      await uploadFunc(cos, outputFile, uploadKey, taskInfo);
    }
    clearDir(path.dirname(outputFile));
  } catch (err) {
    logger.log('[Error]files handling failed, err', err);
    clearDir(path.dirname(outputFile));
    throw err;
  }

  cleanWorker();
}

function cleanWorker() {
  clearInterval(monitorInterval);
}

const uploadFunc = async (cos, filePath, uploadKey, taskInfo) => {
  try {
    await new Promise((resolve, reject) => {
      logger.log('cos upload begin...filPath:', filePath);

      // 确定bucket和region参数
      const {bucket: bucket, region: region} = getBucketRegion(taskInfo);
      let cosParam = {};
      if (taskInfo['Param'] && taskInfo['Param']['Output']) {
        const taskOutPutInfo = taskInfo['Param']['Output'];
        if (taskOutPutInfo['Cos']) {
          cosParam = taskOutPutInfo['Cos'];
        }
      }

      const fileName = path.basename(filePath);
      logger.log('final cos param: bucket %s, region %s, key %s, fp %s', bucket, region, uploadKey, filePath);
      cos.sliceUploadFile(
          {
            Bucket: bucket,
            Region: region,
            Key: uploadKey,
            FilePath: filePath,
            onTaskReady: (taskId) => {
              logger.log('cos upload onTaskReady, taskID', taskId);
            },
            onProgress: (progressData) => {
              logger.log('cos upload onProgress', JSON.stringify(progressData));
            },
          },
          async (err, data) => {
            if (err) {
              reject(err);
            } else {
              const fsStat = fs.statSync(filePath);
              let fileURL = 'http://' + data.Location;
              const domain = cosParam.Domain || config.cos.domain;
              if (domain) {
                fileURL = 'http://' + path.join(domain, key);
              }

              // 优先从视频的stream info中获取视频时长，若获取失败，则通过StopTime-StartTime来计算
              // ffprobe方式暂时关闭，通过时间差计算视频时长
              // let duration = await getVideoDuration(filePath, null);
              // if (!duration) {
              //   logger.log('got duration by calulation');
              //   duration = taskInfo.StopTime - taskInfo.StartTime;
              // }
              let duration = taskInfo.StopTime - taskInfo.StartTime;

              // video info
              const video = {
                Filename: fileName,
                FileSize: fsStat.size,
                FileDuration: duration,
                FileURL: fileURL,
              };
              logger.log('cos upload file succ, fp', filePath, 'data', data, 'video', video);
              resolve();
            }
          },
      );
    });
  } catch (err) {
    logger.log('upload failed with errors:', JSON.stringify(err));
    logger.log('[Error]cos upload file failed, fp', filePath, 'err', err);
  }
};

const clearDir = (filePath) => {
  if (fs.existsSync(filePath)) {
    const files = fs.readdirSync(filePath)
    files.forEach((file) => {
      const nextFilePath = `${filePath}/${file}`
      const states = fs.statSync(nextFilePath)
      if (states.isDirectory()) {
        //recurse
        clearDir(nextFilePath)
      } else {
        //delete file
        fs.unlinkSync(nextFilePath)
      }
    })
    fs.rmdirSync(filePath)
  }
}

const getVideoDuration = async (file, stream) => {
  try {
    let args = [];
    if (file) {
      args = ' -print_format json -show_format ' + file;
    }
    if (stream) {
      args = ' -print_format json -show_format pipe:';
    }

    const command = '/tmp/ffprobe'.concat(args)
    console.log('Get video duration command:', command);
    const ffprobeProcess = exec(command);

    if (stream) {
      stream.pipe(ffprobeProcess.stdin);
    }

    const output = await new Promise((resolve) => {
      let stdout = '';
      ffprobeProcess.stdout.on('data', (data) => {
        stdout += data.toString('utf-8');
      });
      ffprobeProcess.on('close', () => {
        resolve(stdout);
      });
    });

    logger.log('stream infos', output);
    const info = JSON.parse(output);
    let duration = 0;
    const {streams} = info;
    if (streams) {
      for (const i in streams) {
        if (streams[i].duration) {
          duration = Math.round(Number(streams[i].duration));
          break;
        } else {
          logger.log(`streams[${i}].duration not found`);
        }
      }
    }
    logger.log('got duration from stream succ, duration', duration);
    return duration;
  } catch (err) {
    logger.log('ffprobe failed, err', err);
    return 0;
  }
};

async function worker() {
  logger.log('start cos transcode worker');
  logger.updatePermanentIndex('TaskID', workerData.TaskID);
  logger.updatePermanentIndex('Version', config.version);
  logger.log('transcode worker begin with workerData', workerData);
  await transcode(workerData.TaskID, workerData.RequestID);
  redisHelper.close();
}

worker();

process.on('uncaughtException', (e) => {
  console.log(e);
  throw e;
});


process.on('unhandledRejection', (e) => {
  console.log(e);
  throw e;
});
