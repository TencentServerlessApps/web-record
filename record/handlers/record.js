const puppeteer = require('puppeteer-extra');
const Xvfb = require('xvfb');
const path = require('path');
const fs = require('fs');
const COS = require('cos-nodejs-sdk-v5');
const {
  scf,
  config,
  redisHelper,
  logger,
  initLockWorker,
  invokeCallback,
  removeHeartbeat,
} = require('common');
const uuid = require('uuid');

const {Worker} = require('worker_threads');
const fileTools = require("../handlers/fileUtils");
const { Duplex } = require('stream');
const {errors} = require("puppeteer-core");
const util = require("util");

const extensionId = 'bikcfikccnghpbmekfbjneljehgaploj';

let lockWorker = null;
let heartbeatWorker = null;
let controlWorker = null;
let backgroundPage = null;
let lock = null;
let xvfb = null;
let browser = null;

function getSliceKey(taskID, requestTimestamp, sliceTimestamp) {
  return `raw/${taskID}/${requestTimestamp}/${sliceTimestamp}.webm`;
}

function getBucketRegion(taskInfo, raw = false) {
  let {bucket} = config.cos;
  const cosParam =
      taskInfo && taskInfo.Param && taskInfo.Param.Output && taskInfo.Param.Output.Cos
          ? taskInfo.Param.Output.Cos
          : {};
  if (cosParam.Bucket) {
    bucket = cosParam.Bucket;
  }
  let region = cosParam.Region || config.cos.region || config.region;

  if (raw) {
    let bucketRaw = process.env.COS_BUCKET_RAW === 'undefined' ? '' : process.env.COS_BUCKET_RAW;
    let bucketRawRegion = process.env.COS_BUCKET_RAW_REGION === 'undefined' ? '' : process.env.COS_BUCKET_RAW_REGION;
    bucket = bucketRaw || bucket;
    region = bucketRawRegion || region;
  }

  return {bucket, region};
}

function str2ab(str) {
  // Convert a UTF-8 String to an ArrayBuffer
  var buf = new ArrayBuffer(str.length); // 1 byte for each char
  var bufView = new Uint8Array(buf);
  for (var i = 0, strLen = str.length; i < strLen; i++) {
    bufView[i] = str.charCodeAt(i);
  }
  return buf;
}
async function cleanup() {
  logger.log('cleanup...');

  if (lockWorker) {
    lockWorker.terminate();
    lockWorker = null;
    logger.log('terminate lockWorker');
  }

  // terminate heartbeat worker
  if (heartbeatWorker) {
    heartbeatWorker.terminate();
    heartbeatWorker = null;
    logger.log('terminate heartbeatWorker');
  }

  if (xvfb) {
    xvfb.stopSync();
    xvfb = null;
    logger.log('stop xvfb');
  }

  if (controlWorker) {
    controlWorker.terminate();
    controlWorker = null;
    logger.log('terminate controlWorker');
  }
  if (browser) {
    await browser.close();
    browser = null;
    logger.log('close browser');
  }

  if (lock && lock.unlock) {
    logger.log('unlock recording lock');
    try {
      await lock.unlock();
      lock = null;
    } catch (err) {
      logger.log('unlock err', err);
    }
  }

  // puppeteer会写/tmp目录，云函数实例本地/tmp默认只有512M，
  // 所以需要在录制函数结束的时候把实例/tmp做清理，
  // 避免后续函数调用落到同一个实例的时候出现磁盘满的情况，导致录制失败
  logger.log('clear /tmp directory');
  const tmpDir = '/tmp';
  const files = fs.readdirSync(tmpDir);
  for (const file of files) {
    try {
      if (file.startsWith('core') || file.startsWith('puppeteer')) {
        const filePath = path.join(tmpDir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          fs.rmdirSync(filePath, {recursive: true});
        } else {
          fs.unlinkSync(filePath);
        }
      }
    } catch (err) {
      logger.log('unlink err,', err);
    }
  }

  redisHelper.close();
}

