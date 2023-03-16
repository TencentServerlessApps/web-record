## 创建函数流程

```
现在函数采取镜像部署的形式，涉及到多个函数，应用编排方案还在优化中，现阶段全部采取手动创建的形式。
由腾讯云相关同事情后台创建。
```

### 角色授权

```
访问管理（Cloud Access Management，CAM）的角色是拥有一组权限的虚拟身份，
用于对角色载体授予腾讯云中服务、操作和资源的访问权限。
[参考链接](https://cloud.tencent.com/document/product/598/19381)
```

一般来说，在使用云函数的时候会提示授权，使用之前先去控制台点击一遍，所有角色会自动创建。然后去控制台->访问管理—>角色查看是否有
SCF_QcsRole，ApiGateWay_QCSRole 角色。

### 策略绑定

```
策略是用于定义和描述一条或多条权限的语法规范。腾讯云的策略类型分为预设策略和自定义策略。CAM 从不同角度切入，
为您提供了多种方法来创建和管理策略。若您需要向 CAM 用户或组添加权限，您可以直接关联预设策略，或创建自
定义策略后将自定义策略关联到 CAM 用户或组。每个策略允许包含多个权限，同时您可以将多个策略附加到一个
CAM 用户或组。[参考链接](https://cloud.tencent.com/document/product/598/10601)

```

全景录制需要和其他服务关联使用，需要添加的策略包含如下几个：QcloudRedisFullAccess，QcloudVPCFullAccess，QcloudCFSFullAcces，QcloudSCFFullAccess，QcloudCOSFullAccess，QcloudAccessForScfRole 权限。

### 依赖资源创建

