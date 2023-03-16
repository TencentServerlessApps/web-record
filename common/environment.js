const CREDENTIAL_KEYS = {
  id: 'X-Scf-Secret-Id',
  key: 'X-Scf-Secret-Key',
  token: 'X-Scf-Session-Token',
  reqId: 'X-Scf-Request-Id',
};

const environment = {
  CREDENTIAL_KEYS,
  initialize(headers, context = {}) {
    // init secret id
    process.env.TENCENTCLOUD_SECRETID =
      headers[CREDENTIAL_KEYS.id] || headers[CREDENTIAL_KEYS.id.toLowerCase()];
    // init secret key
    process.env.TENCENTCLOUD_SECRETKEY =
      headers[CREDENTIAL_KEYS.key] || headers[CREDENTIAL_KEYS.key.toLowerCase()];
    // init secret token
    process.env.TENCENTCLOUD_SESSIONTOKEN =
      headers[CREDENTIAL_KEYS.token] || headers[CREDENTIAL_KEYS.token.toLowerCase()];

    // init context
    context.request_id =
      headers[CREDENTIAL_KEYS.reqId] || headers[CREDENTIAL_KEYS.reqId.toLowerCase()];

    return {
      context,
    };
  },
};

module.exports = environment;
