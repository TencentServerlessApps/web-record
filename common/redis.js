const RedLock = require('redlock');
const redis = require('redis');
const config = require('./config');
const logger = require('./log');
const { promisify } = require('util');

let defaultClient = null;

const TaskInfoKeyPrefix = 'tasks';
const HeartbeatKeyPrefix = 'heartbeats';
const StopSignalKeyPrefix = 'stop';
const ControlSignalKeyPrefix = 'ctrl';
const retries = 2048;
const StatusMap = {
  normal: 0,
  recording: 1,
  paused: 1,
  canceled: 2,
  transcode: 3,
  upload: 4,
  callback: 5,
  finished: 6,
};
const redisHelper = {};
redisHelper.inited = false;

redisHelper.CtrlSignalPause = 1;
redisHelper.CtrlSignalResume = 2;
redisHelper.CtrlSignalStop = 3;
redisHelper.CtrlSignalRefresh = 4;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

redisHelper.updateTaskInfo = async (key, data) => {
  try {
    const lock = await redisHelper.lock(`taskInfoLock:${key}`, 2000, null, 3, 200);

    const res = await redisHelper.getString(key);
    const ti = JSON.parse(res);

    // check if status changing illegal
    if (data.Status && ti.Status) {
      if (StatusMap[data.Status] < StatusMap[ti.Status]) {
        const err = {
          message: `[Error]update status failed, can not change status from ${ti.Status} to ${data.Status}`,
        };
        logger.log(err.message);
        await redisHelper.unlock(lock);
        throw err;
      }
    }

    for (const name in data) {
      ti[name] = data[name];
    }

    const tiStr = JSON.stringify(ti);
    await redisHelper.setString(key, tiStr);
    logger.log('update taskinfo succ to ', tiStr);

    await redisHelper.unlock(lock);

    return ti;
  } catch (err) {
    logger.log(`[Error]update taskinfo(${key}) failed, `, err);
    throw err;
  }
};

redisHelper.getTaskInfoKey = (taskID) => {
  return `${TaskInfoKeyPrefix}:${taskID}`;
};

redisHelper.getHeartbeatKey = () => {
  return HeartbeatKeyPrefix;
};

redisHelper.getStopSignalKey = (taskID) => {
  return `${StopSignalKeyPrefix}:${taskID}`;
};

redisHelper.getCtrlSignalKey = (taskID) => {
  return `${ControlSignalKeyPrefix}:${taskID}`;
};

redisHelper.getHeartbeatMemberKey = (taskID, requestID) => {
  return `${taskID}:${requestID}`;
};

// 通用的创建 redis 客户端方法
redisHelper.createClient = async (module) => {
  return new Promise((resolve, reject) => {
    try {
      options = {
        "port": config.redis.port,
        "host": config.redis.host,
        "connect_timeout": 10000
      };
      const c = redis.createClient(config.redis.port, config.redis.host, options);
      // 支持免密登录的 redis
      if (config.redis.auth) {
        c.auth(config.redis.auth);
      }
      c.select(config.redis.index);
      const msgSuffix = module ? `(${module})` : '';
      c.on('error', (err) => {
        logger.log(`[Error]redis error${msgSuffix}, err: `, err);
        throw err;
      });
      c.on('connect', () => {
        resolve(c);
        logger.log(`connect redis success${msgSuffix}`);
      });
    } catch (err) {
      logger.log('[Error]create redis failed,', err);
      reject(err);
    }
  });
};

redisHelper.connect = async () => {
  if (!redisHelper.inited) {
    redisHelper.inited = true;
  }
  try {
    const client = await redisHelper.createClient();
    defaultClient = client;
  }catch (err) {
    logger.log('[Error]connect err,', err);
    throw err;
  }

};

redisHelper.close = (client = null) => {
  if (client) {
    client.quit();
  }

  if (!defaultClient) {
    return;
  }

  defaultClient.quit((err, result) => {
    if (err) {
      logger.log('redis close, err ', err);
    } else {
      logger.log('redis close, result ', result);
    }
  });
  defaultClient = null;
};

