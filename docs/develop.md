# 开发文档

## 环境准备

```
- Node.js: v12+
- Serverless Framework CLI:
    Framework Core: 2.48.0 (local)
    Plugin: 5.4.2
    SDK: 4.2.3
    Components: 3.12.0
- Docker:
    Docker version 20.10.7, build f0df350
```

## 目录说明

```text
- docs -- 说明文档
- docker -- 用来构建 record 和 transcode 函数镜像的相关资源
- common -- 云函数公共模块
- dispatch -- 调度器云函数实现代码
- record -- 录制云函数实现代码 (部署为镜像)
- transcode -- 转码云函数实现代码 (部署为镜像)
- callback -- 回调云函数实现代码
- diagnose -- 健康检查云函数实现代码
- upload -- 转存云函数实现代码
- invoke.js -- 通过函数调用方式进行 Web 录制
- request.js -- 通过 API 网关应用授权方式请求接口
- sync-image.info.js -- 同步镜像信息
- image.json -- SCF 测试账号镜像信息
- image-online.json -- SCF 正式大账号镜像信息
```

## 代码分支

- master -- 发布分支
- dev -- 开发分支

## 初始化项目

```bash
git clone https://github.com/tencent-serverless-app/web-record
```

## 安装依赖

```bash
npm run bootstrap
```

## 构建函数镜像

项目中主要 `record` 和 `transcode` 两个函数需要部署为镜像函数，所以提供给用户使用前，需要先构建同步到 `SCF 大账号下`

函数镜像构件依赖私有镜像 `csighub.tencentyun.com/sls/web-record-base`，如果需要构建，需要申请该酱香仓库权限。构建的镜像版本需要跟 `package.json` 中版本一致。

远端 SCF 测试账号镜像地址信息：

```
- 应用名称 app: web-record
- 用户 uin: 100012352250
- 地区 region: ap-chengdu
- 实例ID registryId: tcr-64xm8jox
- 镜像版本 tag: 1.0.0
- record 仓库地址 repositoryUrl: image-demo.tencentcloudcr.com/web-record/record
- transcode 仓库地址 repositoryUrl: image-demo.tencentcloudcr.com/web-record/transcode
```

项目中已经提供 `build` 构建和同步命令，使用前需要先在 `.env` 文件中配置账号相关的镜像服务参数，包括授权密码：

```text
# SCF 测试账号密钥，用来上传镜像信息 json 到 cos
TENCENT_SECRET_ID=xxx
TENCENT_SECRET_KEY=xxx

# 账号 UIN
username=xxx

# 实例名称 和 ID，企业版需要
registry_id=tcr-xxx
registry_name="image-demo"

# 命名空间
namespace=web-record

# 镜像登录密码
password=xxx
```

然后执行构建命令即可。

同时构建 `record` 和 `transcode` 函数镜像：

```bash
./build
```

或者指定构建 `record` 函数镜像：

```bash
./build -m record
```

构建成功镜像后，需要同步镜像信息到 COS 桶 `serverless-app-images-1253970226` 的 `web-record/image.json` 中：

```bash
./sync-image-info.js
```

该脚本只会更新 `image.json` 信息，如果需要更新 `image-online.json` 信息，需要添加 `online` 参数：

```bash
./sync-image-info.js online
```

> 注意： 同步到 COS 桶的只是镜像信息，但是还需要同步到 SCF 的正式大账号，这里最后还需要 @mamietian (田梦敏) 帮忙处理。

## 基础镜像

[构建函数镜像](#构建函数镜像) 中的函数镜像依赖基础镜像 `csighub.tencentyun.com/sls/web-record-base:latest`，基础镜像目为项目目录 `docker/basic` 中，如果需要更新升级基础镜像，需要企业微信找 `yugasun` 授权 [Tencent Hub](http://csighub.oa.com/tencenthub) 的 `sls` 组织中的 `web-record-base` 项目。

获得授权后，在 `docker/basic` 目录下创建 `.env` 文件，填入授权信息：

```text
username=xxx
password=xxx
```

然后执行构建和同步镜像命令：

```bash
./build
```
