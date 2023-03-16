const VodUploadClient = require("./src/client");
const { VodUploadRequest, VodUploadResponse} = require("./src/model");
const TencentCloud = require("./tencentcloud-sdk-nodejs");

module.exports = {
    VodUploadClient: VodUploadClient,
    VodUploadRequest: VodUploadRequest,
    VodUploadResponse: VodUploadResponse,
    TencentCloud: TencentCloud
};