const recorder = {};
recorder.run = async (event, requestID) => {
  let res = 'OK';
  const taskID = event['TaskID'];

  logger.updatePermanentIndex('TaskID', taskID);

  logger.updateOnetimeIndex('Action', 'record');
  logger.log('[Report]task action event: record');

  try {
    const tiStr = await redisHelper.getString(redisHelper.getTaskInfoKey(taskID));
    const taskInfo = JSON.parse(tiStr);
    switch (taskInfo['Status']) {
      case 'normal':
      case 'recording':
      case 'paused':
        await recorder.record(taskInfo, requestID);
        break;
      case 'canceled':
        await recorder.invokeTranscode(taskInfo, requestID, null);
        break;
      default:
        logger.log(`[Error]invalid status, cant perform recording in state ${taskInfo['Status']}`);
        break;
    }
  } catch (err) {
    logger.log('[Error]run exception', err);
    // todo what to do with err
    res = 'record failed with err: ' + err.message;
    // 如果出现不可恢复错误，直接结束录制
    if (err.message.includes('net::ERR_ABORTED')) {
      const data = {
        Status: 'callback',
        Result: {
          ErrorCode: 'InternalErr',
          ErrorMessage: 'invalid RecordURL or unsupported RecordURL, please check again',
        },
      };
      await invokeCallback('record', taskID, requestID, data);
      await removeHeartbeat('record', taskID, requestID, heartbeatWorker, null, 'net::ERR_ABORTED');
    }
  }

  await cleanup();

  return res;
};

