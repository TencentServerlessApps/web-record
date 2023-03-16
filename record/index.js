const { config, logger } = require('common');
const recorder = require('./handlers/record');
const fileTools = require("./handlers/fileUtils");

process.env.TZ = 'Asia/Shanghai';

exports.main_handler = async (event, context) => {
  logger.clearIndex();

  // 如果事件Type为Timer，说明这次触发是由定时激活函数的定时器触发的
  if (event.Type === 'Timer') {
    if (event.TriggerName === "cfs_clean_timer") {
      // 启动cfs定时清理job
      if (process.env.CFS_ROLLING_MAX_HISTORY && process.env.CFS_ROLLING_MAX_HISTORY !== "undefined") {
        const max_history = parseInt(process.env.CFS_ROLLING_MAX_HISTORY)
        const cfs_path = "/mnt/videos"
        await fileTools.traverse(cfs_path, max_history);
        await fileTools.rmEmptyDir(cfs_path);
      } else {
        logger.log('cfs clean function inactive');
      }
    } else {
      logger.log('active scf instance');
      return 'OK';
    }
  }

  logger.updatePermanentIndex('Version', config.version);

  if (!event || !event['TaskID']) {
    logger.log('unknown event', event);
    return '[Error]record failed with unknown event';
  }

  logger.updatePermanentIndex('TaskID', event['TaskID']);
  return await recorder.run(event, context['request_id']);
};