redisHelper.setString = async (key, value, expire) => {
  if (!defaultClient) {
    try {
      await redisHelper.connect();
    } catch (err) {
      logger.log('[Error]connect err,', err);
      throw err;
    }

  }

  return new Promise((resolve, reject) => {
    defaultClient.set(key, value, (err, result) => {
      if (err) {
        logger.log(`[Error]set ${key} => ${value} failed, err:`, err);
        return reject(err);
      }

      if (!isNaN(expire) && expire > 0) {
        defaultClient.expire(key, expire, (e, res) => {
          if (e) {
            logger.log(`[Error]set expire for ${key} failed, err:`, e);
            return reject(e);
          }
          return resolve(res);
        });
      }

      return resolve(result);
    });
  });
};

redisHelper.getString = async (key) => {
  if (!defaultClient) {
    try {
      await redisHelper.connect();
    } catch (err) {
      logger.log('[Error]connect err,', err);
      throw err;
    }
  }
  let error = '';
  for (let i = 256; i <= retries; i <<= 1) {
    try {
      const res = await new Promise((resolve, reject) => {
        defaultClient.get(key, (err, result) => {
          if (err) {
            logger.log(`[Error]get ${key} failed, err: `, err);
            return reject(err);
          }

          logger.log('get', key, 'succ', result);
          if (!result) {
            return reject({
              message: 'key not found',
            });
          }

          return resolve(result);
        });
      });
      return res;
    } catch (err) {
      logger.log(`[Error] catch zrem ${key} failed, args: `, { key }, 'err:', err);
      await sleep(i);
      error = err;
    }
  }
  throw error;
};

redisHelper.delete = async (key) => {
  if (!defaultClient) {
    try {
      await redisHelper.connect();
    } catch (err) {
      logger.log('[Error]connect err,', err);
      throw err;
    }
  }
  let error = '';
  for (let i = 256; i <= retries; i <<= 1) {
    try {
      const res = await new Promise((resolve, reject) => {
        logger.log('delete key', key);
        defaultClient.del(key, (err, result) => {
          if (err) {
            logger.log(`[Error]delete key ${key} failed, err `, err);
            return reject(err);
          }

          return resolve(result);
        });
      });
      return res;
    } catch (err) {
      logger.log(`[Error] catch zrem ${key} failed, args: `, { key }, 'err:', err);
      await sleep(i);
      error = err;
    }
  }
  throw error;
};

// example: zadd key score1 member1 score2 member2
redisHelper.zadd = async (key, ...args) => {
  if (!defaultClient) {
    try {
      await redisHelper.connect();
    } catch (err) {
      logger.log('[Error]connect err,', err);
      throw err;
    }
  }
  let error = '';
  for (let i = 256; i <= retries; i <<= 1) {
    try {
      const res = await new Promise((resolve, reject) => {
        defaultClient.zadd(key, ...args, (err, result) => {
          if (err) {
            logger.log(`[Error]zadd ${key} failed, args:`, args, 'err:', err);
            return reject(err);
          }

          return resolve(result);
        });
      });
      return res;
    } catch (err) {
      logger.log(`[Error] catch zrem ${key} failed, args: `, args, 'err:', err);
      await sleep(i);
      error = err;
    }
  }
  throw error;
};

redisHelper.zrem = async (key, ...args) => {
  if (!defaultClient) {
    try {
      await redisHelper.connect();
    } catch (err) {
      logger.log('[Error]connect err,', err);
      throw err;
    }
  }
  let error = '';
  for (let i = 256; i <= retries; i <<= 1) {
    try {
      const res = await new Promise((resolve, reject) => {
        defaultClient.zrem(key, ...args, (err, result) => {
          if (err) {
            logger.log(`[Error]zrem ${key} failed, args: `, args, 'err:', err);
            return reject(err);
          }

          return resolve(result);
        });
      });
      return res;
    } catch (err) {
      logger.log(`[Error] catch zrem ${key} failed, args: `, args, 'err:', err);
      await sleep(i);
      error = err;
    }
  }
  throw error;
};

