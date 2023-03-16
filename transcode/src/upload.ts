import COS from 'cos-nodejs-sdk-v5';
import stream from 'stream';
import fs from 'fs';
import path from 'path';
import {cosRetry} from './index';
import {exponentialBackoffSleep, sleep} from './utils';

const {logger} = require('common');
export var totalSize = 0;

export async function uploadStream(cos: COS, s: stream.Readable, params: {
    Region: string;
    Bucket: string;
    Key: string;
}) {
    console.log(`start multi part upload to bucket`, params.Bucket);
    let uploadId = '';
    for (let i = 0; i < cosRetry; i++) {
        try {
            const res = await cos.multipartInit(params);
            uploadId = res.UploadId;
            break;
        } catch (err) {
            logger.log(`attempts ${i} init multipart error:`, err);
            if (i + 1 == cosRetry) {
                logger.log('init multipart fail:', err);
                throw err;
            }
        }
        await exponentialBackoffSleep(1000, i, 1000 * 30);
    }

    logger.log(`init upload complete, uploadId: ${uploadId}`);

    let totalPart = 0;
    let uploadPromiseList: Promise<COS.Part>[] = [];

    async function uploadBufferList(partNumber: number, buffer: Buffer) {
        totalSize += buffer.byteLength ?? 0;
        logger.log(`PartNumber ${partNumber}, totalSize: ${totalSize / (1024 * 1024)}`);
        for (let i = 0; i < cosRetry; i++) {
            try {
                const res = await cos.multipartUpload({
                    UploadId: uploadId,
                    Body: buffer,
                    PartNumber: `${partNumber}` as any,
                    ...params
                });

                logger.log(`upload part success: ${partNumber}`);
                let etag = res.ETag;
                if (etag.startsWith("\"")) {
                    etag = etag.slice(1, etag.length - 1);
                }

                return {ETag: etag, PartNumber: partNumber};
            } catch (err) {
                logger.log(`attempts ${i} upload part error: ${partNumber}, reason: ${err}`);
                if (i + 1 == cosRetry) {
                    logger.log(`upload part fail: ${partNumber}, reason: ${err}`);
                    throw err;
                }
            }
            await exponentialBackoffSleep(1000, i, 1000 * 30);
        }

        throw `upload part fail: ${partNumber}`;
    }

    let bufferList: Buffer[] = [];
    let bufferSize = 0;

    s.on('data', (data) => {
        bufferList.push(data);
        bufferSize += data.byteLength;
        if (bufferSize > 5 * 1024 * 1024) {
            totalPart++;
            const partNumber = totalPart;
            const buffer = Buffer.concat(bufferList);
            bufferList = [];
            bufferSize = 0;
            uploadPromiseList.push(uploadBufferList(partNumber, buffer));
        }
    })

    await new Promise<void>(resolve => s.on('end', () => {
        logger.log('ffmpeg output stream ended');
        resolve();
    }));


    if (bufferSize > 0) {
        totalPart++;
        const partNumber = totalPart;
        const buffer = Buffer.concat(bufferList);
        bufferList = [];

        uploadPromiseList.push(uploadBufferList(partNumber, buffer));
    }

    const partList = await Promise.all(uploadPromiseList);

    logger.log(partList);
    partList.sort((a, b) => {
        return a.PartNumber - b.PartNumber
    })

    for (let i = 0; i < cosRetry; i++) {
        try {
            await cos.multipartComplete({
                UploadId: uploadId,
                ...params,
                Parts: partList
            });
            break;
        } catch (err) {
            logger.log(`attempts ${i} multipart complete error`, err);
            if (i + 1 == cosRetry) {
                logger.log(`multi part complete fail, reason: ${err}`);
                throw err;
            }
        }
        await exponentialBackoffSleep(1000, i, 1000 * 30);
    }

    logger.log('multi part complete success');
}

