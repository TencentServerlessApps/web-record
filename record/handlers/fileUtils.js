"use strict";

const fs = require("fs");
const path = require('path');
const {logger} = require("common");
const {spawn} = require("child_process");
const {Duplex} = require("stream");

const fileTools = {};
// 删除历史文件
fileTools.traverse = async (rootPath, max_history = 7) => {
  try {
    if (fs.existsSync(rootPath)) {
      console.log("start clean cfs, dir", rootPath);
      const diff_time = 3600 * 24 * max_history;
      const files = fs.readdirSync(rootPath);
      files.forEach(function (item, index) {
        const fPath = path.join(rootPath, item);
        const stat = fs.statSync(fPath);
        if (stat.isDirectory() === true) {
          fileTools.traverse(fPath, max_history);
        }
        if (stat.isFile() === true) {
          // 删除历史文件
          const now_time = Date.now();
          const file_time = stat.mtime.getTime();
          if ((now_time - file_time) / 1000 > diff_time) {
            console.log("delete file", fPath);
            fs.unlinkSync(fPath);
          }
        }
      });
    }
  } catch (e) {
    console.log("clean cfs videos fail", e);
  }
};

// 删除路径下空文件夹
fileTools.rmEmptyDir = async (filePath) => {
  const files = fs.readdirSync(filePath);
  if (files.length === 0) {
    fs.rmdirSync(filePath);
  } else {
    files.forEach((file) => {
      const subFilePath = `${filePath}/${file}`;
      const stat = fs.statSync(subFilePath);
      if (stat.isDirectory() === true) {
        fileTools.rmEmptyDir(subFilePath);
      }
    });
  }
};

fileTools.webmParse = async ({ file }) => {
  let webmEBMLNormal = true;
  for (let i = 0; i < 5; i++) {
    try {
      const args = ['-i', file];
      logger.log('Get webm parse args:', args);
      const parseProcess = spawn(path.join(__dirname, '..', 'bin', 'webm_info'), args);

      const output = await new Promise((resolve) => {
        let stdout = '';
        parseProcess.stdout.on('data', (data) => {
          stdout += data.toString('utf-8');
        });
        parseProcess.on('close', () => {
          resolve(stdout);
        });
        return stdout;
      });

      logger.log('webm parsed:', output);
      if (output.length === 0 || output.match('Error parsing EBML header')) {
        logger.log(`Error parsing EBML header`);
        webmEBMLNormal = false;
        continue;
      }
      webmEBMLNormal = true;
      break;
    } catch (err) {
      logger.log('Error parsing EBML header: ', err);
      webmEBMLNormal = false;
    }
  }
  return webmEBMLNormal;
};

module.exports = fileTools;
