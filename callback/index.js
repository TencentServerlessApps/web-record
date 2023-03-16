const callback = require('./handlers/callback');
const { config, logger } = require('common');

process.env.TZ = 'Asia/Shanghai';

/**
 * @description:
 * @param {*} event callback params
 * {
 *      "TaskID": "xxx"
 * }
 * @param {*} context
 * @return {*}
 */
exports.main_handler = async (event, context) => {
  logger.clearIndex();

  logger.updatePermanentIndex('TaskID', event['TaskID']);
  logger.updatePermanentIndex('Version', config.version);
  const requestID = context['request_id'];
  return await callback.run(event, requestID);
};
