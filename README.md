# Serverless Web 录制应用

## 环境准备

```
- Node.js: v12+
- Serverless Framework CLI:
    Framework Core: 2.48.0 (local)
    Plugin: 5.4.2
    SDK: 4.2.3
    Components: 3.12.0
```

## 目录说明

```text
- common -- 云函数公共模块
- dispatch -- 调度器云函数实现代码
- callback -- 回调云函数实现代码
- diagnose -- 健康检查云函数实现代码
- upload -- 转存云函数实现代码
- record -- 录制云函数实现代码
- transcode -- 转码云函数实现代码
```

## 构建指导
1、根目录下执行`npm i`安装依赖   
2、构建基础镜像----docker目录下构建基础镜像   
3、构建record合transcode镜像，配置`.env`文件，根目录下执行命令：
```text
npm run build
```

## 部署说明

默认情况下，推荐使用 `Serverless Framework CLI` 开发者工具进行部署。

### 安装 Serverless Framework

```bash
$ npm install -g serverless
```

更详细说明可以参考 [这里](https://cloud.tencent.com/document/product/583/44753)。

### 配置

将项目目录下 `.env.example` 文件修改为 `.env`，内容如下：

```text
# 腾讯云帐号 SecretID
TENCENT_SECRET_ID=xxx
# 腾讯云帐号 SecretID
TENCENT_SECRET_KEY=xxx


# VPC ID
VPC_ID=vpc-xxx
# 子网 ID
SUBNET_ID=subnet-xxx

# 文件存储 ID
CFS_ID=cfs-xxx

# 环境
ENV=prod

# 地域
REGION=ap-chongqing

# COS 桶名称，用来存储录制的视频
COS_BUCKET=web-record-xxx

# Redis 连接 IP/域名
REDIS_HOST=xxx
# Redis 连接端口
REDIS_PORT=6379
# Redis 密码
REDIS_AUTH=xxx
# Redis 数据库索引号
REDIS_INDEX=0

# 容器镜像服务实例ID
REGISTRY_ID=tcr-xxx

# record 函数镜像 URL
RECORD_IMAGE_URL=xxx

# transcode 函数镜像 URL
TRANSCODE_IMAGE_URL=xxx
```

> 注意：请保证函数、私有网络、Redis、文件存储和对象存储均在同一个地域。

### 执行部署

直接在项目目录下执行 `sls deploy` 命令即可。

## 使用

### 使用 API 网关接口调用

接口规范请参考 [WEB 页面录制接口文档](./docs/api.md) 。

项目根目录下已经写到接口请求示例 [demo.js](./demo.js)，基于 API 网关接口的 [应用鉴权](https://cloud.tencent.com/document/product/628/55088)。

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
