#!/usr/bin/env node

const https = require('https');
const crypto = require('crypto');
const ora = require('ora');
const chalk = require('chalk');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

require('dotenv').config();

// TODO: API 网关应用鉴权密钥信息 ApiAppKey
const apiAppKey = process.env.APIGW_APP_KEY;
// TODO: API 网关应用鉴权密钥信息 ApiAppSecret
const apiAppSecret = process.env.APIGW_APP_SECRET;
// TODO: 部署生成的 API网关域名，示例：service-abcexxx-125xxxxxx.gz.apigw.tencentcs.com
const apigwDomain = process.env.APIGW_DOMAIN;

function formatBody(type, data) {
  return {
    Action: type,
    Data: data,
  };
}

function getSignature({
  appKey,
  appSecret,
  method,
  path,
  body = {},
  headers = {
    Accept: 'application/json',
  },
  isFormData = false,
}) {
  function querystring(obj) {
    const sortedKeys = Object.keys(obj).sort();
    return sortedKeys
      .map((key) => {
        return `${key}=${obj[key]}`;
      })
      .join('&');
  }

  headers['Content-Type'] =
    headers['Content-Type'] ||
    (isFormData ? 'application/x-www-form-urlencoded' : 'application/json');

  const jsonBody = JSON.stringify(body);
  const bodyMd5 = crypto.createHash('md5').update(jsonBody, 'utf8').digest('hex');
  const bodyMd5Base64 = Buffer.from(bodyMd5).toString('base64');
  const date = new Date().toUTCString();

  const prepareString = [
    `x-date: ${date}`,
    method,
    headers.Accept,
    headers['Content-Type'],
    bodyMd5Base64,
    isFormData ? `${path}?${querystring(body)}` : path,
  ].join('\n');

  const signingString = crypto
    .createHmac('sha1', appSecret)
    .update(prepareString, 'utf-8')
    .digest('base64');

  const authorization = `hmac id="${appKey}", algorithm="hmac-sha1", headers="x-date", signature="${signingString}"`;

  const newHeaders = {
    ...headers,
    'x-date': date,
    Authorization: authorization,
  };

  if (!isFormData) {
    newHeaders['Content-MD5'] = bodyMd5Base64;
    newHeaders['Content-Length'] = jsonBody.length;
  }

  return {
    date,
    authorization,
    bodyMd5Base64,
    headers: newHeaders,
  };
}

function main() {
  const spinner = ora().start('Running...');
  const { argv } = yargs(hideBin(process.argv))
    .option('action', {
      alias: 'a',
      type: 'string',
      description: '操作类型：start,stop,info',
    })
    .option('task', {
      alias: 't',
      type: 'string',
      description: '任务 ID',
    })
    .option('url', {
      alias: 'u',
      type: 'string',
      description: '录制链接',
    })
    .option('width', {
      alias: 'w',
      type: 'number',
      description: '录制宽度',
    })
    .option('height', {
      alias: 'h',
      type: 'number',
      description: '录制高度',
    })
    .option('callback', {
      alias: 'c',
      type: 'string',
      description: '录制成功回调',
      default: '',
    })
    .option('max-duration', {
      type: 'number',
      description: '支持最大视频录制时长',
      default: 36000,
    });

  const { action, task, url, width, height, callback, maxDuration } = argv;

  let body = {};
  switch (action) {
    // 开始录制
    case 'start':
      body = formatBody('Start', {
        RecordURL: url,
        Width: width,
        Height: height,
        CallbackURL: callback,
        MaxDurationLimit: maxDuration,
      });
      break;
    // 停止录制
    case 'stop':
      body = formatBody('Stop', {
        TaskID: task,
      });
      break;
    // 暂停录制
    case 'pause':
      body = formatBody('Pause', {
        TaskID: task,
      });
      break;
    // 恢复录制
    case 'resume':
      body = formatBody('Resume', {
        TaskID: task,
      });
      break;
    // 查看任务信息
    case 'info':
      body = formatBody('Describe', {
        TaskID: task,
      });
      break;
    default:
      throw new Error('Unknow action');
  }

  const path = '/record';
  const method = 'POST';
  const { headers } = getSignature({
    appKey: apiAppKey,
    appSecret: apiAppSecret,
    method,
    path,
    body,
  });

  try {
    const req = https.request(
      {
        hostname: apigwDomain,
        port: 443,
        path,
        method,
        headers,
      },
      (res) => {
        res.on('data', (chunk) => {
          const retMsg = chunk.toString();

          const invokeRes = JSON.parse(retMsg);
          if (invokeRes.TaskID) {
            spinner.info(
              `${chalk.bgGreen(chalk.black(' Task ID '))}: ${chalk.yellow(invokeRes.TaskID)}`,
            );
          }
          spinner.succeed(retMsg);
        });
      },
    );

    req.on('error', (e) => {
      spinner.fail(e.message);
    });
    req.write(JSON.stringify(body));
    req.end();
  } catch (e) {
    spinner.fail(e.message);
  }
}

main();
