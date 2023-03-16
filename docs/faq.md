## 问题集锦

### 录制没有声音问题

测试过程中出现多媒体无法自动播放的问题：

```
pageerror [Error: RtcError: NotAllowedError: autoplay is not allowed in the current browser,
refer to https://trtc-1252463788.file.myqcloud.com/web/docs/tutorial-11-advanced-auto-play-policy.html <PLAY_NOT_ALLOWED 0x4043>
https://trtc-1252463788.file.myqcloud.com/web/docs/module-ErrorCode.html at RemoteStream._callee$
(https://web.sdk.qcloud.com/trtc/webrtc/test/tyros-test/dist/trtc.js:19280:24) at tryCatch
(https://web.sdk.qcloud.com/trtc/webrtc/test/tyros-test/dist/trtc.js:1308:41) at Generator.invoke [as _invoke]
(https://web.sdk.qcloud.com/trtc/webrtc/test/tyros-test/dist/trtc.js:1538:23) at Generator.throw
(https://web.sdk.qcloud.com/trtc/webrtc/test/tyros-test/dist/trtc.js:1363:22) at asyncGeneratorStep
(https://web.sdk.qcloud.com/trtc/webrtc/test/tyros-test/dist/trtc.js:848:25) at _throw
(https://web.sdk.qcloud.com/trtc/webrtc/test/tyros-test/dist/trtc.js:874:10)]
```

这个问题由于 chrome 的 autoplay police 引起，带有声音的音视频页面需要用户操作才能允许自动播放。

> Chrome's autoplay policies are simple:
>
> - Muted autoplay is always allowed.
> - Autoplay with sound is allowed if:
>   - User has interacted with the domain (click, tap, etc.).
>   - On desktop, the user's Media Engagement Index threshold has been crossed, meaning the user has previously played video with sound.
>   - The user has added the site to their home screen on mobile or installed the PWA on desktop.
>   - Top frames can delegate autoplay permission to their iframes to allow autoplay with sound.

对于开发者，chrome 针对这种情况提供相应的启动参数，允许开发者修改 autoplay police 的行为。

> As a developer, you may want to change Chrome autoplay policy behavior locally to test your website depending on user engagement.
>
> - You can disable entirely the autoplay policy by using an internal switch with chrome.exe --autoplay-policy=no-user-gesture-required. This allows you to test your website as if user were strongly engaged with your site and playback autoplay would be always allowed.
>
> - You can also decide to make sure playback autoplay is never allowed by disabling use of MEI, applying autoplay policy to Web Audio, and whether sites with the highest overall MEI get playback autoplay by default for new users. This can be done with three internal switches with chrome.exe --disable-features=PreloadMediaEngagementData, MediaEngagementBypassAutoplayPolicies.

所以我们可以在 chrome 启动参数中增加以下选项来解决多媒体无法自动播放的问题

```
--autoplay-policy=no-user-gesture-required
```

