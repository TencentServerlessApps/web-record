const { config, logger } = require('common');
const uploader = require('./handlers/upload');
import { runTranscode } from './handlers/transcode';
import { TaskInfo, TranscodeEvent } from './interface';

process.env.TZ = 'Asia/Shanghai';

export const cosRetry = 5;

export const main_handler = async (event: TranscodeEvent, context: { request_id: string }) => {
  logger.clearIndex();

  logger.updatePermanentIndex('Version', config.version);
  if (!event || !event['TaskID']) {
    logger.log('unknown event', event);
    return '[Error]transcode failed with unknown event';
  }

  logger.updatePermanentIndex('TaskID', event['TaskID']);
  logger.log('[Report]task action event combination: transcode and upload');

  const requestID = context['request_id'];
  const resOfTranscode = await runTranscode(event, requestID);
  if (resOfTranscode !== 'OK' && resOfTranscode !== 'invalid status') {
    return resOfTranscode
  }

  const resOfUpload = await uploader.runUpload(event, requestID);
  return resOfUpload
};
