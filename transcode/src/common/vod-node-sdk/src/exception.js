class VodClientException extends Error {
    constructor(message) {
        super();
        this.message = message;
    }

    toString() {
        return "[VodClientException] message=" + this.message;
    }
}

module.exports = VodClientException;