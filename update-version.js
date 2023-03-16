#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const yargs = require('yargs');
const { hideBin } = require('yargs/helpers');
const semver = require('semver');

const faasList = ['common', 'callback', 'diagnose', 'dispatch', 'record', 'transcode', 'upload'];

function updatePkgVersion(pkgPath, version) {
  const pkgJson = require(path.join(pkgPath, 'package.json'));
  pkgJson.version = version;
  fs.writeFileSync(path.join(pkgPath, 'package.json'), JSON.stringify(pkgJson, null, 2));
}

async function main() {
  const rootPkgPath = path.join(__dirname, 'package.json');
  const rootPkgInfo = JSON.parse(fs.readFileSync(rootPkgPath, 'utf-8'));
  const curVersion = rootPkgInfo.version;

  const { type, ver: specifyVersion } = yargs(hideBin(process.argv)).options({
    type: {
      alias: 't',
      demandOption: false,
      default: 'patch',
      type: 'string',
      description: 'change version type, support: patch,minor,major',
    },
    ver: {
      alias: 'v',
      demandOption: false,
      type: 'string',
      description: 'specify version',
    },
  }).argv;

  let newVersion = specifyVersion;
  if (!newVersion) {
    newVersion = semver.inc(curVersion, type);
  }

  // update root path package.json version
  updatePkgVersion(__dirname, newVersion);

  // update function package.json version
  faasList.forEach((functionName) => {
    const pkgPath = path.join(__dirname, functionName);
    updatePkgVersion(pkgPath, newVersion);
  });
}

main();
