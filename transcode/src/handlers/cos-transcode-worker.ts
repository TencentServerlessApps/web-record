import path from 'path';
import fs from 'fs';
import COS from 'cos-nodejs-sdk-v5';
import {parentPort, workerData} from 'worker_threads';
import {Cos, TaskInfo} from '../interface';
import {AsyncController} from '../async-controller';
import {totalSize, uploadFile, uploadFolder, uploadStream} from '../upload';
import {cosRetry} from '..';
import {exponentialBackoffSleep} from '../utils';
import {Writable} from 'stream';
import {spawnFfmpeg} from './ffmpeg';

const { scf, config, redisHelper, logger, removeHeartbeat } = require('common');
const VodClientWrapper = require('./vodClient');
const {VodUploadClient, VodUploadRequest} = require('vod-sdk');

let monitorInterval: NodeJS.Timeout;

let vodMedia = {};

export function getBucketRegion(taskInfo: TaskInfo, raw: boolean = false) {
  let { bucket } = config.cos;
  const cosParam: Cos = taskInfo.Param?.Output?.Cos ?? {};
  if (cosParam?.Bucket) {
    bucket = cosParam.Bucket;
  }
  let region = cosParam?.Region || config.cos.region || config.region;


  if (raw) {
    let bucketRaw = process.env.COS_BUCKET_RAW === 'undefined' ? '' : process.env.COS_BUCKET_RAW;
    let bucketRawRegion = process.env.COS_BUCKET_RAW_REGION === 'undefined' ? '' : process.env.COS_BUCKET_RAW_REGION;
    bucket = bucketRaw || bucket;
    region = bucketRawRegion || region;
  }

  return { bucket, region };
}

// 触发upload函数生成并上传普通Mp4
async function invokeUpload(taskID: string) {
  // invoke scf:upload
  logger.log('invoking scf:upload...');
  try {
    return await scf.invoke(config.scf.PostUploadFunctionName, {TaskID: taskID}, false);
  } catch (err) {
    throw err;
  }
}

