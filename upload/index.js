const { config, logger } = require('common');
const uploader = require('./handlers/upload');

process.env.TZ = 'Asia/Shanghai';

exports.main_handler = async (event, context) => {
  logger.clearIndex();

  logger.updatePermanentIndex('Version', config.version);
  logger.log('upload with event', event, 'context', context);
  if (!event || !event['TaskID']) {
    logger.log('unknown event', event);
    return '[Error]upload failed with unknown event';
  }

  logger.updatePermanentIndex('TaskID', event['TaskID']);

  logger.updateOnetimeIndex('Action', 'upload');
  logger.log('[Report]task action event: upload');

  const requestID = context['request_id'];
  return await uploader.run(event, requestID);
};
