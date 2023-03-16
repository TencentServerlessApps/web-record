const { FileUtil, StringUtil } = require("./common");
const VodClientException = require("./exception");
const { VodUploadResponse } = require("./model");
const cloud = require("../tencentcloud-sdk-nodejs");
const COS = require('cos-nodejs-sdk-v5');
const fs = require('fs');
const path = require('path');

const VodClient = cloud.vod.v20180717.Client;
const VodModel = cloud.vod.v20180717.Models;
const Credential = cloud.common.Credential;

class VodUploadClient {
    constructor(secretId, secretKey, token) {
        this.secretId = secretId || null;
        this.secretKey = secretKey || null;
        this.token = token || null;
        this.ignoreCheck = false;
    }

    upload(region, request, callback) {
        this.handleUpload(region, request).then(data => callback(null, data)).catch(err => callback(err, null));
    }

    async handleUpload(region, request) {
        const cred = new Credential(this.secretId, this.secretKey, this.token);
        const cloudClient = new VodClient(cred, region);

        if (!this.ignoreCheck) {
            this.prefixCheckAndSetDefaultVal(region, request);
        }

        let parsedManifestList = [];
        let segmentFilePathList = [];
        if (this.isManifestMediaType(request.MediaType)) {
            await this.parseManifest(cloudClient, request.MediaFilePath, request.MediaType, parsedManifestList, segmentFilePathList);
        }

        let applyUploadRequest = new VodModel.ApplyUploadRequest();
        applyUploadRequest.from_json_string(request.to_json_string());
        let applyUploadResponse = await this.applyUpload(cloudClient, applyUploadRequest);

        let cosClient;
        if (applyUploadResponse.TempCertificate == null) {
            cosClient = new COS({
                SecretId: this.secretId,
                SecretKey: this.secretKey
            })
        } else {
            cosClient = new COS({
                SecretId: applyUploadResponse.TempCertificate.SecretId,
                SecretKey: applyUploadResponse.TempCertificate.SecretKey,
                XCosSecurityToken: applyUploadResponse.TempCertificate.Token
            });
        }

        if (StringUtil.isNotEmpty(request.MediaType) && StringUtil.isNotEmpty(applyUploadResponse.MediaStoragePath)) {
            await this.cosUpload(cosClient, applyUploadResponse.StorageBucket, applyUploadResponse.StorageRegion, applyUploadResponse.MediaStoragePath, request.MediaFilePath);
        }
        if (StringUtil.isNotEmpty(request.CoverType) && StringUtil.isNotEmpty(applyUploadResponse.CoverStoragePath)) {
            await this.cosUpload(cosClient, applyUploadResponse.StorageBucket, applyUploadResponse.StorageRegion, applyUploadResponse.CoverStoragePath, request.CoverFilePath);
        }
        if (segmentFilePathList.length > 0) {
            for (const segmentFilePath of segmentFilePathList) {
                let storageDir = path.dirname(applyUploadResponse.MediaStoragePath);
                let mediaFileDir = path.dirname(request.MediaFilePath);
                let segmentRelativeFilePath = segmentFilePath.substring(mediaFileDir.length).replace(/\\/g, '/');
                let segmentStoragePath = path.join(storageDir, segmentRelativeFilePath);
                await this.cosUpload(cosClient, applyUploadResponse.StorageBucket, applyUploadResponse.StorageRegion, segmentStoragePath, segmentFilePath);
            }
        }

        let commitUploadRequest = new VodModel.CommitUploadRequest();
        commitUploadRequest.VodSessionKey = applyUploadResponse.VodSessionKey;
        commitUploadRequest.SubAppId = request.SubAppId;
        return await this.commitUpload(cloudClient, commitUploadRequest);
    }

