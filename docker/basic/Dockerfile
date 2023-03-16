FROM centos:7.7.1908

RUN mkdir /data && ln -s /tmp /data/L5Backup
RUN yum -y install epel-release \
    && yum -y update \
    && yum -y install \
        iproute \
        perl \
        libmemcached \
        pango.x86_64 \
        libXcomposite.x86_64 \
        libXcursor.x86_64 \
        libXdamage.x86_64 \
        libXext.x86_64 \
        libXi.x86_64 \
        libXtst.x86_64 \
        cups-libs.x86_64 \
        libXScrnSaver.x86_64 \
        libXrandr.x86_64 \
        GConf2.x86_64 \
        alsa-lib.x86_64 \
        atk.x86_64 \
        gtk3.x86_64 \
        nss.x86_64 \
        ttmkfdir \
        wget \
        unzip \
        which \
        gcc \
        gcc-c++ \
        glibc-static \
        libstdc++-static \
        wqy* \
    && yum clean all \
    && ln -s /usr/lib64/libsasl2.so.3 /usr/lib64/libsasl2.so.2

RUN mkdir -p -m 775 /usr/share/fonts/chinese
# COPY simsun.ttc /usr/share/fonts/chinese/
COPY msyh.ttf /usr/share/fonts/chinese/
RUN ttmkfdir -e /usr/share/X11/fonts/encodings/encodings.dir
COPY fonts.conf /etc/fonts/
RUN fc-cache

# 安装 node12.x
RUN wget https://nodejs.org/dist/latest-v12.x/node-v12.22.12-linux-x64.tar.gz -O /tmp/node-v12.22.12-linux-x64.tar.gz \
    && tar zxvf /tmp/node-v12.22.12-linux-x64.tar.gz -C /usr/local \
    && ln -sf /usr/local/node-v12.22.12-linux-x64/bin/node /usr/bin/node \
    && ln -sf /usr/local/node-v12.22.12-linux-x64/bin/npm /usr/bin/npm \
    && rm /tmp/node-v12.22.12-linux-x64.tar.gz
