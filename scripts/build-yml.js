const yaml = require('js-yaml');
const fs = require('fs');

const serverlessYaml = yaml.load(fs.readFileSync('./serverless.yml', 'utf8'));

// 当未选择 CFS 时，不要在 yaml 中带 CFS 结构
if (!process.env.CFS_ID) {
  let { functions } = serverlessYaml.inputs;
  functions = Array.isArray(functions) ? functions : Object.values(functions);
  for (const f of functions) {
    delete f.cfs;
  }
}

fs.writeFileSync('./serverless.yml', yaml.dump(serverlessYaml));
