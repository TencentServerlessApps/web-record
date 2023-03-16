const recorder = require('./record');
const uuid = require('uuid');
const { redisHelper, logger } = require('common');

const dispatcher = {};
dispatcher.run = async (event, context) => {
  var req = JSON.parse(event['body']);
  let res;
  var taskID = uuid.v4();
  let action;
  let data;
  if ('Action' in req) {
    action = req['Action'];
  }
  if ('RecordAction' in req) {
    action = req['RecordAction'];
  }
  if ('Data' in req) {
    data = req['Data'];
  }
  if ('RecordData' in req) {
    data = req['RecordData'];
    if ('Width' in data) {
      data['Width'] = parseInt(data['Width']);
    }
    if ('Height' in data) {
      data['Height'] = parseInt(data['Height']);
    }
    if ('MaxDurationLimit' in data) {
      data['MaxDurationLimit'] = parseInt(data['MaxDurationLimit']);
    }
    // 清理用户callback url
    if ('CallbackURL' in data) {
      delete data.CallbackURL;
    }
    // 清理用户Output
    if (data['Output'] && data['Output']['Video']) {
        const outputVideoInfo = data['Output']['Video'];
        data['Output'] = {
          "Video":outputVideoInfo
        };
    }
  }
  if ('TaskID' in req) {
    taskID = req['TaskID'];
    data['TaskID'] = req['TaskID'];
  }
  let appId = context['tencentcloud_appid'];

  switch (action) {
    case 'Start':
      res = await recorder.start(data, taskID, appId);
      break;
    case 'Cancel':
      res = await recorder.stop(data, appId);
    case 'Stop':
      res = await recorder.stop(data, appId);
      break;
    case 'List':
      res = await recorder.list(data);
      break;
    case 'Describe':
      res = await recorder.describe(data);
      break;
    case 'Pause':
      res = await recorder.pause(data, appId);
      break;
    case 'Resume':
      res = await recorder.resume(data, appId);
      break;
    case 'Refresh':
      res = await recorder.refresh(data, appId);
      break;

    // 以下为内部管理接口
    case 'DescribeDetail':
      res = await recorder.describeDetail(data);
      break;
    case 'ForceStop':
      res = await recorder.forcestop(data);
      break;
    default:
      logger.log(`unknown action: ${action}`);
      break;
  }

  redisHelper.close();

  if (res && res.ErrorCode) {
    // log failed event
    logger.updateOnetimeIndex('ErrorCode', res.ErrorCode);
    logger.updateOnetimeIndex('ErrorMessage', res.ErrorMessage);
    logger.log('task failed event:', res);
  }

  res['RequestID'] = context['request_id'];
  if ('RecordAction' in req) {
    res['RequestId'] = req['RequestId'];
    const resp = {
      Response: res,
    };
    return Promise.resolve(resp);
  }
  return Promise.resolve(res);
};

module.exports = dispatcher;