async function updateStatusToUpload(taskID: string, oRequestID: string, targetDir: string, distName: string) {
  // 0 update taskinfo
  try {
    if (Object.keys(vodMedia).length !== 0) {
      await redisHelper.updateTaskInfo(redisHelper.getTaskInfoKey(taskID), {
        Status: 'upload',
	    TempData: {
          DistFileName: distName
        },
        Result: {
          VodMedia: vodMedia,
        },
      });
    } else {
      await redisHelper.updateTaskInfo(redisHelper.getTaskInfoKey(taskID), {
        Status: 'upload',
	    TempData: {
          DistFileName: distName
        }
      });
    }
  } catch (err) {
    if (err.message && err.message.includes('update status failed')) {
      await removeHeartbeat(
        'transcode',
        taskID,
        oRequestID,
        parentPort,
        null,
        'status-change-failed',
      );
      return err;
    }
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

function filenameSortFn(a: string, b: string) {
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
}

async function updateTaskInfo(taskID: string, requestID: string): Promise<TaskInfo> {
  let taskInfo: TaskInfo = {};
  try {
    taskInfo = await redisHelper.updateTaskInfo(redisHelper.getTaskInfoKey(taskID), {
      Status: 'transcode',
      InvokedRequestID: requestID,
    });
  } catch (err) {
    if (err.message && err.message.includes('update status failed')) {
      await removeHeartbeat(
        'transcode',
        taskID,
        requestID,
        parentPort,
        null,
        'status-change-failed',
      );

      return err;
    }
    // todo what to do with err
  }

  return taskInfo;
}

async function getObjList(cos: COS, taskInfo: TaskInfo) {
  const videoKeyPrefix = `raw/${taskInfo.TaskID}/`;
  const { bucket: rawBucket, region: rawRegion } = getBucketRegion(taskInfo, true);

  // 获取 cos 原始视频文件列表
  let objList: COS.CosObject[] = [];
  let marker = undefined;
  for (; ;) {
    for (let i = 0; i < cosRetry; i++) {
      try {
        const listRes: COS.GetBucketResult = await cos.getBucket({
          ...{
            Bucket: rawBucket,
            Region: rawRegion,
            Prefix: videoKeyPrefix,
          },
          ...(marker == null ? {} : { Marker: marker }),
        });

        if (listRes.statusCode == 200) {
          for (let obj of listRes.Contents) {
            if (!obj) {
              throw listRes.Contents;
            }
            objList.push(obj);
          }
          marker = listRes.NextMarker;
          break;
        }

        throw listRes;
      } catch (err) {
        console.log(JSON.stringify(process.env, null, 2));
        logger.log(`attempts ${i} get bucket error: `, err);
        if (i + 1 == cosRetry) {
          logger.log('get bucket fail');
          throw err;
        }
      }
      await exponentialBackoffSleep(500, i, 10 * 1000);
    }

    logger.log(`Get ${objList.length} object info, next marker: ${marker}`);
    if (marker == null) {
      break;
    }
  }

  logger.log('total object: ', objList.length);

  let totalSize = 0;
  for (const obj of objList) {
    totalSize += parseInt(obj.Size, 10);
  }


  logger.log('total size: ', totalSize);

  if (totalSize == 0 || objList.length == 0) {
    throw 'total size is zero';
  }

  return objList;
}

function downloadSliceToStream(cos: COS, keyList: string[], taskInfo: TaskInfo, targetStream: Writable) {
  const concurrency = 10;
  const { bucket: rawBucket, region: rawRegion } = getBucketRegion(taskInfo, true);

  const taskID = taskInfo.TaskID!;
  const asyncExecutor = new AsyncController<string, COS.GetObjectResult | undefined>({
    concurrency,
    tasks: keyList,
    work: async (key) => {
      for (let i = 0; i < cosRetry; i++) {
        try {
          const res = await cos.getObject({
            Region: rawRegion,
            Bucket: rawBucket,
            Key: key,
          });

          if (res.statusCode == 200) {
            logger.log(`download slice success: ${key}`);
            return res;
          } else {
            throw res;
          }
        } catch (err) {
          logger.log(`attempts ${i} download slice error: ${key}, ${err}`);
          if (i + 1 == cosRetry) {
            logger.log(`download slice fail: ${key} after 10 attempts`);
            throw err;
          }
        }
        await exponentialBackoffSleep(1000, i, 1000 * 30);
      }
    },
    onFinish: (result, index, task) => {
      let data = result?.Body;
      if (data) {
        if (index + 1 < keyList.length) {
          const startTime = keyList[index].split(taskID)[1].split('/')[1];
          const nextStartTime = keyList[index + 1].split(taskID)[1].split('/')[1];
          logger.log(`slice ${task} request Id: ${startTime}; nextStartTime: ${nextStartTime}`);
          if (startTime != nextStartTime) {
            return;
          }
        }

        targetStream.write(data);
      }
    }
  });
  return asyncExecutor;
}

function vodUploadRequest(taskInfo: TaskInfo) {
  let vodUploadRequest = new VodUploadRequest();
  const muxer = taskInfo.Param?.Output?.Video?.Muxer ?? 'mp4';
  if (muxer === 'hls') {
    vodUploadRequest.MediaType = 'm3u8';
  }

  if (muxer === 'mp4') {
    vodUploadRequest.MediaType = 'mp4';
  }

  vodUploadRequest.WebPageRecordInfo = {
    RecordUrl: taskInfo.Param?.RecordURL,
    RecordTaskId: taskInfo.TaskID,
  };

  // StorageRegion优先级：接口参数StorageRegion > 环境变量VOD_STORAGE_REGION
  // 如果环境变量StorageRegion == 'default'，表示就近存储，请求中不设置该参数
  if (process.env.VOD_STORAGE_REGION && process.env.VOD_STORAGE_REGION !== "undefined" && process.env.VOD_STORAGE_REGION !== 'default') {
    vodUploadRequest.StorageRegion = process.env.VOD_STORAGE_REGION;
  }

  // SubAppId优先级：接口参数SubAppId > 环境变量VOD_SUB_APPID
  if (process.env.VOD_SUB_APPID && process.env.VOD_SUB_APPID !== "undefined") {
    vodUploadRequest.SubAppId = parseInt(process.env.VOD_SUB_APPID);
  }

  const vodConfig = taskInfo.Param?.Output?.Vod;
  if (vodConfig) {
    const storageRegion = vodConfig.MediaInfo?.StorageRegion ?? null
    if (storageRegion) {
      vodUploadRequest.StorageRegion = storageRegion;
    }

    if (vodConfig.SubAppId) {
      vodUploadRequest.SubAppId = vodConfig.SubAppId;
    }

    if (vodConfig.MediaInfo?.MediaName) {
      vodUploadRequest.MediaName = vodConfig.MediaInfo?.MediaName;
    }

    if (vodConfig.MediaInfo?.ExpireTime) {
      vodUploadRequest.ExpireTime = vodConfig.MediaInfo?.ExpireTime;
    }

    if (vodConfig.MediaInfo?.ClassId) {
      vodUploadRequest.ClassId = vodConfig.MediaInfo?.ClassId;
    }

    if (vodConfig.MediaInfo?.SourceContext) {
      vodUploadRequest.SourceContext = vodConfig.MediaInfo?.SourceContext;
    }

    if (vodConfig.ProcedureInfo?.Procedure) {
      vodUploadRequest.Procedure = vodConfig.ProcedureInfo?.Procedure;
    }

    if (vodConfig.ProcedureInfo?.SessionContext) {
      vodUploadRequest.SessionContext = vodConfig.ProcedureInfo?.SessionContext;
    }
  }

  logger.log("storageType[cos], vodUploadRequest", vodUploadRequest);

  return vodUploadRequest;
}

function isUploadVod(taskInfo: TaskInfo) {
  let isUploadVod = false;
  if (taskInfo.Param?.Output?.Vod) {
    isUploadVod = true;
  }

  if (process.env.VOD_STORAGE_REGION && process.env.VOD_STORAGE_REGION !== "undefined") {
    isUploadVod = true;
  }

  if (process.env.VOD_SUB_APPID && process.env.VOD_SUB_APPID !== "undefined") {
    isUploadVod = true;
  }

  return isUploadVod;
}

async function transcode(taskID: string, requestID: string) {
  logger.log('begin transcode with taskID', taskID, 'requestID', requestID);
  // 1. update taskinfo
  const taskInfo = await updateTaskInfo(taskID, requestID);

  logger.log('taskInfo:', taskInfo);

  const cos = new COS({
    Timeout: 60000,
    SecretId: process.env.TENCENTCLOUD_SECRETID,
    SecretKey: process.env.TENCENTCLOUD_SECRETKEY,
    SecurityToken: process.env.TENCENTCLOUD_SESSIONTOKEN,
  });

  const objList = await getObjList(cos, taskInfo);
  const keyList = objList.map((v) => v.Key);
  keyList.sort(filenameSortFn);

  // 启动 ffmpeg 转码进程
  let ffmpegLastWorkTs = Date.now();
  const muxer = taskInfo.Param?.Output?.Video?.Muxer ?? 'mp4';
  const hlsDir = `/tmp/${Date.now()}`;

  // 获取上传cos的bucket和region
  let { bucket, region } = getBucketRegion(taskInfo, false);

  // 文件目标存储名称，优先级： Vod > Cos
  let targetName = muxer === 'hls' ? (taskInfo.Param?.Output?.Cos?.TargetName ?? 'playlist') : (taskInfo.Param?.Output?.Cos?.TargetName ?? `${Date.now()}`);

  let targetDir = taskInfo.Param?.Output?.Cos?.TargetDir ?? taskID;
  let uploadKey = `${targetDir}/${targetName}.${muxer}`;
  let distFileName = `${targetName}.${muxer}`
  if (muxer === 'hls') {
    uploadKey = `${targetDir}`;
    distFileName = `${targetName}.m3u8`
  }

  // vod上传场景
  // vod.step1: 确认secretId和secretKey,初始化vod客户端
  let secretId = process.env.SECRET_ID;
  let secretKey = process.env.SECRET_KEY;
  let token = null;
  // 处理兼容 undefined 字符串问题
  secretId = secretId === 'undefined' ? '' : secretId;
  secretKey = secretKey === 'undefined' ? '' : secretKey;

  if (!secretId || !secretKey) {
    secretId = process.env.TENCENTCLOUD_SECRETID;
    secretKey = process.env.TENCENTCLOUD_SECRETKEY;
    token = process.env.TENCENTCLOUD_SESSIONTOKEN;
  }

  let uploadCos = cos;
  const vodClient = new VodClientWrapper(config.region, secretId, secretKey, token);

  const uploadVod = isUploadVod(taskInfo)

  if (uploadVod) {
    logger.log('storage type cos need upload vod.');
    // vod.step2:申请上传
    let vodRequest = vodUploadRequest(taskInfo);
    logger.log('upload vod: apply vod upload request:', vodRequest);
    let applyUploadResponse = await vodClient.applyVodUpload(vodRequest);
    logger.log('upload vod: applyUploadResponse:', applyUploadResponse);

    vodClient.setVodSessionKey(applyUploadResponse.VodSessionKey);
    vodClient.setSubAppId(vodRequest.SubAppId || null);

    if (applyUploadResponse.TempCertificate != null) {
      uploadCos = new COS({
        Timeout: 60000,
        SecretId: applyUploadResponse.TempCertificate.SecretId,
        SecretKey: applyUploadResponse.TempCertificate.SecretKey,
        XCosSecurityToken: applyUploadResponse.TempCertificate.Token
      });
    }
    // muxer=hls,targetName是文件名，muxer=hls,targetName是uploadKey
    const baseName = path.basename(applyUploadResponse.MediaStoragePath);
    targetName = baseName.substring(0, baseName.lastIndexOf(".")) || (taskInfo.Param?.Output?.Vod?.MediaInfo?.MediaName ?? 'playlist');
    logger.log('cos storage upload vod: targetName:', targetName);

    targetDir = path.dirname(applyUploadResponse.MediaStoragePath);
    uploadKey = applyUploadResponse.MediaStoragePath;
    if (muxer === 'hls') {
      uploadKey = `${targetDir}`;
    }

    bucket = applyUploadResponse.StorageBucket;
    region = applyUploadResponse.StorageRegion;
  }

  let outputFile = muxer === 'hls' ? `${hlsDir}/${targetName}.m3u8` : `pipe:`;
  if (muxer === 'hls') {
    const files = await fs.promises.readdir('/tmp');
    console.log('/tmp directory files:', files);
    await fs.promises.mkdir(hlsDir);
  }

  // 如果配置环境MP4_STORAGE_TMPFS & muxer == 'mp4'
  const tmpfsDir = `/dev/shm/${Date.now()}`;
  await fs.promises.mkdir(tmpfsDir);
  if (process.env.MP4_STORAGE_TMPFS && process.env.MP4_STORAGE_TMPFS !== "undefined" && muxer == 'mp4') {
      outputFile = `${tmpfsDir}/${targetName}.${muxer}`;
      uploadKey = `${targetDir}/${targetName}.${muxer}`;
  }

  let encryptArgs: string[] = [];
  try {
    const outputVideoInfo = taskInfo.Param?.Output?.Video;
    if (outputVideoInfo?.EncryptKey && outputVideoInfo.AuthUrl) {
      const encryptKeyInfoPath = config.tmpDir + taskID + config.hlsEncryptKeyInfoFile;
      const encryptKeyPath = config.tmpDir + taskID + config.hlsEncryptKeyFile;

      let content = outputVideoInfo.AuthUrl +
        '\n' +
        encryptKeyPath;
      if (outputVideoInfo.EncryptIv && outputVideoInfo.EncryptIv !== '') {
        content += content + '\n' + outputVideoInfo.EncryptIv;
      }

      fs.writeFileSync(encryptKeyPath, outputVideoInfo.EncryptKey);
      fs.writeFileSync(encryptKeyInfoPath, content);
      encryptArgs = ['-hls_key_info_file', encryptKeyInfoPath];
    }
  } catch (err) {
    logger.log('[Error]transcode handling failed, err', err);
    throw err;
  }
  const ffmpegProcess = spawnFfmpeg('pipe:', outputFile, muxer, encryptArgs);
  ffmpegProcess.stderr.on('data', (data: string) => {
    ffmpegLastWorkTs = Date.now();
    logger.log(`stderr: ${data}`);
  });
  let ffmpegEnd = false;
  let ffmpegPromise = new Promise<void>(resolve => ffmpegProcess.on('close', () => {
    resolve();
    ffmpegEnd = true;
  }));


  // 将视频文件下载并写入 ffmpeg stdin 流
  const asyncExecutor = downloadSliceToStream(cos, keyList, taskInfo, ffmpegProcess.stdin);
  const asyncExecutorPromise = asyncExecutor.run();

  monitorInterval = setInterval(() => {
    if (ffmpegProcess.stdin.writableLength > 256 * 1024 * 1024) {
      if (!asyncExecutor.paused) {
        logger.log('pause');
        asyncExecutor.pause();
      }
    } else if (asyncExecutor.paused) {
      logger.log('resume');
      asyncExecutor.resume();
    }
    console.log("memory usage", Math.round(process.memoryUsage().rss / (1024 * 1024)), "mb");
    console.log("stdin memory", Math.round(ffmpegProcess.stdin.writableLength / (1024 * 1024)), "mb");

    // ffmpeg 超过 20 分钟不工作，终止
    if (Date.now() - ffmpegLastWorkTs > 20 * 60 * 1000) {
      cleanWorker();
      throw `ffmpeg no response after ${Date.now() - ffmpegLastWorkTs}`;
    }
  }, 1000);


  logger.log('start transcode');

  let uploadPromise: Promise<void> | null;
  if (muxer === 'hls') {
    uploadPromise = uploadFolder(uploadCos, hlsDir, {
      TargetName: targetName,
      BaseKey: uploadKey,
      Region: region,
      Bucket: bucket,
    }, () => ffmpegEnd);
  } else {
    if (process.env.MP4_STORAGE_TMPFS && process.env.MP4_STORAGE_TMPFS !== "undefined") {
        uploadPromise = uploadFile(uploadCos, outputFile, {
            TargetName: targetName,
            Key: uploadKey,
            Region: region,
            Bucket: bucket,
        }, () => ffmpegEnd);
    } else {
      uploadPromise = uploadStream(uploadCos, ffmpegProcess.stdout, {
        Region: region,
        Bucket: bucket,
        Key: uploadKey,
      });
    }
  }

  await asyncExecutorPromise;
  logger.log('download complete');
  ffmpegProcess.stdin.end();
  await ffmpegPromise;

  await uploadPromise;
  logger.log('upload complete');

  // vod.step3: 确认完成上传，并封装video信息
  if (uploadVod) {
    logger.log('upload vod complete, commit upload....');
    let uploadCommitResponse = await vodClient.commitVodUpload(vodClient.vodSessionKey, vodClient.subAppId);
    logger.log('commit upload response: ', uploadCommitResponse);
    if (uploadCommitResponse) {
      // cos中转方式分块转码上传的原因，媒体文件大小通过totalSize直接获取
      if (muxer === 'mp4') {
        vodMedia = {
          FileId: uploadCommitResponse.FileId,
          Filename: path.basename(uploadCommitResponse.MediaUrl),
          FileSize: totalSize,
          FileURL: uploadCommitResponse.MediaUrl,
        };
      } else {
        let describeMediaResponse = null;
        let retryTimes = 5;
        // 等待3s再查询，避免vod媒体数据还没落盘
        await vodClient.wait(3000);
        while (retryTimes > 0) {
          try {
            describeMediaResponse = await vodClient.describeMediaInfo(uploadCommitResponse.FileId, vodClient.subAppId);
            logger.log("describe media response:", describeMediaResponse);
            if (describeMediaResponse && describeMediaResponse.MediaInfoSet.length > 0 && describeMediaResponse.MediaInfoSet[0]["MetaData"]) {
              break;
            }
            throw new Error('describeMediaInfo: try again...');
          } catch(e) {
            logger.log('describe media catch error', e);
            retryTimes--;
            if (retryTimes === 0) {
              logger.log(`describe media fail after 5 attempts`);
              throw e;
            }
            await vodClient.wait(3000);
          }
        }

        if (describeMediaResponse && describeMediaResponse.MediaInfoSet.length > 0) {
          const size = describeMediaResponse.MediaInfoSet[0]["MetaData"] ? describeMediaResponse.MediaInfoSet[0]["MetaData"]["Size"] : 0;
          const duration = describeMediaResponse.MediaInfoSet[0]["MetaData"] ? describeMediaResponse.MediaInfoSet[0]["MetaData"]["Duration"] : 0;
          vodMedia = {
            FileId: uploadCommitResponse.FileId,
            Filename: path.basename(uploadCommitResponse.MediaUrl),
            FileSize: size,
            FileDuration: duration,
            FileURL: uploadCommitResponse.MediaUrl,
          };
        }
      }
      logger.log('commit upload finished, vodMedia: ', vodMedia);
    }
  }

  // 5. invoke scf:upload & update taskinfo
  await updateStatusToUpload(taskID, requestID, targetDir, distFileName);

  // 触发upload函数条件：配置环境变量fmp4=mp4, muxer == 'mp4', storageType=cos, output=cos
  if (process.env.FMP4 && process.env.FMP4 !== "undefined" && muxer == 'mp4'
      && taskInfo.StorageType == "cos") {
    try {
      const res = await invokeUpload(taskID);
      logger.log('invoke scf:upload rsp', res);
    } catch (err) {
      logger.log('[Error]invoke upload function failed, err: ', err);
      // throw err;
    }
  }

  cleanWorker();
}

function cleanWorker() {
  clearInterval(monitorInterval);
}

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
