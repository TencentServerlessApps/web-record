const { config, logger } = require('common');
const dispatcher = require('./handlers/dispatch');
process.env.TZ = 'Asia/Shanghai';

/**
 * @description: 入口函数
 * @param {*} event 云函数的事件信息，在此函数可能接收到两种event:
 * 1. 正常客户请求：
 * {"body":jsonStr(data)}, data 定义如下：
 * {
 *      "Action": "Start", // Start, Cancel, Describe
 *      "Data": {
 *          // 协议内容
 *      }
 * }
 * 2. 函数激活定时器
 * {
 *      "Message":"Active",
 *      "Time": "2021-05-13T09:16:00Z",
 *      "TriggerName": "timer-dispatch-dev",
 *      "Type": "Timer"
 * }
 * @param {*} context
 * @return {*}
 */
exports.main_handler = async (event, context) => {
  logger.clearIndex();

  // 如果事件Type为Timer，说明这次触发是由定时激活函数的定时器触发的
  if (event.Type === 'Timer') {
    logger.log('active scf instance');
    return 'OK';
  }

  logger.updatePermanentIndex('Version', config.version);
  if (!event || !event['body']) {
    logger.log('[Error]unknown event', event);
    return;
  }

  return await dispatcher.run(event, context);
};

process.on('uncaughtException', (e) => {
  console.log(e);
  throw e;
});

process.on('unhandledRejection', (e) => {
  console.log(e);
  throw e;
});
