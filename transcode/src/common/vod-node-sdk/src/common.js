const fs = require("fs");
const path = require("path");

class StringUtil {
    static isEmpty(target) {
        return target == null || target === "";
    }

    static isNotEmpty(target) {
        return !this.isEmpty(target);
    }
}

class FileUtil {
    static isFileExist(target) {
        return fs.existsSync(target) && fs.statSync(target).isFile();
    }

    static getFileType(target) {
        const extName = path.extname(target);
        if (extName === "") {
            return "";
        }
        return extName.substring(1);
    }

    static getFileName(target) {
         const baseName = path.basename(target);
         const index = baseName.indexOf(".");
         if (index !== -1) {
            return baseName.substring(0, index);
         } else {
             return baseName;
         }
    }
}

module.exports = {
    StringUtil: StringUtil,
    FileUtil: FileUtil
};