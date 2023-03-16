#!/usr/bin/env node

const ora = require('ora');
const chalk = require('chalk');
const { FaaS } = require('@tencent-sdk/faas');
const YAML = require('js-yaml');
const fs = require('fs');
const path = require('path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

require('dotenv').config();

function formatEvent(type, data) {
  return {
    body: JSON.stringify({
      Action: type,
      Data: data,
    }),
  };
}

function getSlsConfig() {
  const slsPath = path.join(__dirname, 'serverless.yml');
  const res = YAML.load(fs.readFileSync(slsPath, 'utf-8'));
  return res;
}

function formatFaasName(appName, name) {
  return `${appName}-${name}`;
}

async function invoke() {
  const spinner = ora().start('Running...');
  const { argv } = yargs(hideBin(process.argv))
    .option('function', {
      alias: 'f',
      type: 'string',
      description: '函数名称',
      // 默认都是通过 dispatch 函数来分发
      default: 'dispatch',
    })
    .option('namespace', {
      alias: 'n',
      type: 'string',
      description: '命名空间',
    })
    .option('qualifier', {
      alias: 'q',
      type: 'string',
      description: '函数版本',
    })
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

  const {
    action,
    task,
    url,
    width,
    height,
    callback,
    maxDuration,
    function: functionId,
    namespace,
    qualifier = '$DEFAULT',
  } = argv;

  const slsConfig = getSlsConfig();
  const functionName = formatFaasName(slsConfig.app || slsConfig.name, functionId);
  const invokeNamespace =
    namespace || (slsConfig.inputs && slsConfig.inputs.namespace) || 'default';

  let event = {};
  switch (action) {
    // 开始录制
    case 'start':
      event = formatEvent('Start', {
        RecordURL: url,
        Width: width,
        Height: height,
        CallbackURL: callback,
        MaxDurationLimit: maxDuration,
      });
      break;
    // 停止录制
    case 'stop':
      event = formatEvent('Stop', {
        TaskID: task,
      });
      break;
    // 暂停录制
    case 'pause':
      event = formatEvent('Pause', {
        TaskID: task,
      });
      break;
    // 恢复录制
    case 'resume':
      event = formatEvent('Resume', {
        TaskID: task,
      });
      break;
    // 查看任务信息
    case 'info':
      event = formatEvent('Describe', {
        TaskID: task,
      });
      break;
    default:
      throw new Error('Unknow action');
  }

  const faas = new FaaS({
    // TODO: 腾讯云账号 SecretId
    secretId: process.env.TENCENT_SECRET_ID,
    // TODO: 腾讯云账号 SecretKey
    secretKey: process.env.TENCENT_SECRET_KEY,
    // TODO: 函数部署的地区
    region: process.env.REGION,
    debug: false,
  });

  try {
    const { retMsg = '{}' } = await faas.invoke({
      name: functionName,
      namespace: invokeNamespace,
      qualifier,
      event,
    });

    const invokeRes = JSON.parse(retMsg);
    if (invokeRes.TaskID) {
      spinner.info(`${chalk.bgGreen(chalk.black(' Task ID '))}: ${chalk.yellow(invokeRes.TaskID)}`);
    }
    spinner.succeed(retMsg);
  } catch (e) {
    spinner.fail(e.message);
  }
}

invoke();

process.on('unhandledRejection', (e) => {
  throw e;
});
