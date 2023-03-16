const util = require('util');

const logger = {};
logger.indexes = {};
logger.onetimeIndexes = {};

logger.clearIndex = () => {
  logger.indexes = {};
  logger.onetimeIndexes = {};
};

logger.updatePermanentIndex = (key, value) => {
  logger.indexes[key] = value;
};

logger.updateOnetimeIndex = (key, value) => {
  logger.onetimeIndexes[key] = value;
};

logger.log = (...args) => {
  const obj = {};
  for (const name in logger.indexes) {
    obj[name] = logger.indexes[name];
  }

  if (Object.keys(logger.onetimeIndexes).length > 0) {
    for (const name in logger.onetimeIndexes) {
      obj[name] = logger.onetimeIndexes[name];
    }

    logger.onetimeIndexes = {};
  }

  obj.Message = util.format(...args);
  console._stdout.write(JSON.stringify(obj) + '\n');
};

logger.debug = (...args) => {
  if (!process.env.DEBUG) {
    return;
  }
  logger.log(args);
};

module.exports = logger;
