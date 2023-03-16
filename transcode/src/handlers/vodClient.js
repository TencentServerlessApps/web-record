const {VodUploadClient, VodUploadRequest, TencentCloud} = require("vod-sdk");
const VodClient = TencentCloud.vod.v20180717.Client;
const VodModel = TencentCloud.vod.v20180717.Models;
const Credential = TencentCloud.common.Credential;
const {config, logger} = require("common");

class VodClientWrapper {
	constructor(region, secretId, secretKey, token) {
		this.secretId = secretId || null;
		this.secretKey = secretKey || null;
		this.token = token || null;
		this.region = region || null;
		this.vodSessionKey = null;
		this.subAppId = null;

		const cred = new Credential(this.secretId, this.secretKey, this.token);
		this.cloudClient = new VodClient(cred, this.region);
		this.vodUploadClient = new VodUploadClient(this.secretId, this.secretKey);
	}


	async applyVodUpload(request) {
		let applyUploadRequest = new VodModel.ApplyUploadRequest();
		applyUploadRequest.from_json_string(request.to_json_string());
		logger.log("vod apply request: ", applyUploadRequest);
		return await this.vodUploadClient.applyUpload(this.cloudClient, applyUploadRequest);
	}


	async commitVodUpload(vodSessionKey, subAppId) {
		let commitUploadRequest = new VodModel.CommitUploadRequest();
		commitUploadRequest.VodSessionKey = vodSessionKey;
		if (subAppId) {
			commitUploadRequest.SubAppId = subAppId;
		}
		logger.log("vod commit request: ", commitUploadRequest);
		return await this.vodUploadClient.commitUpload(this.cloudClient, commitUploadRequest);
	}

	async describeMediaInfo(fileId, subAppId) {
		let fileIds = [];
		let filters = [];
		fileIds.push(fileId);
		filters.push("metaData");

		let describeMediaInfosRequest = new VodModel.DescribeMediaInfosRequest();
		describeMediaInfosRequest.FileIds = fileIds;
		describeMediaInfosRequest.Filters = filters;
		if (subAppId) {
			describeMediaInfosRequest.SubAppId = subAppId;
		}

		logger.log("vod describe media info request: ", describeMediaInfosRequest);

		return new Promise(
			(resolve, reject) => {
				this.cloudClient.DescribeMediaInfos(describeMediaInfosRequest, function (err, describeMediaInfosResponse) {
					if (err) {
						reject(err);
					} else {
						let response = new VodModel.DescribeMediaInfosResponse();
						response.from_json_string(describeMediaInfosResponse.to_json_string());
						resolve(response);
					}
				});
			},
		);
	}

	setVodSessionKey(vodSessionKey) {
		this.vodSessionKey = vodSessionKey;
	}

	setSubAppId(subAppId) {
		this.subAppId = subAppId;
	}

	getVodSessionKey() {
		return this.vodSessionKey;
	}

	getSubAppId() {
		return this.subAppId;
	}

	wait(ms) {
		return new Promise(resolve => setTimeout(() => resolve(), ms));
	};

}

module.exports = VodClientWrapper;