函数创建的过程中，需要依赖⼀些相关组件，主要是 vpc,cfs,cos 和 redis。需要
提前创建好这些资源。具体创建流程参考如下链接：
[vpc 创建](https://cloud.tencent.com/document/product/215/30716)
[cfs 创建](https://cloud.tencent.com/document/product/582/9132)
[cos 创建](https://cloud.tencent.com/document/product/436/38484)
[redis 创建](https://cloud.tencent.com/document/product/239/30871)

创建完成，按照如下格式提供给 eli:

```

 "appId": "xxxxxx",
 "uin": "xxxxxx",
 "vpc": {
 "vpcId": "vpc-xxx",
 "subnetId": "subnet-xxx"
 },
 "cfs": {
 "fileSystemId": "cfs-xxx"
 },
 "redis": {
 "ip": "xxxx",
 "port": xxx,
 "password": "xxx"
 },
 "cosBucket": "xxx"
}
```

#### 函数创建

该操作当前是内部创建，有任何问题联系 eli。

## 全景录制使用流程

### 函数说明

全景录制功能一共由 6 个函数组成，具体功能分别如下：

```
- dispatch -- 调度器云函数实现代码
- record -- 录制云函数实现代码
- transcode -- 转码云函数实现代码
- callback -- 回调云函数实现代码
- diagnose -- 健康检查云函数实现代码
- upload -- 转存云函数实现代码
```

### 功能说明

WEB 页面录制可以将指定的 URL 页面内容完整的录制成一个视频文件，在回放中还原 WEB 应用的完整体验

### 使用前提

- 准备一个可以通过 URL 访问的 WEB 页面作为录制内容来源，此页面需兼容 Chrome
- 用于录制的页面需要自行处理可能存在的登录态或者鉴权
- 用于录制的页面如果需要播放多媒体，需要自行处理多媒体的播放、跳转、停止等操作
- 用于录制的页面需要在指定的宽高内完整的显示所有内容，不能有滚动条，因为 WEB 页面录制只能录制浏览器窗口的可见区域，超出可见区的内容不会被录制下来

### 接口使用说明

#### 接口请求路径

**请求 URL**

登陆函数控制台，点击 dispatch 函数，获取触发器访问入口。

**请求方式**

POST
Content-Type: application/json

#### 接口鉴权方式

WEB 页面录制服务接口由云函数实现，采用了 API 网关触发器方式对外提供服务，鉴权采用应用鉴权的形式[参考链接](https://cloud.tencent.com/document/product/628/55088)

```
除了密钥对鉴权之外，也提供 `SecretID` 和 `SecretKey` 密钥对的方式进行接口鉴权。 具体计算方法请参考 [密钥对认证](https://cloud.tencent.com/document/product/628/11819#.E8.AE.A1.E7.AE.97.E6.96.B9.E6.B3.95)。
```

#### 开始录制接口

通过此接口可以发起 WEB 页面录制，在接口参数中指定录制 URL，录制分辨率，录制结果回调地址等参数。

**请求 Body 参数说明**

| 参数                        | 类型   | 必填 | 说明                                                                                                                                                            |
|-----------------------------|--------|-----|---------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Action                      | string | 是   | 请求操作类型，开始录制为 `Start`                                                                                                                                 |
| Data                        | object | 是   | 请求协议参数                                                                                                                                                    |
| Data.RecordURL              | string | 是   | 需要录制的 WEB 页面访问 URL                                                                                                                                     |
| Data.ManualStart            | bool   | 否   | 创建的录制任务是否需要等待页面主动调用window.startRecord方法触发开始录制，默认为false，录制任务会自动开始录制，
当值被设置为true的时候，录制函数加载页面后，不会自动开始录制，而是等待页面主动调用window.startRecord方法才会触发开始录制。|
| Data.Width                  | number | 否   | 录制画面宽度， 默认为 1280， 合法取值范围[0, 2560]                                                                                                                |
| Data.Height                 | number | 否   | 录制画面高度， 默认为 720， 合法取值范围[0, 2560]                                                                                                                 |
| Data.CallbackURL            | string | 否   | 录制结果通知回调地址                                                                                                                                            |
| Data.MaxDurationLimit       | int    | 否   | 录制最大时长限制， 单位 s, 合法取值范围[0, 36000], 默认 36000s(10 小时)                                                                                          |
| Data.Output                 | object | 否   | 录制结果输出参数                                                                                                                                                |
| Data.Output.Cos             | object | 否   | 录制结果上传COS相关参数                                                                                                                                         |
| Data.Output.Cos.Domain      | string | 否   | CDN自定义域名，默认结果参数中的链接为COS源站地址，指定域名后，将返回CDN地址                                                                                        |
| Data.Output.Cos.Bucket      | string | 否   | COS存储桶名称，默认将录制结果存储到函数创建时指定的存储桶，此参数指定后，将优先把结果存储到指定的存储桶                                                            |
| Data.Output.Cos.Region      | string | 否   | COS所有区域名称                                                                                                                                                 |
| Data.Output.Cos.TargetDir   | string | 否   | 录制结果文件在COS存储桶下的根目录                                                                                                                               |
| Data.Output.Cos.TargetName  | string | 否   | 录制结果文件在COS中的文件名称                                                                                                                                   |
| Data.Output.Video           | object | 否   | 录制结果参数                                                                                                                                        |
| Data.Output.Video.Muxer     | string | 否   | 指定输出格式，可选hls,mp4                                                                                        |
| Data.Output.Video.EncryptKey| string | 否   | hls加密公钥                                                            |
| Data.Output.Video.AuthUrl   | string | 否   | 解密密钥地址
**请求 Body 示例**

```json
{
  "Action": "Start",
  "Data": {
    "RecordURL": "https://web-record-1259648581.cos.ap-chengdu.myqcloud.com/test/ponyo.mp4",
    "Width": 1280,
    "Height": 720,
    "CallbackURL": "http://xxx/webrecord/callback",
    "MaxDurationLimit": 3600,
    "Output": {
        "Cos": {
            "Domain": "abc.xxx.com",
            "Bucket": "webrecord-1234589",
            "Region": "ap-chengdu",
            "TargetDir": "11234/",
            "TargetName": "record-file-name.mp4"
        }
    }
  }
}
```

**返回参数说明**

| 参数         | 类型   | 必填 | 说明                                             |
|--------------|--------|-----|------------------------------------------------|
| ErrorCode    | string | 否   | 错误类型，只有请求出错的时候才会返回此字段        |
| ErrorMessage | string | 否   | 错误说明，只有请求出错的时候才会返回此字段        |
| TaskID       | string | 否   | 录制任务 ID，只有开始录制成功的时候才会返回此字段 |
| RequestID    | string | 否   | 请求 ID                                          |

**返回参数示例**

```json
// 成功返回
{
    "TaskID": "d1806f20-25b8-4c30-8176-c0832bf84e02",
    "RequestID": "95941e2c85898384a95b81c2a542ea15"
}

// 失败返回
{
    "ErrorCode": "InvalidParam",
    "ErrorMessage": "RecordURL missing",
    "RequestID": "95941e2c85898384a95b81c2a542ea15"
}
```

#### 暂停录制接口

使用`暂停录制`接口可以将已经开始录制的任务暂时停止录制。

**请求 Body 参数说明**

| 参数        | 类型   | 必填 | 说明                                                                       |
|-------------|--------|-----|--------------------------------------------------------------------------|
| Action      | string | 是   | 请求操作类型，暂停录制为 `Pause`                                            |
| Data        | object | 是   | 请求协议参数                                                               |
| Data.TaskID | string | 是   | 需要暂停录制的录制任务 ID，录制任务 ID 可以在开始录制的接口返回参数中获取到 |

**请求 Body 示例**

```json
{
  "Action": "Pause",
  "Data": {
    "TaskID": "0f7d9522-a1a3-4517-b5ad-7a6ecaf9c419"
  }
}
```

**返回参数说明**

| 参数         | 类型   | 必填 | 说明                                             |
|--------------|--------|-----|------------------------------------------------|
| ErrorCode    | string | 否   | 错误类型，只有请求出错的时候才会返回此字段        |
| ErrorMessage | string | 否   | 错误说明，只有请求出错的时候才会返回此字段        |
| TaskID       | string | 否   | 录制任务 ID，只有开始录制成功的时候才会返回此字段 |
| RequestID    | string | 否   | 请求 ID                                          |

**返回参数示例**

```json
// 成功返回
{
    "TaskID": "d1806f20-25b8-4c30-8176-c0832bf84e02",
    "RequestID": "95941e2c85898384a95b81c2a542ea15"
}

// 失败返回
{
    "ErrorCode": "InvalidParam",
    "ErrorMessage": "TaskID missing",
    "RequestID": "95941e2c85898384a95b81c2a542ea15"
}
```

#### 恢复录制接口

使用`恢复录制`接口可以将已暂停的录制任务重新开始录制。重新开始录制的视频内容将直接追加在暂停之前的内容后面，不会产生视频分段。

**请求 Body 参数说明**

| 参数        | 类型   | 必填 | 说明                                                                       |
|-------------|--------|-----|--------------------------------------------------------------------------|
| Action      | string | 是   | 请求操作类型，恢复录制为 `Resume`                                           |
| Data        | object | 是   | 请求协议参数                                                               |
| Data.TaskID | string | 是   | 需要恢复录制的录制任务 ID，录制任务 ID 可以在开始录制的接口返回参数中获取到 |

**请求 Body 示例**

```json
{
  "Action": "Resume",
  "Data": {
    "TaskID": "0f7d9522-a1a3-4517-b5ad-7a6ecaf9c419"
  }
}
```

**返回参数说明**

| 参数         | 类型   | 必填 | 说明                                             |
|--------------|--------|-----|------------------------------------------------|
| ErrorCode    | string | 否   | 错误类型，只有请求出错的时候才会返回此字段        |
| ErrorMessage | string | 否   | 错误说明，只有请求出错的时候才会返回此字段        |
| TaskID       | string | 否   | 录制任务 ID，只有开始录制成功的时候才会返回此字段 |
| RequestID    | string | 否   | 请求 ID                                          |

**返回参数示例**

```json
// 成功返回
{
    "TaskID": "d1806f20-25b8-4c30-8176-c0832bf84e02",
    "RequestID": "95941e2c85898384a95b81c2a542ea15"
}

// 失败返回
{
    "ErrorCode": "InvalidParam",
    "ErrorMessage": "TaskID missing",
    "RequestID": "95941e2c85898384a95b81c2a542ea15"
}
```

#### 录制页面刷新接口

使用`录制页面刷新`接口可以触发录制页面重新刷新。

**请求 Body 参数说明**

| 参数        | 类型   | 必填 | 说明                                                                       |
|-------------|--------|-----|--------------------------------------------------------------------------|
| Action      | string | 是   | 请求操作类型，刷新页面为 `Refresh`                                            |
| Data        | object | 是   | 请求协议参数                                                               |
| Data.TaskID | string | 是   | 需要刷新录制页面的录制任务 ID，录制任务 ID 可以在开始录制的接口返回参数中获取到 |

**请求 Body 示例**

```json
{
  "Action": "Refresh",
  "Data": {
    "TaskID": "0f7d9522-a1a3-4517-b5ad-7a6ecaf9c419"
  }
}
```

**返回参数说明**

| 参数         | 类型   | 必填 | 说明                                             |
|--------------|--------|-----|------------------------------------------------|
| ErrorCode    | string | 否   | 错误类型，只有请求出错的时候才会返回此字段        |
| ErrorMessage | string | 否   | 错误说明，只有请求出错的时候才会返回此字段        |
| TaskID       | string | 否   | 录制任务 ID，只有开始录制成功的时候才会返回此字段 |
| RequestID    | string | 否   | 请求 ID                                          |

**返回参数示例**

```json
// 成功返回
{
    "TaskID": "d1806f20-25b8-4c30-8176-c0832bf84e02",
    "RequestID": "95941e2c85898384a95b81c2a542ea15"
}

// 失败返回
{
    "ErrorCode": "InvalidParam",
    "ErrorMessage": "TaskID missing",
    "RequestID": "95941e2c85898384a95b81c2a542ea15"
}
```

#### 停止录制接口

使用 `停止录制` 接口发起结束录制请求。

**请求 Body 参数说明**

| 参数        | 类型   | 必填 | 说明                                                                   |
|-------------|--------|-----|----------------------------------------------------------------------|
| Action      | string | 是   | 请求操作类型，结束录制为 `Stop`                                         |
| Data        | object | 是   | 请求协议参数                                                           |
| Data.TaskID | string | 是   | 需要停止的录制任务 ID，录制任务 ID 可以在开始录制的接口返回参数中获取到 |

**请求 Body 示例**

```json
{
  "Action": "Stop",
  "Data": {
    "TaskID": "0f7d9522-a1a3-4517-b5ad-7a6ecaf9c419"
  }
}
```

**返回参数说明**

| 参数         | 类型   | 必填 | 说明                                             |
|--------------|--------|-----|------------------------------------------------|
| ErrorCode    | string | 否   | 错误类型，只有请求出错的时候才会返回此字段        |
| ErrorMessage | string | 否   | 错误说明，只有请求出错的时候才会返回此字段        |
| TaskID       | string | 否   | 录制任务 ID，只有开始录制成功的时候才会返回此字段 |
| RequestID    | string | 否   | 请求 ID                                          |

**返回参数示例**

```json
// 成功返回
{
    "TaskID": "d1806f20-25b8-4c30-8176-c0832bf84e02",
    "RequestID": "95941e2c85898384a95b81c2a542ea15"
}

// 失败返回
{
    "ErrorCode": "InvalidParam",
    "ErrorMessage": "TaskID missing",
    "RequestID": "95941e2c85898384a95b81c2a542ea15"
}
```

#### 查询录制任务信息接口

使用`查询任务信息`接口发起查询录制任务信息请求。

**请求 Body 参数说明**

| 参数        | 类型   | 必填 | 说明                                                                   |
|-------------|--------|-----|----------------------------------------------------------------------|
| Action      | string | 是   | 请求操作类型，查询录制任务信息为 `Describe`                             |
| Data        | object | 是   | 请求协议参数                                                           |
| Data.TaskID | string | 是   | 需要查询的录制任务 ID，录制任务 ID 可以在开始录制的接口返回参数中获取到 |

**请求 Body 示例**

```json
{
  "Action": "Describe",
  "Data": {
    "TaskID": "0f7d9522-a1a3-4517-b5ad-7a6ecaf9c419"
  }
}
```

**返回参数说明**

| 参数                   | 类型     | 必填 | 说明                                                                                                                                                                                                                                                                                                                                                                                                           |
|------------------------|----------|-----|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| ErrorCode              | string   | 否   | 错误类型，只有请求出错的时候才会返回                                                                                                                                                                                                                                                                                                                                                                            |
| ErrorMessage           | string   | 否   | 错误说明，只有请求出错的时候才会返回                                                                                                                                                                                                                                                                                                                                                                            |
| TaskID                 | string   | 否   | 录制任务 ID，只有开始录制成功的时候才会返回                                                                                                                                                                                                                                                                                                                                                                     |
| RequestID              | string   | 否   | 请求 ID                                                                                                                                                                                                                                                                                                                                                                                                        |
| Status                 | string   | 否   | 录制任务当前状态，可能的取值及其含义如下： <br> normal -- 录制任务创建成功，但录制任务还没有开始录制 <br> recording -- 录制任务正在录制中 <br> canceled -- 录制任务已经被取消 <br> transcode -- 录制任务正在对录制视频进行拼接、转码等操作 <br> upload -- 录制任务正在上传录制视频到云存储 <br> callback -- 录制任务正在把录制结果通过发起录制时配置的回调地址进行通知 <br> finished -- 录制任务的所有操作已经完成 |
| CreateTime             | int      | 否   | 录制任务创建时间戳，单位 s，                                                                                                                                                                                                                                                                                                                                                                                     |
| StartTime              | int      | 否   | 录制任务开始录制时间戳，单位 s，只有开始录制后才会返回此字段                                                                                                                                                                                                                                                                                                                                                     |
| CancelTime             | int      | 否   | 录制任务被取消的时间戳，单位 s，只有发起过取消录制请求才会返回此字段                                                                                                                                                                                                                                                                                                                                             |
| StopTime               | int      | 否   | 录制任务结束录制时间戳，单位 s，只有录制任务停止后才会返回此字段                                                                                                                                                                                                                                                                                                                                                 |
| FinishTime             | int      | 否   | 录制任务完成录制时间戳，单位 s，只有录制任务完成所有录制处理后才会返回此字段                                                                                                                                                                                                                                                                                                                                     |
| Result                 | object   | 否   | 录制任务结果                                                                                                                                                                                                                                                                                                                                                                                                   |
| Result.ErrorCode       | string   | 否   | 录制任务出错类型，只有录制任务执行过程中出现错误时才会返回此字段                                                                                                                                                                                                                                                                                                                                                |
| Result.ErrorMessage    | string   | 否   | 录制任务出错信息，只有录制任务执行过程中出现错误时才会返回此字段                                                                                                                                                                                                                                                                                                                                                |
| Result.Videos          | []object | 否   | 录制视频文件列表                                                                                                                                                                                                                                                                                                                                                                                               |
| Result.Videos.Filename | string   | 否   | 视频文件名称                                                                                                                                                                                                                                                                                                                                                                                                   |
| Result.Videos.FileSize | int      | 否   | 视频文件大小                                                                                                                                                                                                                                                                                                                                                                                                   |
| Result.Videos.FileURL  | string   | 否   | 视频文件链接                                                                                                                                                                                                                                                                                                                                                                                                   |

**返回参数示例**

```json
// 成功返回
{
    "TaskID": "7a035551-d9d6-494e-b604-fa787b0845b3",
    "RequestID": "95941e2c85898384a95b81c2a542ea15",
    "CreateTime": 1620982173,
    "Status": "finished",
    "StartTime": 1620982177,
    "CancelTime": 1620982203,
    "StopTime": 1620982203,
    "FinishTime": 1620982210,
    "Result": {
        "Videos": [
            {
                "Filename": "1621406865789.mp4",
                "FileSize": 169780,
                "FileURL": "http://web-record-1259648581.cos.ap-chengdu.myqcloud.com/4d0f336d-4de4-4fc8-b505-d1f790974909/1621406865789.mp4"
            }
        ]
    }
}

// 请求出错返回
{
    "ErrorCode": "InvalidParam",
    "ErrorMessage": "TaskID missing",
    "RequestID": "95941e2c85898384a95b81c2a542ea15"
}

// 录制任务出错返回
{
    "TaskID": "7a035551-d9d6-494e-b604-fa787b0845b3",
    "RequestID": "95941e2c85898384a95b81c2a542ea15",
    "CreateTime": 1620982173,
    "Status": "finished",
    "StartTime": 1620982177,
    "CancelTime": 1620982203,
    "StopTime": 1620982203,
    "FinishTime": 1620982210,
    "Result": {
        "ErrorCode": "CallbackFailed",
        "ErrorMessage": "Callback failed even all tries. last error message:ECONNABORTED:timeout of 2000ms exceeded"
    }
}
```