redisHelper.zrange = async (key, min, max) => {
  if (!defaultClient) {
    try {
      await redisHelper.connect();
    } catch (err) {
      logger.log('[Error]connect err,', err);
      throw err;
    }
  }
  let error = '';
  for (let i = 256; i <= retries; i <<= 1) {
    try {
      const res = await new Promise((resolve, reject) => {
        defaultClient.zrangebyscore(key, min, max, (err, result) => {
          if (err) {
            logger.log(`[Error]zrangebyscore ${key} failed,`, err);
            return reject(err);
          }

          return resolve(result);
        });
      });
      return res;
    } catch (err) {
      logger.log(`[Error]catch zrangebyscore ${key} failed,`, err);
      await sleep(i);
      error = err;
    }
  }
  throw error;
};

redisHelper.rpush = async (key, ...args) => {
  if (!defaultClient) {
    try {
      await redisHelper.connect();
    } catch (err) {
      logger.log('[Error]connect err,', err);
      throw err;
    }
  }
  return new Promise((resolve, reject) => {
    defaultClient.rpush(key, ...args, (err, result) => {
      if (err) {
        logger.log('[Error]rpush failed', key, args, err);
        return reject(err);
      }

      return resolve(result);
    });
  });
};

redisHelper.blpop = async (client, key, timeout) => {
  return new Promise(async (resolve, reject) => {
    // 因为blpop操作会阻塞其他redis操作，所以需要另起一个redis client，避免redis连接被阻塞
    let cl = client;
    if (!cl) {
      try {
        cl = await redisHelper.createClient('blpop');
      }catch (err) {
        logger.log('[Error]connect err,', err);
        throw err;
      }
    }

    cl.blpop(key, timeout, (err, result) => {
      if (err) {
        logger.log('[Error]blpop failed', key, err);
        cl.quit();
        return reject(err);
      }

      if (!client) {
        cl.quit();
      }

      let res = result;
      if (result) {
        res = result[1];
      }
      return resolve(res);
    });
  });
};

redisHelper.scanAll = async (pattern, step) => {
  if (!defaultClient) {
    try {
      await redisHelper.connect();
    } catch (err) {
      logger.log('[Error]connect err,', err);
      throw err;
    }
  }

  return new Promise(async (resolve, reject) => {
    const found = [];
    let cursor = '0';
    const scan = promisify(defaultClient.scan).bind(defaultClient);

    do {
      try {
        const rsp = await scan(cursor, 'MATCH', pattern, 'COUNT', '' + step);
        if (!rsp) {
          reject({
            message: 'found nothing',
          });
          return;
        }

        logger.log('scan rsp', rsp);
        cursor = rsp[0];
        found.push(...rsp[1]);
      } catch (err) {
        logger.log('[Error]scan error', err);
        reject(err);
        return;
      }
    } while (cursor != '0');

    resolve(found);
  });
};

redisHelper.lock = async (lockname, ttl, client, retryCount, retryDelay) => {
  if (!defaultClient) {
    try {
      await redisHelper.connect();
    }catch (err) {
      logger.log('[Error]defaultClient lock error', err);
      throw err;
    }
  }

  if (!client) {
    client = defaultClient;
  }

  const redLock = new RedLock([client], {
    retryCount: retryCount || 5,
    retryDelay: retryDelay || 2500,
    retryJitter: 50,
  });
  return await redLock.lock(lockname, ttl);
};

redisHelper.unlock = async (lock) => {
  return lock && (await lock.unlock());
};

redisHelper.extendLock = async (lock, ttl) => {
  if (lock) {
    lock = await lock.extend(ttl);
  }
  return lock;
};

module.exports = redisHelper;
