const path = require('path');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

async function installDependencies(dir) {
  await exec('npm install', {
    cwd: dir,
  });
}

/* eslint-disable no-console*/
async function bootstrap() {
  const args = process.argv.slice(2);
  const moduleName = args[0];

  console.log('Start install dependencies...');
  const rootDir = path.join(__dirname, '..');

  // 1. 安装公共模块 common 依赖
  const commonDir = path.join(rootDir, 'common');
  await installDependencies(commonDir);

  // 2. 安装子目录函数依赖
  if (moduleName) {
    const moduleDir = path.join(rootDir, moduleName);
    await installDependencies(moduleDir);
  } else {
    const faasDirs = ['dispatch', 'callback', 'diagnose', 'record', 'transcode', 'upload'];
    for (const dir of faasDirs) {
      const fullPath = path.join(rootDir, dir);
      await installDependencies(fullPath);
    }
  }
  console.log(`Dependencies installed`);
}

bootstrap();

process.on('unhandledRejection', (e) => {
  throw e;
});