    cosUpload(cosClient, bucket, region, key, filePath) {
        return new Promise(
            (resolve, reject) => {
                cosClient.sliceUploadFile({
                    Bucket: bucket,
                    Region: region,
                    Key: key,
                    FilePath: filePath
                }, function (err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            }
        );
    }

    applyUpload(cloudClient, applyUploadRequest) {
        return new Promise(
            (resolve, reject) => {
                cloudClient.ApplyUpload(applyUploadRequest, function (err, applyUploadResponse) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(applyUploadResponse);
                    }
                });
            }
        );
    }

    commitUpload(cloudClient, commitUploadRequest) {
        return new Promise(
            (resolve, reject) => {
                cloudClient.CommitUpload(commitUploadRequest, function (err, commitUploadResponse) {
                    if (err) {
                        reject(err);
                    } else {
                        let response = new VodUploadResponse();
                        response.from_json_string(commitUploadResponse.to_json_string());
                        resolve(response);
                    }
                })
            }
        );
    }

    parseStreamingManifest(cloudClient, parseStreamingManifestRequest) {
        return new Promise(
            (resolve, reject) => {
                cloudClient.ParseStreamingManifest(parseStreamingManifestRequest, function (err, parseStreamingManifestResponse) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(parseStreamingManifestResponse);
                    }
                })
            }
        );
    }

    async parseManifest(apiClient, manifestFilePath, manifestMediaType, parsedManifestList, segmentFilePathList) {
        if (parsedManifestList.includes(manifestFilePath)) {
            return;
        }
        parsedManifestList.push(manifestFilePath);

        const content = await fs.readFileSync(manifestFilePath);
        let parseStreamingManifestRequest = new VodModel.ParseStreamingManifestRequest();
        parseStreamingManifestRequest.MediaManifestContent = content.toString();
        parseStreamingManifestRequest.ManifestType = manifestMediaType;
        let parseStreamingManifestResponse = await this.parseStreamingManifest(apiClient, parseStreamingManifestRequest);

        if (parseStreamingManifestResponse.MediaSegmentSet.length > 0) {
            for (const segment of parseStreamingManifestResponse.MediaSegmentSet) {
                let mediaType = FileUtil.getFileType(segment);
                let mediaFilePath = path.join(path.dirname(manifestFilePath), segment)
                if (!FileUtil.isFileExist(mediaFilePath)) {
                    throw new VodClientException("invalid segment path")
                }
                segmentFilePathList.push(mediaFilePath);
                if (this.isManifestMediaType(mediaType)) {
                    await this.parseManifest(apiClient, mediaFilePath, mediaType, parsedManifestList, segmentFilePathList);
                }
            }
        }
    }

    isManifestMediaType(mediaType) {
        return mediaType === "m3u8" || mediaType === "mpd";
    }

    prefixCheckAndSetDefaultVal(region, request) {
        if (StringUtil.isEmpty(region)) {
            throw new VodClientException("lack region");
        }
        if (StringUtil.isEmpty(request.MediaFilePath)) {
            throw new VodClientException("lack media path");
        }
        if (!FileUtil.isFileExist(request.MediaFilePath)) {
            throw new VodClientException("media path is invalid");
        }
        if (StringUtil.isEmpty(request.MediaType)) {
            let videoType = FileUtil.getFileType(request.MediaFilePath);
            if (StringUtil.isEmpty(videoType)) {
                throw new VodClientException("lack media type");
            }
            request.MediaType = videoType;
        }
        if (StringUtil.isEmpty(request.MediaName)) {
            request.MediaName = FileUtil.getFileName(request.MediaFilePath);
        }

        if (StringUtil.isNotEmpty(request.CoverFilePath)) {
            if (!FileUtil.isFileExist(request.CoverFilePath)) {
                throw new VodClientException("cover path is invalid");
            }
            if (StringUtil.isEmpty(request.CoverType)) {
                let coverType = FileUtil.getFileType(request.CoverFilePath);
                if (StringUtil.isEmpty(coverType)) {
                    throw new VodClientException("lack cover type");
                }
                request.CoverType = coverType;
            }
        }
    }
}

module.exports = VodUploadClient;