recorder.record = async (taskInfo, requestID) => {
  logger.log('invoke scf:record with taskinfo:', taskInfo);

  // 0. active heartbeat worker
  const taskID = taskInfo['TaskID'];
  heartbeatWorker = new Worker(path.join(__dirname, 'heartbeat.js'), {
    workerData: {TaskInfo: taskInfo, RequestID: requestID},
  });
  heartbeatWorker
      .once('online', () => {
        logger.log('recording heartbeat worker ready');
      })
      .once('error', (err) => {
        logger.log('[Error]recording heartbeat worker err', err);
      })
      .once('exit', (code) => {
        logger.log('recording heartbeat worker exit code', code);
      });

  // 1. update taskinfo
  try {
    // 只有状态为normal的时候才需要将状态更新为recording
    if (taskInfo.Status == 'normal') {
      taskInfo = await redisHelper.updateTaskInfo(redisHelper.getTaskInfoKey(taskID), {
        InvokedRequestID: requestID,
        Status: 'recording',
      });
    }
  } catch (err) {
    if (err.message && err.message.includes('update status failed')) {
      await removeHeartbeat(
          'record',
          taskID,
          requestID,
          heartbeatWorker,
          null,
          'status-change-failed',
      );

      throw err;
    }
    // todo what to do with err
  }

  // 2. start record
  let width = taskInfo.Param.Width;
  if (!width) {
    width = 1280;
  }
  let height = taskInfo.Param.Height;
  if (!height) {
    height = 720;
  }
  const whd = width + 'x' + height + 'x24';

  const displayNum = Math.floor(Math.random() * 100);
  logger.log('now display number %d', displayNum);
  xvfb = new Xvfb({
    silent: false,
    displayNum: displayNum,
    reuse: false,
    xvfb_args: ['-screen', '0', whd],
  });

  // 同步调用会把xvfb启动失败的错误日志吞掉，重新切换为异步调用
  await new Promise((resolve, reject) => {
    xvfb.start((err) => {
      if (err) {
        logger.log('xvfb start failed, err', err);
        reject(err);
      } else {
        logger.log('xvfb start succ');
        resolve(0);
      }
    });
  });

  let storageType = taskInfo.Param.StorageType;
  logger.log(`Storage type start is ${storageType}`);
  if (!storageType || (storageType != 'cfs' && storageType != 'cos')) {
    if (process.env.CFS_ID && process.env.CFS_ID != 'undefined') {
      storageType = 'cfs';
    } else {
      storageType = 'cos';
    }
  }
  const videoDir = path.join(config.videoRootDir, taskID, 'raw');
  if (storageType == 'cfs') {
    fs.mkdirSync(videoDir, {recursive: true});
    puppeteer.use(
        require('puppeteer-extra-plugin-user-preferences')({
          userPrefs: {
            download: {
              prompt_for_download: false,
              open_pdf_in_system_reader: true,
              default_directory: videoDir,
            },
            plugins: {
              always_open_pdf_externally: true,
            },
          },
        }),
    );
  }
  // cos方式本地缓存webm片段
  const webmDir = path.join('/tmp', taskID, 'raw');
  if (storageType === 'cos') {
    fs.mkdirSync(webmDir, { recursive: true });
  }

  const pathToExtension = path.join(__dirname, '..', 'extension');
  const pageTitle = taskInfo.Param.PageTitle;
  const args = [
    `--whitelisted-extension-id=${extensionId}`,
    `--disable-extensions-except=${pathToExtension}`,
    `--load-extension=${pathToExtension}`,
    // '--use-fake-device-for-media-stream',   // should comment this in non headless mode
    // '--use-fake-ui-for-media-stream',    // should comment this in non headless mode
    '--allow-hidden-media-playback',
    '--autoplay-policy=no-user-gesture-required', // autoplay always allowed
    '--no-sandbox',
    '--disable-infobars', // 禁止页面顶部显示提示栏
    '--hide-scrollbars', // 隐藏滚动条

    '--allow-http-screen-capture', // 允许屏幕采集
    `--auto-select-desktop-capture-source=${pageTitle}`, // 使用getDisplayMedia的时候自动选择指定Title的tab

    '--ignore-certificate-errors',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    `--window-size=${width},${height + 100}`,
    '--start-fullscreen',

    '--force-device-scale-factor=1.0',
    // '--font-render-hinting=none', // 保证字体字间距一致, 只有headless模式生效
  ];

  if (config.env == 'local') {
    args.push(
        '--remote-debugging-port=9227',
        '--remote-debugging-address=0.0.0.0',
        '--user-data-dir=/var/chrome/',
    );
  }

  browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: args,
    executablePath: '/usr/local/google/chrome/chrome',
    // executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });

  // 监听disconnected事件，在收到此事件时，表明puppeteer与chrome的websocket连接断开了，大概率是chrome已经异常退出了，
  // 这种情况会导致disconnected发生之后的视频内容都不会被录制。由于这种情况概率比较小，所以这里在收到事件的时候直接退出当前录制函数，
  // 由diagnose的保活逻辑重新拉起录制函数进行后续的录制。
  // 另外，由于diagnose的间隔是30s，再加上录制函数的启动时间，所以出现这种情况的时候，最坏的情况是录制内容会丢30s以上。所以后面
  // 有客户反馈相关问题的时候可以先确认一下是否这里的逻辑导致的。
  // 后续有时间可以考虑将这里的逻辑重构为不退出录制函数，而重新拉起chrome，并进行初始化继续后续的录制。
  browser.on('disconnected', async () => {
    logger.log('[Error]puppeteer has been disconnected from browser, exit record function now')
    browser = null;

    // 避免 cleanup 异常导致死循环
    try {
      await cleanup();
    } catch (err) {
      logger.log(`[Error]clean up error: ${err}`);
    }
  })

  const backgroundPageTarget = await new Promise((resolve) => {
    var targets = browser.targets();
    const target = targets.find((t) => t.type() === 'background_page');
    if (target) {
      return resolve(target);
    }
    const listener = (t) => {
      logger.log('target in listener: ', t);
      if (t.type() === 'background_page') {
        browser.removeListener('targetcreated', listener);
        browser.removeListener('targetchanged', listener);
        resolve(t);
      }
    };
    browser.on('targetcreated', listener);
    browser.on('targetchanged', listener);
  });
  backgroundPage = await backgroundPageTarget.page();
  backgroundPage.on('console', (msg) => {
    for (let i = 0; i < msg.args().length; i++) {
      logger.log(`backgroundPage ${i}: ${msg.args()[i]}`);
    }
  });
  backgroundPage.on('pageerror', (msg) => {
    logger.log('[Error]backgroundPage pageerror', msg);
  });
  backgroundPage.on('error', (msg) => {
    logger.log('[Error]backgroundPage error', msg);
  });

  const url = taskInfo['Param']['RecordURL'];
  const page = await browser.newPage();
  const userAgent =
    taskInfo.Param.Headers && taskInfo.Param.Headers.UserAgent
      ? taskInfo.Param.Headers.UserAgent
      : null;
  if (userAgent) {
    await page.setUserAgent(userAgent);
  }

  page.on('console', (msg) => {
    for (let i = 0; i < msg.args().length; i++) {
      logger.log(`recordPage ${i}: ${msg.args()[i]}`);
    }
  });
  page.on('pageerror', (msg) => {
    logger.log('[Error]recordPage pageerror', msg);
  });
  page.on('error', (msg) => {
    logger.log('[Error]recordPage error', msg);
  });

  const promises = [];
  let checkRecordFlag = true; // 校验webm片段flag

  const cos = new COS({
    Timeout: 60000,
    SecretId: process.env.TENCENTCLOUD_SECRETID,
    SecretKey: process.env.TENCENTCLOUD_SECRETKEY,
    SecurityToken: process.env.TENCENTCLOUD_SESSIONTOKEN,
  });

  async function uploadSlice(key, buffer, forceCheckRecord) {
    const {bucket, region} = getBucketRegion(taskInfo, true);

    // 根据配置重试若干次
    for (let i = 0; i < config.recordUploadRetryCount; i++) {
      try {
        const res = await cos.putObject({
          Key: key,
          Bucket: bucket,
          Region: region,
          Body: buffer,
        });

        if (res.statusCode == 200) {
          logger.log('upload record video slice to cos success:', key);
          break;
        }
      } catch (err) {
        logger.log('[Error]upload record video slice to cos error:', key);
        if (i + 1 == config.recordUploadRetryCount) {
          logger.log('[Error]upload record video slice to cos failed:', key);
          console.log(process.env);
          throw err;
        }
      }

      // 失败时，等待一段时间再重试
      await new Promise((resolve) => setTimeout(resolve, config.recordUploadRetryWait * i));
    }

    // 强制check webm文件是否正常
    // 通过可选环境变量FORCE_CHECK_RECORD指定是否开启
    // 开启后如果webm片段解析EBML异常，直接抛出异常结束录制
    if (forceCheckRecord) {
      try {
        const fileName = path.basename(key);
        const fp = path.join(webmDir, fileName);
        logger.log('saving webm data to file', fp);
        fs.appendFileSync(fp, buffer);
        const ebmlNormal = await fileTools.webmParse({ file: fp });
        logger.debug(`webmEBML parsed normal[${ebmlNormal}], delete file: ${fp}`);
        fs.unlinkSync(fp);
        if (!ebmlNormal) {
          // 如果webm不正常，直接callback
          logger.log(`[Error]parseWebmEBML err. Parse webm[${key}] error`);
          throw `Webm[${key}] is abnormal`;
        }
      } catch (err) {
        logger.log('check webm err:', err);
        // 停止录制
        // send stop signal
        const stopSignalKey = redisHelper.getCtrlSignalKey(taskID);
        await redisHelper.rpush(stopSignalKey, redisHelper.CtrlSignalStop);
        logger.log('send stop signal succ:', stopSignalKey);
        checkRecordFlag = false;
      }
    }
  }

  let bufferList = [];
  let bufferSize = 0;
  let sliceStartTs = Date.now();
  const requestStartTs = Date.now();
  const fn = Date.now() + '.webm';
  let uploadSliceCount = 0; // 上传webm片段计数
  // 1、storageType=cos ，但是只有一个cos的场景吗。这个情况如果没有cos_bucket_raw, 就写到cos_backet， 如果cos_bucket不存在就报错;
  // 2、storageType=cfs，没有cfs环境变量就报错;
  // 3、不传或非cfs ，cos的stroageType，先看cfs在不在，不存在再看cos。 如果没有cos_bucket_raw, 就写到cos_backet， 如果cos_bucket不存在就报错;
  if (storageType == 'cfs') {
    if (!process.env.CFS_ID || process.env.CFS_ID == 'undefined') {
      logger.log('[Error]storageType = cfs, but cfs environment is empty');
      throw "storageType = cfs, but environment is empty";
    }
  } else {
    if (!config.cos.bucket && !config.cos.bucketRaw) {
      logger.log('[Error]storageType = cos, but cos environment is empty');
      throw "storageType = cos, but cos environment is empty";
    }
  }
  try {
    await backgroundPage.exposeFunction('sendData', (data) => {
      if (storageType == 'cfs') {
        const fp = path.join(videoDir, fn);
        const p = (async () => {
          try {
            const content = Buffer.from(str2ab(data));
            // 添加写入日志
            logger.log('saving video data to file', fp);
            fs.appendFileSync(fp, content);
          } catch (err) {
            logger.log('saving video data to file', fp, 'failed, err', err);
          }
        })();
        promises.push(p);
      } else {
        const content = Buffer.from(str2ab(data));
        bufferList.push(content);
        bufferSize += content.byteLength;
        logger.debug(
          `[sendData][to]------------------------data size: ${bufferSize}, time: ${Date.now()}`,
        );
        // 当尺寸或时长大于阈值时，上传
        if (
          bufferSize > config.recordUploadSliceSize ||
          Date.now() - sliceStartTs > config.recordUploadSliceDuration
        ) {
          uploadSliceCount += 1;
          logger.debug(`uploadSliceCount: ${uploadSliceCount}`);
          const key = getSliceKey(taskID, requestStartTs, sliceStartTs);
          // 只校验第一个webm片段格式
          let forceCheckRecord = false;
          if (process.env.FORCE_CHECK_RECORD && uploadSliceCount === 1) {
            forceCheckRecord = true;
          }
          const buffer = Buffer.concat(bufferList);
          bufferSize = 0;
          bufferList = [];
          sliceStartTs = Date.now();
          const p = uploadSlice(key, buffer, forceCheckRecord);
          promises.push(p);
        }
      }
    });
  } catch (err) {
    if (!(err.message && err.message.includes('already exists'))) {
      logger.log('expose function to backgroup page failed, err ', err);
    }
  }

  // 注册方法到页面window
  let isRecordStarted = false;
  let startTime = 0;
  try {
    // 开始录制方法
    await page.exposeFunction('startRecord', async (cb) => {
      // handle start record
      logger.updateOnetimeIndex('Action', 'startRecordByPageCalling');
      logger.log('[Report]task action event, startRecordByPageCalling');
      if (backgroundPage) {
        try {
          await backgroundPage.evaluate(
              (tID, recUrl) => {
                // eslint-disable-next-line no-undef
                startRecording(tID, recUrl);
                return Promise.resolve(0);
              },
              taskID,
              url,
          );
          if (cb) {
            cb();
          }

          startTime = Math.round(new Date().getTime() / 1000);
          isRecordStarted = true;
        } catch (err) {
          console.log(`startRecord catched err ${err}`);
          if (cb) {
            cb(err);
          }
        }
      }
    });
  } catch (err) {
    if (!(err.message && err.message.includes('already exists'))) {
      logger.log('expose function to backgroup page failed, err ', err);
    }
  }

  try {
    // 暂停录制方法, 调用暂停后，需要通过恢复录制方法重新恢复录制
    await page.exposeFunction('pauseRecord', async (cb) => {
      // handle pause record
      logger.updateOnetimeIndex('Action', 'pauseRecordByPageCalling');
      logger.log('[Report]task action event, pauseRecordByPageCalling');
      if (backgroundPage) {
        try {
          await backgroundPage.evaluate(() => {
            // eslint-disable-next-line no-undef
            pauseRecording();
            return Promise.resolve(0);
          });
          if (cb) {
            cb();
          }
        } catch (err) {
          console.log(`pauseRecord catched err ${err.message}`);
          if (cb) {
            cb(err);
          }
        }
      }
    });
  } catch (err) {
    if (!(err.message && err.message.includes('already exists'))) {
      logger.log('expose function to backgroup page failed, err ', err);
    }
  }

  try {
    // 恢复录制方法
    await page.exposeFunction('resumeRecord', async (cb) => {
      // handle resume record
      logger.updateOnetimeIndex('Action', 'resumeRecordByPageCalling');
      logger.log('[Report]task action event, resumeRecordByPageCalling');
      if (backgroundPage) {
        try {
          await backgroundPage.evaluate(
              (tid, recURL) => {
                // eslint-disable-next-line no-undef
                resumeRecording(tid, recURL);
                return Promise.resolve(0);
              },
              taskID,
              url,
          );
          if (cb) {
            cb();
          }
        } catch (err) {
          console.log(`resumeRecord catched err ${err.message}`);
          if (cb) {
            cb(err);
          }
        }
      }
    });
  } catch (err) {
    if (!(err.message && err.message.includes('already exists'))) {
      logger.log('expose function to backgroup page failed, err ', err);
    }
  }

  try {
    // 刷新页面方法
    await page.exposeFunction('refreshPage', async (cb) => {
      logger.updateOnetimeIndex('Action', 'refreshPageByPageCalling');
      logger.log('[Report]task action event, refreshPageByPageCalling');
      try {
        // handle refresh page
        await page.evaluate(() => {
          // eslint-disable-next-line no-undef
          if (window && window.location) {
            // eslint-disable-next-line no-undef
            window.location.reload();
          }
        });
        if (cb) {
          cb();
        }
      } catch (err) {
        // 短时间内多次refresh，如果页面reload还没有完成，evaluate会出现context不存在的异常
        // 这里可以忽略这种异常
        if (!err.message.includes('Execution context was destroyed')) {
          logger.log('[Error]refresh failed, err', err);
          if (cb) {
            cb(err);
          }
        } else {
          if (cb) {
            cb();
          }
        }
      }
    });
  } catch (err) {
    if (!(err.message && err.message.includes('already exists'))) {
      logger.log('expose function to backgroup page failed, err ', err);
    }
  }

  // 加锁，防止当前操作被多个函数执行，
  // 如果加锁失败，表示可能存在其他函数在执行当前操作，此函数先退出
  try {
    lockWorker = await initLockWorker('record', taskID);
  } catch (err) {
    // remove record heartbeat
    logger.debug(`get-lock-failed`);
    await removeHeartbeat('record', taskID, requestID, heartbeatWorker, null, 'get-lock-failed');

    Promise.reject(err);
    return;
  }

  // 等待页面加载完成（window.onload事件）
  logger.debug(`wait page loaded, timeout: 60000`);
  await page.goto(url, {
    waitUntil: 'load',
    timeout: 60000,
  });
  // 设置了环境变量，设置自适应size
  if (!process.env.DISABLE_VIEWPORT) {
    logger.debug(`page setViewport, width: ${width}, height: ${height} `);
    await page.setViewport({ width: width, height: height });
  }
  logger.debug(`page not setViewport [width and height]`);

  // 新增一个worker_thread来监听录制控制信号
  let isRecordStopped = false;
  let stopTime = 0;
  controlWorker = new Worker(path.join(__dirname, 'control.js'), {
    workerData: {TaskID: taskID},
  });
  controlWorker.on('message', async (action) => {
    if (action == 'pause') {
      logger.log('receive pause signal');
      if (backgroundPage) {
        await backgroundPage.evaluate(() => {
          // eslint-disable-next-line no-undef
          pauseRecording();
        });
      }
    } else if (action == 'resume') {
      logger.log('receive resume signal');
      if (backgroundPage) {
        await backgroundPage.evaluate(
            (tid, recURL) => {
              // eslint-disable-next-line no-undef
              resumeRecording(tid, recURL);
            },
            taskID,
            url,
        );
      }
    } else if (action == 'stop') {
      logger.log('receive stop signal');
      if (backgroundPage) {
        logger.log('waiting recording stop...');
        await backgroundPage.evaluate(() => {
          // eslint-disable-next-line no-undef
          const totalCount = stopRecording();
          logger.log('recording stopped');
          return Promise.resolve(totalCount);
        });
      }

      isRecordStopped = true;
      stopTime = Math.round(new Date().getTime() / 1000);
      logger.log('stop signal handled');
    } else if (action == 'refresh') {
      logger.log('receive refresh signal');
      if (page) {
        logger.updateOnetimeIndex('Action', 'refreshByAPI');
        logger.log('[Report]task action event, refreshByAPI');
        try {
          await page.evaluate(() => {
            // eslint-disable-next-line no-undef
            if (window && window.location) {
              // eslint-disable-next-line no-undef
              window.location.reload();
            }
          });
        } catch (err) {
          // 短时间内多次refresh，如果页面reload还没有完成，evaluate会出现context不存在的异常
          // 这里可以忽略这种异常
          if (!err.message.includes('Execution context was destroyed')) {
            logger.log('[Error]refresh failed, err', err);
          }
        }
      }
    }
  });
  controlWorker
      .once('online', () => {
        logger.log('recording control worker ready');
      })
      .once('error', (err) => {
        logger.log('[Error]recording control worker err', err);
        throw err;
      })
      .once('exit', (code) => {
        logger.log('recording control worker exit code', code);
      });

  // if ManualStart is false, then auto start recording
  if (!taskInfo.Param.ManualStart && taskInfo.Status == 'recording') {
    logger.debug(`auto start record, time: ${Date.now()}`);
    try {
      await backgroundPage.evaluate(
          (tID, recUrl) => {
            // eslint-disable-next-line no-undef
            startRecording(tID, recUrl);
            return Promise.resolve(0);
          },
          taskID,
          url,
      );

      startTime = Math.round(new Date().getTime() / 1000);
      isRecordStarted = true;
    } catch (err) {
      logger.log('startRecording failed, err', err);
      throw err;
    }
  }

  // wait for recording start&stop
  await new Promise((resolve) => {
    let isFirstChange = true;
    // check if record has been started already every one second
    const obj = setInterval(async () => {
      if (isRecordStarted && isFirstChange) {
        isFirstChange = false;
        // 3. update taskinfo(StartTime)
        try {
          const data = {
            InvokedRequestID: requestID,
            StorageType: storageType,
          };

          if (!taskInfo['StartTime']) {
            data['StartTime'] = startTime || Math.round(new Date().getTime() / 1000);
            heartbeatWorker.postMessage({
              StartTime: data['StartTime'],
            });
          }

          await redisHelper.updateTaskInfo(redisHelper.getTaskInfoKey(taskID), data);
        } catch (err) {
          if (err.message && err.message.includes('update status failed')) {
            await removeHeartbeat(
                'record',
                taskID,
                requestID,
                heartbeatWorker,
                null,
                'status-change-failed',
            );

            throw err;
          }
          // todo what to do with err
        }
      }

      if (isRecordStopped) {
        // 5. update taskinfo(StopTime)
        logger.debug(`record stopped, time: ${Date.now()}`);
        try {
          await redisHelper.updateTaskInfo(redisHelper.getTaskInfoKey(taskID), {
            StopTime: stopTime || Math.round(new Date().getTime() / 1000),
          });
        } catch (err) {
          logger.log('update stop time failed, err', err);
          // todo what to do with err
        }
        resolve();
        clearInterval(obj);
      }
    }, 1000);
  });

  logger.log('waiting for upload and invoke transcode...');

  await Promise.all(promises);

  // 结束后，上传
  if (bufferSize > 0) {
    const key = getSliceKey(taskID, requestStartTs, sliceStartTs);
    const fp = path.join(webmDir, `${sliceStartTs}.webm`);
    await uploadSlice(key, Buffer.concat(bufferList), false);
  }

  logger.log('upload slice finished');

  // 6. invoke scf:transcode & update taskInfo & add heartbeat ts
  if (checkRecordFlag) {
    await recorder.invokeTranscode(taskInfo, requestID);
  } else {
    // 如果强制校验webm异常，直接结束录制并回调
    logger.log('[Error]parseWebmEBML. Stop record and callback');
    const data = {
      Status: 'callback',
      Result: {
        ErrorCode: 'InternalErr.WebmErr',
        ErrorMessage: '[Error]parseWebmEBML, please restart record',
      },
    };
    await invokeCallback('record', taskID, requestID, data);
    await removeHeartbeat('record', taskID, requestID, heartbeatWorker, null, '[Error]parseWebmEBML');
  }
};

