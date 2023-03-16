const logger = {};
logger.indexes = {};
logger.updatePermanentIndex = (key, value) => {
  logger.indexes[key] = value;
};
logger.log = (...args) => {
  console.log(...args);
};

chrome.runtime.onMessage.addListener((request) => {
  switch (request) {
    case 'START_RECORDING':
      logger.log('START_RECORDING');
      // todo 这里需要获取当前tab页的url
      startRecording('xxxxx', 'tab url');
      break;
    case 'STOP_RECORDING':
      logger.log('STOP_RECORDING');
      stopRecording();
      break;
    default:
      logger.log('UNKNOWN_REQUEST');
  }
});

let recorder = null;
let recordedChunks = [];
let numRecordedBlobs = 0;
let numRecordedChunks = 0;
let isCaptureStarted = false;
let now = new Date().getTime();
function startRecording(taskID, url) {
  // 如果之前已经成功调用过startRecording， 则再次调用的时候用resumeRecording来代替
  if (isCaptureStarted) {
    logger.log('duplicate startRecording, take resumeRecording instead');
    resumeRecording();
    return;
  }

  logger.updatePermanentIndex('TaskID', taskID);
  logger.log('starting to record', url);
  const options = {audio: true, video: true};
  chrome.tabCapture.capture(options, (stream) => {
    // chrome.tabCapture.captureOffscreenTab(url, options, (stream) => {
    if (stream === null) {
      logger.log(`[Error]Last Error: ${chrome.runtime.lastError.message}`);
      return;
    }

    let mimeType = 'video/webm';
    if (MediaRecorder.isTypeSupported('video/webm;codecs=h264')) {
      mimeType = 'video/webm;codecs=h264';
    } else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) {
      mimeType = 'video/webm;codecs=vp8';
    }
    logger.log(`Recorder mimeType: ${mimeType}`);

    const option = {mimeType};

    let lastLogTime = 0;
    try {
      let rec = new MediaRecorder(stream, option);
      logger.log('Recorder is in place.');

      rec.ondataavailable = async (event) => {
        const {data: blob, timecode} = event;
        if (event.data.size > 0) {
          const buffer = await event.data.arrayBuffer();
          const data = arrayBufferToString(buffer);
          // 前面已确保sendData方法注册成功
          // 这里做二次确认
          let senDataFlag = false;
          if (!senDataFlag) {
            for (let i = 0; i < 3; i++) {
              if (!window.sendData) {
                // 如果注册方法不存在，等待一段时间重试
                logger.log(`=============Receive event[ondataavailable], but not call window.sendData, wait and retry...`);
                await new Promise((resolve) => setTimeout(resolve, 500));
                continue;
              }
              senDataFlag = true;
              break;
            }
          }

          if (window.sendData) {
            window.sendData(data);
          } else {
            logger.log(`[WARN]=============Receive event[ondataavailable], window.sendData not exist`);
          }

          numRecordedBlobs += 1;
          numRecordedChunks += event.data.size;
          logger.log(
              `[sendData]-------------data size: ${event.data.size}, time: ${Date.now()}, totalBlobs: ${numRecordedBlobs}`,
          );

          if (!lastLogTime || new Date().getTime() - lastLogTime > 10000) {
            lastLogTime = new Date().getTime();
            logger.log(
                `recorder ondataavailable Got another blob: ${timecode}: ${blob}, size ${event.data.size}`,
            );
          }
        }
      };
      rec.onerror = () => {
        logger.log('recorder onerror');
        rec.stop();
      };
      rec.onstop = () => {
        logger.log('recorder onstop');
        try {
          const tracks = stream.getTracks();
          tracks.forEach((track) => {
            track.stop();
          });
        } catch (err) {
          logger.log(`recorder onstop, err ${err.message}`);
        }
      };

      stream.oninactive = () => {
        logger.log('stream oninactive');
        try {
          if (rec && rec.state != 'inactive') {
            rec.stop();
          }
        } catch (err) {
          logger.log(`[Error]stop record failed, err ${err.message}`)
        }
      };

      const timeslice = 500;
      rec.start(timeslice);

      recorder = rec;
    } catch (err) {
      logger.log(`[Error]fatal err:${err.message}`);
      return;
    }
  });

  isCaptureStarted = true;
}

function pauseRecording() {
  try {
    if (recorder && recorder.state != 'inactive') {
      recorder.pause();
    }
  } catch (err) {
    logger.log(`[Error]pause record failed, err:${err.message}`);
    throw err.message
  }
}

function resumeRecording(taskID, url) {
  try {
    // 如果没有开始页面采集，需要走startRecording开启页面采集
    // 这个种情况一般是record函数在paused状态的时候出现异常，被重启了
    if(!isCaptureStarted) {
      startRecording(taskID, url);
      return;
    }

    if (recorder && recorder.state != 'inactive') {
      recorder.resume();
    }
  } catch (err) {
    logger.log(`[Error]resume record failed, err:${err.message}`);
    throw err.message
  }
}

function stopRecording() {
  logger.log(
    `Stop recording..., total size ${numRecordedChunks}, total blobs ${numRecordedBlobs}`,
  );

  try {
    if (recorder && recorder.state != 'inactive') {
      recorder.stop();
    }
  } catch (err) {
    logger.log(`[Error]stop record failed, err:${err.message}`);
  }

  return numRecordedBlobs;
}

function arrayBufferToString(buffer) {
  // Convert an ArrayBuffer to an UTF-8 String

  var bufView = new Uint8Array(buffer);
  var length = bufView.length;
  var result = '';
  var addition = Math.pow(2, 8) - 1;

  for (var i = 0; i < length; i += addition) {
    if (i + addition > length) {
      addition = length - i;
    }
    result += String.fromCharCode.apply(
      null,
      bufView.subarray(i, i + addition),
    );
  }
  return result;
}
