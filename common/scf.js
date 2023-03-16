const config = require('./config');
const logger = require('./log');
const tencentcloud = require('tencentcloud-sdk-nodejs');
const { Capi } = require('@tencent-sdk/capi');
const ScfClient = tencentcloud.scf.v20180416.Client;

const scf = {};

scf.initCredential = () => {
  // 初始化密钥配置，支持永久密钥
  let secretId = process.env.SECRET_ID;
  let secretKey = process.env.SECRET_KEY;
  // 处理兼容 undefined 字符串问题
  secretId = secretId === 'undefined' ? '' : secretId;
  secretKey = secretKey === 'undefined' ? '' : secretKey;

  const credential = {
    secretId: secretId,
    secretKey: secretKey,
  };
  if (!secretId || !secretKey) {
    credential.secretId = process.env.TENCENTCLOUD_SECRETID;
    credential.secretKey = process.env.TENCENTCLOUD_SECRETKEY;
    credential.token = process.env.TENCENTCLOUD_SESSIONTOKEN;
  }
  return credential;
};

scf.init = () => {
  const credential = scf.initCredential();
  let region = process.env.TENCENTCLOUD_REGION;
  if (!region) {
    region = config.region || 'ap-guangzhou';
  }

  const clientConfig = {
    credential: credential,
    region: region,
    profile: {
      httpProfile: {
        endpoint: config.scf.host,
        reqTimeout: 120, // 超时时间延长到120秒，默认是60秒
      },
      signMethod: 'TC3-HMAC-SHA256',
    },
  };
  scf.client = new ScfClient(clientConfig);
};

scf.invoke = async (funcName, data, qualifier) => {
  try {
    scf.init();
    const invokeOption = {
      Qualifier: qualifier || '$DEFAULT',
      FunctionName: funcName,
      Event: JSON.stringify(data),
    };
    const res = await scf.client.InvokeFunction(invokeOption);
    if ("RequestId" in res) {
      if ('Result' in res && res['Result']['InvokeResult'] != 0 && res['Result']['InvokeResult'] != 200) {
        logger.log('[Error]invoke function failed InvokeResult !=0 && !=200', 'res:', res)
        throw 'InvokeResult !=0 && !=200 ';
      }
    }else{
      logger.log('[Error]RequestId not exist invoke record function failed', 'res:', res);
      throw 'RequestId not exist!';
    }
    return res;
  } catch (e) {
    logger.log('[Error]invoke function failed', funcName, 'err:', e);
    throw(e);
  }
};

scf.asyncInvoke = async (funcName, data, qualifier) => {
  try {
    scf.init();
    const invokeOption = {
      InvocationType: 'Event',
      LogType: 'Tail',
      Qualifier: qualifier || '$DEFAULT',
      FunctionName: funcName,
      ClientContext: JSON.stringify(data),
    };
    const res = await scf.client.Invoke(invokeOption);
    if ("RequestId" in res) {
      if ('Result' in res && res['Result']['InvokeResult'] != 0 && res['Result']['InvokeResult'] != 200) {
        logger.log('[Error] invoke function failed InvokeResult !=0 && !=200', 'res:', res)
        throw 'InvokeResult !=0 && !=200';
      }
    } else {
      logger.log('[Error]RequestId not exist invoke record function failed', 'res:', res);
      throw 'RequestId not exist!';
    }
    return res;
  } catch (e) {
    logger.log('[Error]invoke function failed', funcName, 'err:', e);
    throw(e);
  }
};

scf.terminate = (funcName, invokedRequestID) => {
  return new Promise(async (resolve, reject) => {
    try {
      const info = await scf.describe(funcName, invokedRequestID);
      if (info && info.Status == 'RUNNING') {
        const params = {
          FunctionName: funcName,
          InvokeRequestId: invokedRequestID,
        };

        scf.init();
        scf.client.TerminateAsyncEvent(params).then(
          (res) => {
            logger.log('terminate function succ', funcName, 'res', res);
            resolve();
          },
          (err) => {
            logger.log('[Error]terminate function failed,', funcName, 'err:', err);
            reject(err);
          },
        );
      } else {
        logger.log('no need to terminate function, function info', info);
        resolve();
      }
    } catch (err) {
      reject(err);
    }
  });
};

scf.describe = async (funcName, invokedRequestID) => {
  return new Promise((resolve, reject) => {
    const params = {
      FunctionName: funcName,
      InvokeRequestId: invokedRequestID,
    };

    scf.init();
    scf.client.ListAsyncEvents(params).then(
      (res) => {
        // {
        //     "Response": {
        //     "TotalCount": 1,
        //     "EventList": [
        //         {
        //         "InvokeRequestId": "a9cd1628-fff4-402d-9054-0f39055d0634",
        //         "Qualifier": "$LATEST",
        //         "Status": "RUNNING",
        //         "InvokeType": "OTHERS",
        //         "StartTime": "2021-04-01 20:57:03.238",
        //         "EndTime": ""
        //         }
        //     ],
        //     "RequestId": "8fabcafc-5de0-4dc8-bb90-ff94fba1a296"
        //     }
        // }
        logger.log('describe function succ', funcName);
        let event = null;
        if (res && res.TotalCount > 0) {
          event = res.EventList[0];
        }
        resolve(event);
      },
      (err) => {
        logger.log('[Error]describe function failed', funcName, 'err', err);
        reject(err);
      },
    );
  });
};

scf.reinvoke = async (funcName, data, oldInvokedRequestID, qualifier) => {
  try {
    await scf.terminate(funcName, oldInvokedRequestID);
    const res = await scf.invoke(funcName, data, qualifier);
    return res;
  } catch (err) {
    logger.log('[Error]reinvoke function failed', funcName, 'err', err);
    throw err;
  }
};

scf.web_record = (data, taskID, action) => {
  return new Promise((resolve, reject) => {
    try {
      let region = process.env.TENCENTCLOUD_REGION;
      if (!region) {
        region = config.region || 'ap-guangzhou';
      }
      const credential = scf.initCredential();
      const capi = new Capi({
        isV3: true,
        debug: false,
        Region: region,
        SecretId: credential.secretId,
        SecretKey: credential.secretKey,
        Token: credential.token,
        ServiceType: 'scf',
        Version: '2018-04-16',
      });
      const invokeOption = {
        RecordAction: action,
        RecordData: data,
        TaskID: taskID,
      };
      logger.log('double_record req', invokeOption);
      capi
        .request({
          Action: 'RecordPanoramic',
          ...invokeOption,
        })
        .then((res) => {
          logger.log('double_record succ', 'data', data);
          resolve(res);
        })
        .catch((err) => {
          reject(err);
        });
    } catch (err) {
      reject(err);
    }
  });
};

module.exports = scf;
