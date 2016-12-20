let gm = require('gm'),
    path = require('path'),
    Util = require('misa'),
    fs = require('fs-extra'),
    Nanami = require('nanami'),
    crypto = require('crypto'),
    Stream = require('stream'),
    Request = require('request'),
    promise = require('bluebird'),
    requestPromise = promise.promisify(Request);
let tempHash = new Set();
let uuid = 0;
const 
    CHECK_FILE_REGEX = /\(\d+\)(?=[^)]*$)/, // check whether it has ()
    OLD_FILE_REGEX = /(\d+)(?=\)\D*$)/, // get number inside ()
    NEW_FILE_REGEX = /\.[^.]+$/,    // get path without extension
    TEMP_FOLDER = './temp/',
    STATUS_FILE = './fileStatus.json';
function getUUID() {
    return uuid++;
}
class AsukaSaito {
    constructor(dir) {
        this.dir = dir || './img/';
        this.retryLimit = 3;
        let database = fs.readJson(path.resolve(this.dir, STATUS_FILE), (error, database) => {
            if (error) return this.rebuildMap();
            this.hashTable = database && new Set(database.hashTable);
            this.fileIndex = database && new Map(database.fileIndex);
        });
        this.removeTemp();
    }
    rebuildMap() {
        this.hashTable = new Set();
        this.fileIndex = new Map();
        if (!Util.isDirectoryExist(this.dir)) {
            fs.mkdirsSync(this.dir);
            return;
        }
        return Nanami.recursiveReadDirPromise(this.dir, file => {
            return this.hashingPromise(fs.createReadStream(file)).then(hash => console.log(hash, file));
        });
    }
    removeTemp() {
        let rmdir = path.resolve(this.dir, TEMP_FOLDER);
        fs.remove(rmdir, (err) => {
            if (err) return console.log('[removeTemp] Remove temp failed', rmdir)
            console.log('[removeTemp] Remove temp successful', rmdir);
        });
    }
    saveState() {
        fs.writeFileSync(path.resolve(this.dir, STATUS_FILE), JSON.stringify({
            hashTable: [...this.hashTable],
            fileIndex: [...this.fileIndex]
        }));
    }
    removeFailedHash() {
        for (let hash of tempHash) {
            console.log(`Deleting hash: ${hash}`);
            this.hashTable.delete(hash);
        }
    }
    onFinish() {
        this.removeTemp();
        this.removeFailedHash();
        this.saveState();
    }
    tokenRequestPromise(url) {
        return requestPromise(url).then(response => {
            if (response.statusCode !== 200) {
                throw new NetworkError(`${response.statusCode} ${url}`);
            }
            let cookie = response.headers['set-cookie'];
            return cookie && cookie[0] || cookie;
        }).catch(error => {
            console.log('[tokenRequestPromise] Error:\n', error);
            throw error;
        });
    }
    hashingPromise(stream, encoding = 'base64') {
        return new promise((resolve, reject) => {
            let hashing = crypto.createHash('md5').setEncoding(encoding);
            stream.pipe(hashing);
            hashing.on('finish', () => {
                // If BASE64, last 2 char will be '=='
                let hash = encoding === 'base64' ? (hashing.read()).slice(0, -2) : hashing.read();
                if (this.hashTable.has(hash)) {
                    reject(new HashDuplicateError(`Hash already exist! ${hash}`));
                } else {
                    // Add to hashTable
                    this.hashTable.add(hash);    
                    resolve(hash);
                }
            });
            hashing.on('error', error => {
                console.log('[hashingPromise error]', error);
                resolve(void 0);
            });
        });
    }
    namingPromise(stream, filename) {
        return new promise((resolve, reject) => {
            gm(stream).format({bufferStream: true}, (error, properties) => {
                if (error) {
                    console.log('[namingPromise error]', error);
                    return resolve(filename);
                }
                filename = filename.replace(/\.[^.]*$/, '');    // Remove extensions & params
                switch (properties) {
                    case 'JPEG':
                        filename += '.jpg';
                        break;
                    case 'GIF':
                        filename += '.gif';
                        break;
                    case 'PNG':
                        filename += '.png';
                        break;
                    case 'TIFF':
                        filename += '.tiff';
                        break;
                    case 'BMP':
                        filename += '.bmp';
                        break;
                    default:
                        console.log('[namingPromise] Undetected image format:', properties);
                        filename += '.jpg';
                        break;
                }
                resolve(filename);
            });
        });
    }
    sizeCheckPromise(stream, filename) {
        return new promise((resolve, reject) => {
            gm(stream).size({bufferStream: true}, (error, properties) => {
                if (error) {
                    console.log('[sizeCheckPromise] Error:', error);
                    return resolve();
                }
                if (properties.width < 150 || properties.height < 150) return reject(new ImageSizeError('Size too small'));
                return resolve(properties);
            });
        });
    }
    /**
     * Will only increment suffix by 1
     * since the suffix chain can be broken
     * we may want to fill in the hole
     */
    regexAddSuffix(source) {
        let dirDiff = path.relative(path.resolve(this.dir), source);
        // Check if fileIndex exist
        if (this.fileIndex.has(dirDiff)) {
            let index = this.fileIndex.get(dirDiff) + 1;
            this.fileIndex.set(dirDiff, index);
            return source.replace(NEW_FILE_REGEX, `(${index})$&`);
        }
        // Check if source is fresh
        if (!CHECK_FILE_REGEX.test(source)) {
            // Add file to fileIndex
            this.fileIndex.set(dirDiff, 0);
            return source.replace(NEW_FILE_REGEX, `(0)$&`);
        }
        // If source has quotational expression
        return source.replace(OLD_FILE_REGEX, (selection, match, index, fullText) => {
            return parseInt(selection) + 1;
        });
    }
    renamePromise(inputTarget, outputTarget) {
        return new promise((resolve, reject) => {
            if (!Util.isDirectoryExist(path.dirname(outputTarget))) {
                console.log('[renamePromise] Directory not exist!', outputTarget);
                fs.mkdirsSync(path.dirname(outputTarget));
            }
            // Loop through all suffix or create suffix
            while (Util.isFileExist(outputTarget)) {
                outputTarget = this.regexAddSuffix(outputTarget);
            }
            fs.rename(inputTarget, outputTarget, (error, result) => {
                if (error) {
                    console.log('[renamePromise] temp file', inputTarget, 'failed to rename', outputTarget, 'with Error:', error);
                    return false;
                }
                return resolve(outputTarget);
            });
        });
    }
    /**
     * @return [<Stream> stream, <String> filename]
     */
    requestStreamPromise(options) {
        return new promise((resolve, reject) => {
            let stream = Request(options).on('response', response => {
                if (response.statusCode !== 200) {
                    return reject(new NetworkError(`${response.statusCode} ${JSON.stringify(options)}`));
                }
                let contentLength = response.headers['content-length'],
                    dataDisposition = response.headers['content-disposition'],
                    filenameFound = dataDisposition && dataDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/i),
                    filename; 
                if (filenameFound && filenameFound.length > 2) {
                    filename = decodeURIComponent(filenameFound[1].replace(/['"]/g, ''));
                } else {
                    filename = path.basename(options.url || options).replace(/\?.*/, '');
                }
                resolve([stream, filename, contentLength]);
            })
            .on('error', error => {
                console.log('[requestStreamPromise]', error);
                reject(new NetworkError(error));
            }).pipe(Stream.PassThrough());
        });
    }
    createWriteStream(targetPath) {
        if (!Util.isDirectoryExist(path.dirname(targetPath))) {
            console.log('[createWriteStream] Directory not exist!', targetPath);
            fs.mkdirsSync(path.dirname(targetPath));
        }
        return fs.createWriteStream(targetPath);
    }
    /**
     * Return renamePromise Function
     * for delay execution until all checkings are passed
     */
    coreMechanics(memberId, stream, filename) {
        return new promise((resolve, reject) => {
            let resolutionPromise,
                promises = [],
                tempFile = path.resolve(this.dir, TEMP_FOLDER, String(getUUID()));
            promises.push(this.hashingPromise(stream).then(hash => {
                // Register hash to temporary dictionary as a key to remove hash from hashTable
                // in case of something has failed in progress
                hash && tempHash.add(hash);
                return hash;
            }));
            promises.push(this.namingPromise(stream, filename));
            promises.push(this.sizeCheckPromise(stream));
            stream.pipe(this.createWriteStream(tempFile));
            stream.on('error', error => {
                console.log('[coreMechanics] STREAM ERROR:', error);
                reject(error);
            });
            stream.on('end', () => {
                resolutionPromise.spread((hash, name) => {
                    console.log('[coreMechanics] ReadStream completed', name);
                    // Return binded function
                    return () => {
                        let renameResolution = this.renamePromise(tempFile, path.resolve(this.dir, memberId, name));
                        renameResolution.then(() => {
                            // Hash has confirmed completion of execution
                            hash && tempHash.delete(hash);
                        });
                        return renameResolution;
                    };
                    // return this.renamePromise.bind(this, tempFile, path.resolve(this.dir, memberId, name));
                }).then(resolve)
                .catch(error => {
                    console.log('[coreMechanics] caught:', error instanceof CustomError ? error.name : error);
                    reject(error);
                });
            });
            resolutionPromise = promise.all(promises);
        });
    }
    checkStreamIntegrity(stream, contentLength) {
        let lengthReceived = 0;
        stream.on('data', chunk => {
            lengthReceived += chunk.length;
        });
        return new promise((resolve, reject) => {
            stream.on('end', () => {
                console.log(`[checkStreamIntegrity] ${lengthReceived}/${contentLength}`);
                if (lengthReceived >= contentLength) {
                    return resolve();
                }
                return reject(new IncompletionError(`Corrupted stream at ${lengthReceived}/${contentLength}`));
            });
        });
    }
    imageDisposalPromise(tokenUrl, memberId) {
        if (!~tokenUrl.indexOf("dcimg.awalker")) return promise.reject(new InputError(`[imageDisposalPromise] Do not recognize url: ${tokenUrl}`));
        console.log('[imageDisposalPromise]');
        memberId = memberId || '';
        let imageUrl = tokenUrl.replace('img1', 'img2').replace('id=', 'sec_key='),
            savedToken = "",
            attemptDownload = (attempt = 0) => {
                if (attempt > this.retryLimit) return promise.reject(new NetworkError('Repeating failure'));
                return this.requestStreamPromise({
                    url: imageUrl,
                    headers: {
                        'Cookie': savedToken
                    }
                })
                .spread((stream, filename, contentLength) => {
                    attempt > 0 && console.log('attempting', imageUrl);
                    let promises = [];
                    promises.push(this.coreMechanics(memberId, stream, filename)
                        .timeout(60*2*1000));
                    promises.push(this.checkStreamIntegrity(stream, contentLength));
                    // checkStreamIntegrity will reject if fail, thus result is not important
                    return promise.all(promises).then(([coreResult, streamIntegrity]) => coreResult);
                })
                .then(renamePromise => renamePromise())
                .catch(
                    {'name':'IncompletionError'}, 
                    promise.TimeoutError, 
                    () => {
                        console.log('[imageDisposalPromise attemptDownload] Retrying ', attempt, imageUrl);
                        return attemptDownload(attempt+1);
                    }
                );
            };
        return this.tokenRequestPromise(tokenUrl)
            .then(token => {
                savedToken = token;
                return attemptDownload();
            })
            .catch(error => {
                console.log('[imageDisposalPromise] Error suppressed!');
                return error;
            })
            .then(result => {
                console.log('[imageDisposalPromise] Done', result);
                return result;
            });
    }
    imageDigestionPromise(buffer, memberId) {
        console.log('[imageDigestionPromise]');
        let streamifier = require('streamifier'),
            stream = streamifier.createReadStream(buffer, {
                'highWaterMark': 16384,
                'encoding': null
            }).pipe(Stream.PassThrough());
        return this.coreMechanics(memberId, stream, 'attachment')
            .then(renamePromise => renamePromise())
            .catch(error => {
                console.log('[imageDigestionPromise] suppress:', error);
                return error;
            })
            .then(result => {
                console.log('[imageDigestionPromise] Done', result);
                return result;
            });
    }
    feed(memberId, tokenUrl) {
        console.log('[Asuka feed]', memberId, tokenUrl);
        return this.imageDisposalPromise(tokenUrl, memberId);
    }
    feedPorridge(memberId, uint8Array) {
        console.log('[Asuka feedPorridge]', memberId);
        return this.imageDigestionPromise(uint8Array, memberId);
    }
}
// http://stackoverflow.com/questions/31089801/extending-error-in-javascript-with-es6-syntax
class ExtendableError extends Error {
    constructor(message) {
        super(message);
        this.name = this.constructor.name;
        this.message = this.name + ": " + message; 
        if (typeof Error.captureStackTrace === 'function') {
            Error.captureStackTrace(this, this.constructor);
        } else { 
            this.stack = (new Error(message)).stack; 
        }
    }
}
class CustomError {
    constructor(message) {
        this.name = this.constructor.name;
        this.message = this.name + ": " + message;
    }
}
class HashDuplicateError extends CustomError {}
class NetworkError extends CustomError {}
class ImageSizeError extends CustomError {}
class InputError extends CustomError {}
class IncompletionError extends CustomError {}

module.exports = exports = {
    AsukaSaito,
    HashDuplicateError,
    ImageSizeError,
    NetworkError,
    CustomError,
    InputError
};