export async function uploadFolder(cos: COS, baseDir: string, params: {
    Region: string;
    Bucket: string;
    BaseKey: string;
    TargetName: string;
}, checkEnd: () => boolean) {
    let maxGenerate = 0;

    while (!checkEnd()) {
        const files = await fs.promises.readdir(baseDir);

        console.log('upload from basedir', baseDir);
        console.log('exist files: ', files);
        for (let file of files) {
            if (file.includes("m3u8")) {
                continue;
            }
            const num = parseInt(file.replace(params.TargetName, '').replace('.ts', ''), 10);
            if (num > maxGenerate) {
                maxGenerate = num;
                console.log(`Current max generate file ${maxGenerate}`);
            }
        }
        for (let file of files) {
            if (file.includes("m3u8")) {
                continue;
            }
            const num = parseInt(file.replace(params.TargetName, '').replace('.ts', ''), 10);
            if (num < maxGenerate) {
                const filePath = path.join(baseDir, file);
                const key = path.join(params.BaseKey, path.basename(file));
                console.log(`start upload file ${filePath} to ${key}`);
                for (let i = 0; i < cosRetry; i++) {
                    try {
                        const data = await fs.promises.readFile(filePath);
                        await cos.putObject({
                            Bucket: params.Bucket,
                            Region: params.Region,
                            Key: key,
                            Body: data,
                        });
                        await fs.promises.unlink(filePath);
                        console.log(`upload file ${filePath} to ${key} success`);
                        break;
                    } catch (err) {
                        const files = await fs.promises.readdir(baseDir);
                        console.log('when error exist files: ', files);
                        logger.log(`attempts ${i} file ${key} upload error`, err);
                        if (i + 1 == cosRetry) {
                            logger.log(`file upload file, reason: ${err}`);
                            throw err;
                        }
                    }
                }
            }
        }

        await sleep(1000);
    }

    const files = await fs.promises.readdir(baseDir);
    for (let file of files) {
        const filePath = path.join(baseDir, file);
        const key = path.join(params.BaseKey, path.basename(file));
        for (let i = 0; i < cosRetry; i++) {
            try {
                console.log(`Upload file ${filePath} to ${key}`);
                const data = await fs.promises.readFile(filePath);
                await cos.putObject({
                    Bucket: params.Bucket,
                    Region: params.Region,
                    Key: key,
                    Body: data,
                });
                await fs.promises.unlink(filePath);
                console.log(`upload file ${filePath} to ${key} success`);
                break;
            } catch (err) {
                logger.log(`attempts ${i} file ${key} upload error`, err);
                if (i + 1 == cosRetry) {
                    logger.log(`file upload file, reason: ${err}`);
                    throw err;
                }
            }
        }
    }
}

export async function uploadFile(cos: COS, localFile: string, params: {
    Region: string;
    Bucket: string;
    Key: string;
    TargetName: string;
}, checkEnd: () => boolean) {
    while (!checkEnd()) {
        await sleep(1000);
    }
    logger.log('upload cos param: bucket %s, region %s, key %s, localFile: %s', params.Bucket, params.Region, params.Key, localFile);
    if (!fs.existsSync(localFile)) {
        logger.log('[Error]localFile[%s] not exist, no need to upload', localFile);
        throw 'localFile not exist, no need to upload';
    }
    let stats = fs.statSync(localFile);
    logger.log(`local file ${localFile} size ${stats.size}`);
    logger.log(`start upload file ${localFile} to ${params.Key}`);
    for (let i = 0; i < cosRetry; i++) {
        try {
            await cos.putObject({
                Bucket: params.Bucket,
                Region: params.Region,
                Key: params.Key,
                Body: fs.createReadStream(localFile)
            });
            await fs.promises.unlink(localFile);
            logger.log(`upload file ${localFile} to ${params.Key} success`);
            break;
        } catch (err) {
            logger.log(`attempts ${i} file ${localFile} upload error`, err);
            if (i + 1 == cosRetry) {
                logger.log(`file upload file, reason: ${err}`);
                throw err;
            }
        }
    }
}
