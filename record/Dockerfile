FROM web-record-base:latest
MAINTAINER tencent-serverless

# 安装xvfb、pulse-audio等必备依赖软件
RUN yum -y install xorg-x11-server-Xvfb pulseaudio pulseaudio-utils alsa-plugins-pulseaudio \
    && yum clean all

# 安装chrome
ADD ./libs/chrome.zip /usr/local/

# 拷贝函数代码
WORKDIR /usr/local/app 
COPY . .

RUN chmod +x ./record/bin/webm_info

EXPOSE 9000
WORKDIR /usr/local/app/record
# 捕获未 catch 的 promise 异常
ENTRYPOINT [ "node", "--unhandled-rejections=strict", "server.js" ]
