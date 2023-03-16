import { TaskInfo } from '../interface';
import {scf} from "common";

const COS = require('cos-nodejs-sdk-v5');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const { workerData, parentPort } = require('worker_threads');
const { config, redisHelper, logger, invokeCallback, removeHeartbeat } = require('common');
const VodClientWrapper = require('./vodClient');
const { VodUploadRequest } = require('vod-sdk');

const getVideoDuration = async ({ file, stream }) => {
  try {
    let args = [];
    if (file) {
      args = ['-print_format', 'json', '-show_format', file];
    }
    if (stream) {
      args = ['-print_format', 'json', '-show_format', 'pipe:'];
    }
    logger.log('Get video duration:', args);
    const ffprobeProcess = spawn(path.join(__dirname, '..', '..', 'bin', 'ffprobe'), args);

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
    const { streams } = info;
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

  // info 字段参考
  // {
  //   streams: [
  //     {
  //       index: 0,
  //       codec_name: 'h264',
  //       codec_long_name: 'H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10',
  //       profile: 'High',
  //       codec_type: 'video',
  //       codec_time_base: '1/50',
  //       codec_tag_string: 'avc1',
  //       codec_tag: '0x31637661',
  //       width: 1280,
  //       height: 720,
  //       coded_width: 1280,
  //       coded_height: 720,
  //       has_b_frames: 0,
  //       sample_aspect_ratio: '1:1',
  //       display_aspect_ratio: '16:9',
  //       pix_fmt: 'yuv420p',
  //       level: 31,
  //       chroma_location: 'left',
  //       refs: 1,
  //       is_avc: '1',
  //       nal_length_size: '4',
  //       r_frame_rate: '25/1',
  //       avg_frame_rate: '25/1',
  //       time_base: '1/25',
  //       start_pts: 0,
  //       start_time: '0.000000',
  //       duration_ts: 299,
  //       duration: '11.960000',
  //       bit_rate: '1031739',
  //       bits_per_raw_sample: '8',
  //       nb_frames: '299',
  //       disposition: {
  //         default: 1,
  //         dub: 0,
  //         original: 0,
  //         comment: 0,
  //         lyrics: 0,
  //         karaoke: 0,
  //         forced: 0,
  //         hearing_impaired: 0,
  //         visual_impaired: 0,
  //         clean_effects: 0,
  //         attached_pic: 0,
  //       },
  //       tags: {
  //         language: 'und',
  //         handler_name: 'VideoHandler',
  //       },
  //     },
  //     {
  //       index: 1,
  //       codec_name: 'aac',
  //       codec_long_name: 'AAC (Advanced Audio Coding)',
  //       profile: 'LC',
  //       codec_type: 'audio',
  //       codec_time_base: '1/44100',
  //       codec_tag_string: 'mp4a',
  //       codec_tag: '0x6134706d',
  //       sample_fmt: 'fltp',
  //       sample_rate: '44100',
  //       channels: 2,
  //       channel_layout: 'stereo',
  //       bits_per_sample: 0,
  //       r_frame_rate: '0/0',
  //       avg_frame_rate: '0/0',
  //       time_base: '1/44100',
  //       start_pts: 0,
  //       start_time: '0.000000',
  //       duration_ts: 528384,
  //       duration: '11.981497',
  //       bit_rate: '192287',
  //       max_bit_rate: '203120',
  //       nb_frames: '516',
  //       disposition: {
  //         default: 1,
  //         dub: 0,
  //         original: 0,
  //         comment: 0,
  //         lyrics: 0,
  //         karaoke: 0,
  //         forced: 0,
  //         hearing_impaired: 0,
  //         visual_impaired: 0,
  //         clean_effects: 0,
  //         attached_pic: 0,
  //       },
  //       tags: {
  //         creation_time: '2015-11-16 00:48:42',
  //         language: 'eng',
  //         handler_name: 'IsoMedia File Produced by Google, 5-11-2011',
  //       },
  //     },
  //   ],
  // }
};

function vodUploadRequest(taskInfo) {
  let vodUploadRequest = new VodUploadRequest();
  const muxer = taskInfo.Param?.Output?.Video?.Muxer ?? 'mp4';
  if (muxer === 'hls') {
    vodUploadRequest.MediaType = 'm3u8';
  }

  if (muxer === 'mp4') {
    vodUploadRequest.MediaType = 'mp4';
  }

  vodUploadRequest.WebPageRecordInfo = {
    RecordUrl: taskInfo.Param.RecordURL,
    RecordTaskId: taskInfo.TaskID,
  };

  // StorageRegion优先级：接口参数StorageRegion > 环境变量StorageRegion
  // 如果环境变量VOD_STORAGE_REGION == 'default'，表示就近存储，请求中不设置该参数
  if (
    process.env.VOD_STORAGE_REGION &&
    process.env.VOD_STORAGE_REGION !== 'undefined' &&
    process.env.VOD_STORAGE_REGION !== 'default'
  ) {
    vodUploadRequest.StorageRegion = process.env.VOD_STORAGE_REGION;
  }

  // SubAppId优先级：接口参数SubAppId > 环境变量VOD_SUB_APPID
  if (process.env.VOD_SUB_APPID && process.env.VOD_SUB_APPID !== 'undefined') {
    vodUploadRequest.SubAppId = parseInt(process.env.VOD_SUB_APPID);
  }

  if (taskInfo.Param?.Output?.Vod) {
    const vodConfig = taskInfo.Param.Output.Vod;

    if (vodConfig.MediaInfo?.StorageRegion) {
      vodUploadRequest.StorageRegion = vodConfig.MediaInfo?.StorageRegion;
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

  logger.log('vodUploadRequest', vodUploadRequest);

  return vodUploadRequest;
}

function isUploadVod(taskInfo) {
  let isUploadVod = false;

  if (taskInfo.Param?.Output?.Vod) {
    isUploadVod = true;
  }

  if (process.env.VOD_STORAGE_REGION && process.env.VOD_STORAGE_REGION !== 'undefined') {
    isUploadVod = true;
  }

  if (process.env.VOD_SUB_APPID && process.env.VOD_SUB_APPID !== 'undefined') {
    isUploadVod = true;
  }

  return isUploadVod;
}

const upload = async () => {
  const taskID = workerData.TaskID;
  const requestID = workerData.RequestID;
  // 1. update config
  if (process.env.COS_CONF) {
    const cosConf = JSON.parse(process.env.COS_CONF);
    if (!cosConf.region) {
      cosConf.region = config.region || 'ap-chengdu';
    }
    config.cos = cosConf;
  }

  // 2. update taskinfo
  let ti = {};
  try {
    ti = await redisHelper.updateTaskInfo(redisHelper.getTaskInfoKey(taskID), {
      Status: 'upload',
      InvokedRequestID: requestID,
    });
  } catch (err) {
    if (err.message && err.message.includes('update status failed')) {
      await removeHeartbeat('upload', taskID, requestID, parentPort, null, 'status-change-failed');
      return err;
    }
  }

  // 3. upload videos
  const videoDir = path.join(config.videoRootDir, taskID);
  const videoTranscodedDir = path.join(videoDir, 'transcoded');
  let ok = true;
  const errors = [];
  const videos = [];
  const vodVideos = [];
  let cos = new COS({
    SecretId: process.env.TENCENTCLOUD_SECRETID,
    SecretKey: process.env.TENCENTCLOUD_SECRETKEY,
    SecurityToken: process.env.TENCENTCLOUD_SESSIONTOKEN,
    Timeout: 60000,
  });

  // 4.处理vod上传场景
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
  logger.log('secret id', secretId);
  const vodClient = new VodClientWrapper(config.region, secretId, secretKey, token);

  let vodBucket = null;
  let vodRegion = null;
  let mediaStoragePath = null;

  const uploadVod = isUploadVod(ti);

  if (uploadVod) {
    // vod申请上传
    let vodRequest = vodUploadRequest(ti);
    let applyUploadResponse = await vodClient.applyVodUpload(vodRequest);
    logger.log('vod apply upload response', applyUploadResponse);

    vodClient.setVodSessionKey(applyUploadResponse.VodSessionKey);
    vodClient.setSubAppId(vodRequest.SubAppId || null);

    if (applyUploadResponse.TempCertificate != null) {
      cos = new COS({
        Timeout: 60000,
        SecretId: applyUploadResponse.TempCertificate.SecretId,
        SecretKey: applyUploadResponse.TempCertificate.SecretKey,
        XCosSecurityToken: applyUploadResponse.TempCertificate.Token,
      });
    }

    vodBucket = applyUploadResponse.StorageBucket;
    vodRegion = applyUploadResponse.StorageRegion;
    mediaStoragePath = applyUploadResponse.MediaStoragePath;
  }

  const uploadFunc = async (filename, fileFormat) => {
    const fp = path.join(videoTranscodedDir, filename);
    try {
      await new Promise((resolve, reject) => {
        logger.log('cos upload begin...fp', fp);

        // 确定bucket参数值
        let { bucket } = config.cos;
        let cosParam = {};
        let muxer = 'mp4';
        let videoParam = {};
        if (ti['Param'] && ti['Param']['Output']) {
          const taskOutPutInfo = ti['Param']['Output'];
          if (taskOutPutInfo['Cos']) {
            cosParam = taskOutPutInfo['Cos'];
          }
          if (taskOutPutInfo['Video']) {
            videoParam = taskOutPutInfo['Video'];
          }
        }
        let region = (cosParam && cosParam.Region) || config.cos.region || config.region;
        if (videoParam && videoParam.Muxer) {
          muxer = videoParam.Muxer;
        }
        if (cosParam && cosParam.Bucket) {
          bucket = cosParam.Bucket;
        }

        // 确定上传文件的key
        const dir = cosParam.TargetDir || taskID;
        let fn = filename;
        if (cosParam.TargetName && muxer === 'mp4') {
          fn = cosParam.TargetName + path.extname(fp);
        }
        let key = path.join(dir, fn);

        // vod场景下bucket信息
        if (vodBucket && vodRegion) {
          region = vodRegion;
          bucket = vodBucket;
          let vodTargetDir = path.dirname(mediaStoragePath);
          if (muxer === 'mp4') {
            key = mediaStoragePath;
            fn = path.basename(mediaStoragePath);
          } else {
            if (path.extname(fn) === '.m3u8') {
              key = mediaStoragePath;
            } else {
              key = path.join(vodTargetDir, fn);
            }
          }
        }

        logger.log('final cos param: bucket %s, region %s, key %s, fp %s', bucket, region, key, fp);
        cos.sliceUploadFile(
          {
            Bucket: bucket,
            Region: region,

            Key: key,
            FilePath: fp,
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
              if (path.extname(fp) === '.ts') {
                resolve();
                return;
              }
              const fsStat = fs.statSync(fp);
              let fileURL = 'http://' + data.Location;
              const domain = cosParam.Domain || config.cos.domain;
              if (domain) {
                fileURL = 'http://' + path.join(domain, key);
              }

              // 优先从视频的stream info中获取视频时长，若获取失败，则通过StopTime-StartTime来计算
              let duration = await getVideoDuration({ file: fp });
              if (!duration) {
                logger.log('got duration by calulation');
                duration = ti.StopTime - ti.StartTime;
              }

              // fullfilled video info
              const video = {
                Filename: fn,
                FileSize: fsStat.size,
                FileDuration: duration,
                FileURL: fileURL,
              };

              // 如果上传vod，vod确认上传后再存进videos
              // 如果上传cos,将video信息存进videos
              if (vodBucket) {
                logger.log('push video to vodVideos, video: ', video);
                vodVideos.push(video);
              } else {
                videos.push(video);
                logger.log('cos upload file succ, fp', fp, 'data', data, 'video', video);
              }
              resolve();
            }
          },
        );
      });
    } catch (err) {
      ok = false;
      errors.push(JSON.stringify(err));
      logger.log('[Error]cos upload file failed, fp', fp, 'err', err);
    }
  };

  // cos中间存储方式下videos信息，上传在cos-transcode-worker中完成，这里只封装video信息
  let { bucket } = config.cos;
  let cosUploadExist = false;
  let targetDir = taskID;
  let domain = '';
  const cosParam = ti.Param.Output ? ti.Param.Output.Cos : {};
  const tempData = ti.TempData ? ti.TempData : {};
  if (cosParam && cosParam.Bucket) {
    bucket = cosParam.Bucket;
  }
  if (cosParam && cosParam.TargetDir) {
    targetDir = cosParam.TargetDir;
  }
  if (cosParam && cosParam.Domain) {
    domain = cosParam.Domain;
  }
  const region = (cosParam && cosParam.Region) || config.cos.region || config.region;
  const storageType = ti.StorageType || 'cfs';
  if (storageType === 'cos') {
    // 如果返回了vod媒体信息，将vod媒体信息存入videos
    if (uploadVod) {
      if ('Result' in ti && 'VodMedia' in ti.Result) {
        let duration = ti.StopTime - ti.StartTime;
        let video = {
          FileId: ti.Result['VodMedia']['FileId'],
          Filename: ti.Result['VodMedia']['Filename'],
          FileSize: ti.Result['VodMedia']['FileSize'],
          FileDuration: duration,
          FileURL: ti.Result['VodMedia']['FileURL'],
        };
        logger.log('vod media info', video);
        videos.push(video);
        cosUploadExist = true;
      }
    } else {
      let distFileName = '';
      if (tempData && tempData.DistFileName) {
        distFileName = tempData.DistFileName;
      }
      // 处理targetDir检查首位是否存在'/'
      if (targetDir.startsWith('/')) {
        targetDir = targetDir.substr(1);
      }

			// check目标文件是否存在，并返回文件大小
			let uploadKey = `${targetDir}/${distFileName}`;
			logger.log(`DistInfo: ${uploadKey}`);

			const distData = await cos.headObject({
				Bucket: bucket,
				Region: region,
				Key: uploadKey,
			});
			logger.log(`head object data: ${JSON.stringify(distData, null, 4)}`);

			if (distData.statusCode === 200) {
				cosUploadExist = true;
				const urlRes = await new Promise((resolve, reject) =>
					cos.getObjectUrl(
						{
							Bucket: bucket,
							Region: region,
							Key: uploadKey,
							Sign: false,
						},
						(err, data) => {
							if (err) {
								reject(err);
							}
							resolve(data);
						},
					),
				);

				let duration = 0;
				if (!duration) {
					logger.log("got duration by calulation");
					duration = ti.StopTime - ti.StartTime;
				}
				let fileUrl = urlRes.Url;
				if (domain !== "") {
					fileUrl = "http://" + path.join(domain, uploadKey);
				}
				const video = {
					Filename: path.basename(uploadKey),
					FileSize: parseInt(distData.headers['content-length']),
					FileDuration: duration,
					FileURL: fileUrl,
				};

				console.log("Get cos video:", video);
				videos.push(video);
			}
    }
  }

  // cfs中间存储方式上传录制文件并封装video信息
  // cos中间存储方式只封装video信息
  try {
    const dirExist = fs.existsSync(videoTranscodedDir);
    if (!dirExist && !cosUploadExist) {
      logger.log('transcoded dir not exist, no need to upload');
      const data = {
        Status: 'callback',
        Result: {
          Videos: [],
        },
      };
      await invokeCallback('upload', taskID, requestID, data);
      await removeHeartbeat('upload', taskID, requestID, parentPort, null, 'file not found');
      return;
    }

    if (dirExist) {
      const files = fs.readdirSync(videoTranscodedDir);
      for (let i = 0; i < files.length; i++) {
        await uploadFunc(files[i]);
        if (!ok) {
          logger.log('upload failed with errors:', errors);

          // update taskinfo & invoke scf:callback
          const data = {
            Status: 'callback',
            Result: {
              ErrorCode: 'InternalError',
              ErrorMessage: 'video upload failed',
            },
          };
          await invokeCallback('upload', taskID, requestID, data);
          await removeHeartbeat(
            'upload',
            taskID,
            requestID,
            parentPort,
            null,
            'video upload failed',
          );

          return;
        }
      }

      // vod上传场景
      if (vodVideos.length !== 0) {
        // step1：上传完成后确认上传
        let uploadCommitResponse = await vodClient.commitVodUpload(
          vodClient.getVodSessionKey(),
          vodClient.getSubAppId(),
        );
        logger.log('cfs storage type, uploadCommitResponse: ', uploadCommitResponse);
        if (uploadCommitResponse) {
          let describeMediaResponse = null;
          let retryTimes = 5;
          // 等待3s再查询，避免vod媒体数据还没落盘
          await vodClient.wait(3000);
          while (retryTimes > 0) {
            try {
              describeMediaResponse = await vodClient.describeMediaInfo(
                uploadCommitResponse.FileId,
                vodClient.subAppId,
              );
              if (
                describeMediaResponse &&
                describeMediaResponse.MediaInfoSet.length > 0 &&
                describeMediaResponse.MediaInfoSet[0]['MetaData']
              ) {
                break;
              }
              throw new Error('describeMediaInfo: try again...');
            } catch (e) {
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
            const size = describeMediaResponse.MediaInfoSet[0]['MetaData']
              ? describeMediaResponse.MediaInfoSet[0]['MetaData']['Size']
              : 0;
            const duration = describeMediaResponse.MediaInfoSet[0]['MetaData']
              ? describeMediaResponse.MediaInfoSet[0]['MetaData']['Duration']
              : 0;
            const vodMedia = {
              FileId: uploadCommitResponse.FileId,
              Filename: path.basename(uploadCommitResponse.MediaUrl),
              FileSize: size,
              FileDuration: duration,
              FileURL: uploadCommitResponse.MediaUrl,
            };
            videos.push(vodMedia);
            logger.log('commit upload finished, vodMedia: ', vodMedia);
          }
        }
      }
    }
  } catch (err) {
    logger.log('[Error]files handling failed, err', err);

    // update taskinfo & invoke scf:callback
    const data = {
      Status: 'callback',
      Result: {
        ErrorCode: 'InternalError',
        ErrorMessage: 'video upload failed(' + err.message + ')',
      },
    };
    await invokeCallback('upload', taskID, requestID, data);
    await removeHeartbeat('upload', taskID, requestID, parentPort, null, 'video upload failed');

    return;
  }

  // 4. update taskinfo
  try {
    ti = await redisHelper.updateTaskInfo(redisHelper.getTaskInfoKey(taskID), {
      Status: 'callback',
      FinishTime: Math.round(new Date().getTime() / 1000),
      Result: {
        Videos: videos,
      },
    });

    for (const index in videos) {
      logger.updateOnetimeIndex('ReplayURL', videos[index].FileURL);
      logger.updateOnetimeIndex('TaskDuration', videos[index].FileDuration);
      logger.log('replay url');
    }
  } catch (err) {
    logger.log('updateTaskInfo err', err);
    if (err.message && err.message.includes('update status failed')) {
      await removeHeartbeat('upload', taskID, requestID, parentPort, null, 'status-change-failed');
      return err;
    }
    // todo what to do with err
  }

  // 5. invoke scf:callback & update taskinfo
  await invokeCallback('upload', taskID, requestID, null);
  await removeHeartbeat('upload', taskID, requestID, parentPort, null, 'status-change');
};

async function worker() {
  logger.updatePermanentIndex('TaskID', workerData.TaskID);
  logger.updatePermanentIndex('Version', config.version);
  logger.log('upload worker begin with workerData', workerData);
  await upload();
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
