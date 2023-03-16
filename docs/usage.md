## 使用

- [通过项目工具脚本调用](#通过项目工具脚本调用)
- [通过 Serverless CLI 调用](#通过-Serverless-CLI-调用)
- [使用 API 网关接口调用](#使用-API-网关接口调用)

### 通过项目工具脚本调用

1. 开始录制

```bash
./invoke.js --action=start --url=https://www.baidu.com
```

函数调用成功后，在返回结果里有录制任务的`TaskID`，记录下来，后面需要用到。

2. 查询任务信息

```bash
./invoke.js --action=info --task=88eb7494-8664-44d3-99b2-494fa1b534c8
```

3. 停止录制

```bash
./invoke.js --action=stop --task=88eb7494-8664-44d3-99b2-494fa1b534c8
```

### 通过 Serverless CLI 调用

1. 开始录制

```bash
sls invoke --function=dispatch --data='{"body":"{\"Action\":\"Start\",\"Data\":{\"RecordURL\":\"http://www.baidu.com\"}}"}'
```

函数调用成功后，在返回结果里有录制任务的`TaskID`，记录下来，后面需要用到。

2. 查询任务信息

```bash
sls invoke --function=dispatch --data='{"body":"{\"Action\":\"Describe\",\"Data\":{\"TaskID\":\"88eb7494-8664-44d3-99b2-494fa1b534c8\"}}"}'
```

3. 停止录制

```bash
sls invoke --function=dispatch --data='{"body":"{\"Action\":\"Cancel\",\"Data\":{\"TaskID\":\"88eb7494-8664-44d3-99b2-494fa1b534c8\"}}"}'
```

### 使用 API 网关接口调用

接口规范请参考 [WEB 页面录制接口文档](./docs/api.md) 。

项目根目录下已经写到接口请求示例 [demo.js](../demo.js)，基于 API 网关接口的 [应用鉴权](https://cloud.tencent.com/document/product/628/55088)。

在执行前，需要在 [API 网关控制台](https://console.cloud.tencent.com/apigateway/app) 创建应用，并且跟用户部署成功后创建的 API 网关 API 关联，然后将该应用的 `ApiAppKey` 和 `ApiAppSecret` 鉴权密钥 和生成的网关域名填写到 `request.js` 头部。如下：

```js
// API 网关应用鉴权密钥信息 ApiAppKey
const appKey = 'xxx';
// API 网关应用鉴权密钥信息 ApiAppSecret
const appSecret = 'xxx';
// 部署生成的 API网关域名，示例：service-abcexxx-125xxxxxx.gz.apigw.tencentcs.com
const apigwDomain = 'service-abcexxx-125xxxxxx.gz.apigw.tencentcs.com';

// 操作类型：start,stop,info
const action = 'start',
// 任务 ID
const task = '',
// 录制链接
const url = 'https://baidu.com',
// 录制宽度
const width = 1080,
// 录制高度
const height = 720,
// 录制成功回调
const callback = undefined,
// 支持最大视频录制时长
const maxDuration = 36000,
```

然后可以执行以下命令进行录制。

#### 开始录制

```bash
node demo.js
```

函数调用成功后，在返回结果里有录制任务的`TaskID`，记录下来，后面需要用到。

##### 查询任务信息

修改 `demo.js` 中的 `action` 为 `info`，然后将上面产生的任务 ID，赋值给 `task` 变量。

```bash
node demo.js
```

##### 停止录制

将 `action` 修改为 `stop`,

```bash
node demo.js
```

> 说明：用户可参考 `demo.js` 文件，开发自己的服务代码，该文件仅供参考。

### 更多使用方式

请参考 [使用说明](./docs/usage.md) 。

## License

[LICENSE](./LICENSE)
