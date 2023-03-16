const cloud = require("../tencentcloud-sdk-nodejs");
const cloudModel = cloud.vod.v20180717.Models;

class VodUploadRequest extends cloudModel.ApplyUploadRequest {
    constructor() {
        super();
        this.MediaFilePath = null;
        this.CoverFilePath = null;
        this.ConcurrentUploadNumber = null;
    }
}

class VodUploadResponse extends cloudModel.CommitUploadResponse {
    constructor() {
        super();
    }
}

module.exports = {
    VodUploadRequest: VodUploadRequest,
    VodUploadResponse: VodUploadResponse
};
