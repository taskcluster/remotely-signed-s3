import fs from 'mz/fs';
import assert from 'assert';
import crypto from 'crypto';
import Runner from './runner';

const MAX_S3_CHUNKS = 10000;

/**
 * This class represents a client of a service implemented using the
 * `Controller` class.
 */
class Client {

  constructor(opts) {
    let {runner, maxConcurrency, minMPSize, partsize} = opts || {};
    // The maximum number of concurrent requests this Client
    // should run
    this.maxConcurrency = maxConcurrency;
    this.partsize = (partsize || 25 * 1024 * 1024) + 0;

    if (!runner) {
      runner = new Runner();
    }
    
    // The Runner to use for this
    this.runner = runner;

    // The minimum size before switching to multipart
    this.minMPSize = minMPSize;
  }


  async __prepareSinglepartUpload(opts) {
    let {filename} = opts;
    let filestats = await fs.stat(filename);
    let sha256 = crypto.createHash('sha256');
    let size = 0;
    let stream = fs.createReadStream(filename, {start: 0});
    return new Promise((resolve, reject) => {
      stream.on('error', reject);

      stream.on('data', data => {
        sha256.update(data);
        size += data.length;
      });

      stream.on('end', async () => {
        let finishedstats = await fs.stat(filename);
        if (size !== filestats.size) {
          throw new Error('File has a different number of bytes than was hashed');
        } else if (finishedstats.size !== filestats.size) {
          reject(new Error('File changed size during preperation'));
        } else if (finishedstats.mtime.getTime() !== filestats.mtime.getTime()){
          reject(new Error('File was modified during preperation'));
        } else if (finishedstats.ino !== filestats.ino){
          reject(new Error('File has changed inodes'));
        } else {
          sha256 = sha256.digest('hex');
          resolve({
            filename,
            sha256,
            size,
          });
        }
      });
    });
  }

  async __prepareMultipartUpload(opts) {
    opts = opts || {};
    let {filename, partsize} = opts;
    // Ensure we're copying the value and not changing it
    partsize = (partsize || this.partsize);
    console.log(partsize);


    let sha256 = crypto.createHash('sha256');
    let filestats = await fs.stat(filename);
    let size = 0; // the computed size, to check against result of stat();
    let partcount = Math.ceil(filestats.size / partsize);
    let parts = [];

    if (partsize/size < 2) {
      throw new Error('Multipart upload must have at least 2 parts');
    }

    for (let part = 0 ; part < partcount ; part++) {
      await new Promise((resolve, reject) => {
        let parthash = crypto.createHash('sha256');
        let start = part * partsize;
        let end = start + partsize - 1;
        let currentPartsize = 0;

        let partstream = fs.createReadStream(filename, {start, end});

        partstream.on('error', reject);

        partstream.on('data', data => {
          size += data.length;
          currentPartsize += data.length;
          sha256.update(data);
          parthash.update(data);
        });

        partstream.on('end', () => {
          // All parts other than the last one should have a size no greater than
          // the partsize requested
          if (part < partcount - 1) {
            if (partsize !== currentPartsize) {
              throw new Error('All parts before last part must be exactly requested size');
            }
          } else if (part === partcount - 1) {
            if (currentPartsize > partsize) {
              throw new Error('Final part exceeds allowed size');
            }
          }
          parts.push({sha256: parthash.digest('hex'), size: currentPartsize, start});
          resolve();
        });
      });
    }

    sha256 = sha256.digest('hex');

    // Now make sure that in the meantime that the file didn't change out from
    // under us.  It's still possible for a properly motivated person
    // to reset the mtime and size to what we expect, but these checks
    // are more about non-intentional mistakes.  We cannot compare hashes before
    // and after since we're computing the hash 
    let finishedstats = await fs.stat(filename);
    if (size !== filestats.size) {
      throw new Error('File has a different number of bytes than was hashed');
    } else if (finishedstats.size !== filestats.size) {
      reject(new Error('File changed size during preperation'));
    } else if (finishedstats.mtime.getTime() !== filestats.mtime.getTime()){
      reject(new Error('File was modified during preperation'));
    } else if (finishedstats.ino !== filestats.ino){
      reject(new Error('File has changed inodes'));
    } else {
      return {filename, sha256, size, parts};
    }
  }

  __determineUploadType(size, forceMP, forceSP) {

  }

  async prepareUpload(opts) {
    let {filename, forceMP, forceSP} = opts;

    let multipart = !!forceMP;

    let filesize = await fs.stat(filename);

    if (filesize >= this.minMPSize && !forceSP) {
      multipart = true;
    }

    if (multipart) {
      return this.__prepareMultipartUpload(opts);
    } else {
      return this.__prepareSinglepartUpload(opts);
    }
  }


  /**
   * Take the list of requests in interchange format and 
   * run them using the information from the upload preperation
   * list
   */
  async runUpload(request, upload) {
    let {filename, sha256, size, parts} = upload;
    let etags = [];
    let responses = [];

    if (!Array.isArray(request)) {
      request = [request];
    }

    if (!parts) {
      parts = [{sha256, size, start: 0}];
    }

    if (request.length !== parts.length) {
      throw new Error('Number of requests does not match number of parts');
    }

    for (let n = 0; n < request.length ; n++) {
      let {sha256, start, size} = parts[n];
      let req = request[n];
      function body() {
        let end = start + size - 1;
        return fs.createReadStream(filename, {start, end});
      };

      let result = await this.runner.run({req, body});
      if (result.statusCode >= 300) {
        let err = new Error(`Failed to run a request ${req.method} ${req.url}`);
        err.url = req.url;
        err.method = req.method;
        err.headers = req.headers;
        err.response = result.response;
      }
      let etag;
      if (result && result.headers && result.headers.etag) {
        // This header is occasionally returned wrapped in quotation marks.
        etag = result.headers.etag.trim();
        /*if (etag.charAt(0) === '"') {
          etag = etag.slice(1);
          if (etag.charAt(etag.length - 1) === '"') {
            etag = etag.slice(0, etag.length - 1);
          } else {
            throw new Error('Mismatched quotation marks around ETag');
          }
        }*/
      }

      // I'm not entirely happy with this.  It's almost completely 
      // here for unit tests.  It's not dangerous because a lack of
      // an ETag will just cause the upload to fail for a multipart
      // upload because it cannot commit the upload and it is not
      // important for a single part upload
      etags.push(etag || 'NOETAG');
      responses.push(result);
    }
    return {etags, responses};
  }

}

module.exports = Client;
