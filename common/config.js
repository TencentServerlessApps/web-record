// 应用全局配置
// 需要将用户可配置参数提炼为环境变量方式
const pkg = require('./package.json');
const { SLS_APP_NAME } = process.env;

module.exports = {
  // 运行环境，默认为 prod
  env: process.env.ENV || 'prod',

  // TODO: 升级项目代码后，需要更新此版本号，保持与 package.json 中 version 一致
  version: process.env.APP_VERSION || pkg.version || '1.0.0',

  videoRootDir: process.env.VIDEO_ROOT_DIR || '/mnt/videos',
  heartbeatInterval: process.env.HEARTBEAT_INTERVAL || 3000, // 单位ms
  maxRecordDurationLimit:
    process.env.MAX_RECORD_DURATION_LIMIT > 72 * 3600
      ? 72 * 3600
      : process.env.MAX_RECORD_DURATION_LIMIT || 36000, // 单位s, 最大72小时，默认10小时
  maxWidth: process.env.MAX_WIDTH || 2560,
  maxHeight: process.env.MAX_HEIGHT || 2560,

  allowVideoFormat: { mp4: 1, hls: 1 },
  tmpDir: '/tmp/',
  hlsEncryptKeyInfoFile: 'enc.keyinfo',
  hlsEncryptKeyFile: 'enc.key',
  
  // 每个task心跳异常最大重试次数, diagnose函数可通过环境变量更改
  maxRetryNum: process.env.MAX_RETRY_NUM || 20,
  // 从环境变量中读取 redis 配置
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    auth: process.env.REDIS_AUTH || '',
    index: process.env.REDIS_INDEX || 0,
  },

  // 当视频分片达到下述大小或时长时，开始上传
  recordUploadSliceDuration: process.env.RECORD_UPLOAD_SLICE_DURATION || 5000, // 5000 ms, 5 second
  recordUploadSliceSize: process.env.RECORD_UPLOAD_SLICE_SIZE || 5 * 1024 * 1024, // 5 MB, about 20 second when 2000kbps
  recordUploadRetryCount: process.env.RECORD_UPLOAD_RETRY_Count || 20, // retry 5 time
  recordUploadRetryWait: process.env.RECORD_UPLOAD_RETRY_WAIT || 1000, // wait 1000 ms before retry

  // 服务部署地域
  region: process.env.REGION || 'ap-guangzhou',

  // 同步、异步启动任何
  startMethod: process.env.START_METHOD || 'SYNC', // ASYNC,SYNC
  scf: {
    // capi 域名
    host: process.env.CAPI_HOST || 'scf.tencentcloudapi.com',

    // 函数名称由 serverless 应用名称拼接
    dispatchFunctionName: `${SLS_APP_NAME}-dispatch`,
    recordFunctionName: `${SLS_APP_NAME}-record`,
    transcodeFunctionName: `${SLS_APP_NAME}-transcode`,
    uploadFunctionName: `${SLS_APP_NAME}-transcode`,
    PostUploadFunctionName: `${SLS_APP_NAME}-upload`,
    callbackFunctionName: `${SLS_APP_NAME}-callback`,
  },
  cos: {
    // 过滤 undefined 字符串
    domain: process.env.CDN_DOMAIN === 'undefined' ? '' : process.env.CDN_DOMAIN,
    bucket: process.env.COS_BUCKET === 'undefined' ? '' : process.env.COS_BUCKET,
    bucketRaw: process.env.COS_BUCKET_RAW === 'undefined' ? '' : process.env.COS_BUCKET_RAW,
  },
};