参考 ： [Autoplay Policy Changes](https://developers.google.com/web/updates/2017/09/autoplay-policy-changes)

### 插件启动问题

todo: 补充说明插件启动遇到的问题

### 云函数冷启动时长过长问题

在测试过程中发现各个模块的函数在冷启动的时候，每次都需要耗时 3s 以上，特别是开始录制接口，由于需要在`dispatch`模块中 invoke `record`函数，接口响应时间更是高达 7s 以上。这种高响应时间对用户体验的影响很不好，需要对这种情况进行优化。

从云函数侧了解到，云函数冷启动响应时间根据函数的性质时间组成有一定的区别。

- 同步函数 - 同步函数的响应时间计算公式为：链路耗时 + 函数镜像启动耗时 + 函数执行时间
- 异步函数 - 异步函数的响应时间计算公式为：链路耗时 + 函数镜像启动耗时

服务中除了`dispatch`函数是同步函数，通过 API 网关触发器触发，其他模块函数都是异步函数，通过云 API 进行函数触发。从每个模块函数冷启动耗时差不多都是 3s 来看，可以推断出应该是`链路耗时+函数镜像启动耗时`差不多需要 3s。

以一次`Describe`的过程来分析，总耗时为 3.34s, 其中 postman 的 socket 初始化耗时 476ms, 剩下的请求耗时为 2.86s。

![Describe](./resources/describe.png)

从业务函数打印出来的初始化耗时为 433ms

![Initial](./resources/initial.png)

另外从云函数平台的日志可以看到容器启动时的详细耗时

![scf](./resources/scf.png)

综合以上的数据，可以得出以下的耗时分布：

**函数镜像启动耗时(2483ms) = 容器启动(436ms) + 下载代码(384ms) + 解压代码(830ms) + 进程启动(833ms = node bootstrap(400ms) + 业务代码初始化(433ms))**

解决办法：

1. 减小代码包大小

通过代码大小分析，其中代码量占用最大的是业务依赖的腾讯云 NodeJS SDK 包 `tencentcloud-sdk-nodejs`, 共有 33M, 占了整个云函数代码包的 66%，所以可以想办法减小这个依赖包的大小。由于业务只需要用到其中 SCF 相关的接口，可以把其他服务的代码/文件都删掉，这样可以把`tencentcloud-sdk-nodejs`的大小减小到 100K 左右。云函数代码包整体大小由原来的 55M 减小到 22M。

2. 避免冷启动

既然这里的耗时是由于镜像冷启动产生，从“解决不了问题，那就解决产生问题的人” 这个解决来考虑的话，只要用户在调用接口的时候，保证云函数不是冷启动就可以了。云函数运行结束后，函数实例会持续保留一段时间，可以通过增加一个定时触发器，定时把函数唤起，保证至少存在一个空闲函数实例。（**todo: 在并发量大的时候，怎么保证一直有空闲函数实例？**）

另外还有个办法就是在云函数控制台上设置预置并发，但是这个方法成本太高。。。

### 录制结果存在黑边问题解决

与空中课堂进行联调的时候发现录制结果存在黑边，且页面内容被压缩在黑边之间的范围，与预期不符，结果如下：

![kzktres](./resources/kzktres.png)

--window-size

page.setViewport

### WebRecord 内存优化

页面录制的时候，通过 extension 的方式，调用 `chrome.tabCapture.capture` 方法获取到 tab 页画面流，然后通过 `MediaRecorder` 对流进行处理，转换成可以保存的视频数据，通过 `chrome download` 的方式，把拿到的数据保存到本地文件。在测试的过程中，发现录制函数内存占用一直在上涨，下面是对一个高清视频进行录制的内存消耗情况，从图中可以看到在不到 2 个小时的时间里，内存占用直接增长到了将近 4G。

![membefore](./resources/membefore.png)

这种情况疑似存在内存泄漏，但是不管是通过 NodeJS 的 inspect 进行调试和 profile 都没有发现内存泄漏的情况。

从云函数侧了解到，目前监控视图上的运行内存曲线其实是包含了 cache 的，而我们的函数存在文件读写操作，所以 cache 会上涨是正常的。

不过通过 `puppeteer` 提供的 `page.exposeFunction` 方式与 `chrome` 进行 IPC 通信，把保存音视频数据从 `chrome` 转移到 `NodeJS` 来实现，可以有效的优化整个函数的内存管理。调整之后，对相同的高清视频进行录制 2 个小时左右，内存占用将近 2G, 比优化之前减少了 50%以上。

![memafter](./resources/memafter.png)

### 录制画面模糊问题优化

替换字体前（宋体），黑体不够黑, 对比不明显

![fontBefore](./resources/fontSimSun.png)

替换字体后（文泉驿）

![fontWqy](./resources/fontWqy.png)

但是，就算是换了字体，效果仍然比不上本地直接用浏览器查看

![local](./resources/local.png)