recorder.invokeTranscode = async (taskInfo, oRequestID) => {
  const taskID = taskInfo['TaskID'];
  // 0. update taskinfo
  try {
    await redisHelper.updateTaskInfo(redisHelper.getTaskInfoKey(taskID), {
      Status: 'transcode',
    });
  } catch (err) {
    if (err.message && err.message.includes('update status failed')) {
      await removeHeartbeat(
          'record',
          taskID,
          oRequestID,
          heartbeatWorker,
          null,
          'status-change-failed',
      );

      throw err;
    }
    // todo what to do with err
  }

  // 1 invoke scf:transcode
  // 如果invoke transcode失败，依然加transcode心跳，diagnose检查心跳重试
  logger.log('invoking scf:transcode...');
  let requestID = uuid.v4();
  try {
    const res = await scf.invoke(config.scf.transcodeFunctionName, {TaskID: taskID});
    logger.log(res);
    requestID = res['RequestId'];
  } catch (err) {
    logger.log('[Error]invoke transcode function failed, add transcode heartbeat and wait retry, err: ', err);
  }

  // 2 update taskinfo
  try {
    await redisHelper.updateTaskInfo(redisHelper.getTaskInfoKey(taskID), {
      InvokedRequestID: requestID,
    });
  } catch (err) {
    // todo what to do with err
  }

  // 3 add first transcode heartbeat
  const member = redisHelper.getHeartbeatMemberKey(taskID, requestID);
  const ts = new Date().getTime();
  try {
    await redisHelper.zadd(redisHelper.getHeartbeatKey(), ts, member);
    logger.log('add transcode heartbeat succ,', member, ts);
  } catch (err) {
    logger.log('[Error]add transcode heartbeat failed,', member, ts, err);

    // todo what to do with err
  }

  // 4. remove record heartbeat
  await removeHeartbeat('record', taskID, oRequestID, heartbeatWorker, null, 'status-change');
};

// 全局监听 uncaughtException
process.on('uncaughtException', async (e) => {
  logger.log(`[Error]process error: `, e);

  // 避免 cleanup 异常导致死循环
  try {
    await cleanup();
  } catch (err) {
    logger.log(`[Error]clean up error: ${err}`);
  }

  process.exit();
});

module.exports = recorder;
