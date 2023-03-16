FROM web-record-base:latest

# 拷贝函数代码
WORKDIR /usr/local/app 
COPY . .

EXPOSE 9000
WORKDIR /usr/local/app/transcode

RUN chmod +x ./bin/ffmpeg 
RUN cp ./bin/ffmpeg /usr/local/bin/ffmpeg

ENTRYPOINT [ "npm", "run", "start" ]
