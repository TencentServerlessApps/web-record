const { config, logger } = require('common');
const diagnose = require('./handlers/diagnose');

process.env.TZ = 'Asia/Shanghai';

exports.main_handler = async (event, context) => {
  logger.clearIndex();

  logger.updatePermanentIndex('Version', config.version);
  await diagnose.run(context["time_limit_in_ms"]);
  return 'OK';
};
