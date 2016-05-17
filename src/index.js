import { Wrapper as OSS } from 'ali-oss'
import { pick, find } from 'lodash'
import walk from 'walk'
import Async from 'async'
import isThere from 'is-there'
import path from 'path'
import moment from 'moment'

class OSSSyncDir extends OSS {
  constructor (props) {
    super(props)
  }

  putList (fileList, options = { thread: 20, bigFile: 1024 * 100, timeout: 10 * 1000 }) {
    return new Promise((resolve, reject) => {
      async function putFile (file, done) {
        try {
          if (file.size >= options.bigFile) {
            // console.log('multipartUpload', file.dst, file.size)
            const result = await this.multipartUpload(file.dst, file.src, {
              partSize: 1024 * 100
            })
            done(null, result)
          } else {
            // console.log('put', file.dst, file.size)
            const result = await this.put(file.dst, file.src, { timeout: options.timeout })
            done(null, result)
          }
        } catch (err) {
          done(err)
        }
      }
      Async.mapLimit(fileList, options.thread, putFile.bind(this), (err, results) => {
        if (err) {
          return reject(err)
        }
        resolve(results)
      })
    })
  }

  deleteList (fileList, options = { thread: 20 }) {
    return new Promise((resolve, reject) => {
      async function deleteFile (file, done) {
        try {
          const result = await this.delete(file.name)
          done(null, result)
        } catch (err) {
          done(err)
        }
      }
      Async.mapLimit(fileList, options.thread, deleteFile.bind(this), (err, results) => {
        if (err) {
          return reject(err)
        }
        resolve(results)
      })
    })
  }

  /**
   * As in:
   * s3 sync ${directory} s3://bucket/${prefix} --delete
   */
  syncDir (directory, prefix, options = { delete: true }, meta = {}) {
    return new Promise((resolve, reject) => {
      resolve = meta.resolve || resolve
      reject = meta.reject || reject
      const tried = (meta.tried || 0) + 1
      console.log(`trying the ${tried} times...`)

      let putResults = []
      let deleteResults = []

      // 1. Prepare local files
      // a. check if directory exists
      if (!isThere(directory)) {
        return reject(new Error(`Path ${directory} does not exist!`))
      }
      // b. construct list of local files
      const dirname = path.dirname(directory)
      let localFiles = new Map()
      const walker = walk.walk(directory)
      walker.on('file', (root, stat, next) => {
        const dst = `${prefix}${root.substr(directory.length)}/${stat.name}`
        const src = `${root}/${stat.name}`
        localFiles.set(dst, {
          dst,
          src,
          mtime: stat.mtime.toISOString(),
          size: stat.size
        })
        // localFiles.push({
        //   dst,
        //   src,
        //   mtime: stat.mtime.toISOString(),
        //   size: stat.size
        // })
        next()
      })

      walker.on('end', async () => {
        console.log('local:', localFiles.size)

        // 2. Check exiting files on OSS
        let cloudFiles = new Map()
        try {
          const cloudFileList = await this.listDir(prefix, ['name', 'lastModified'])
          cloudFileList.forEach(f => cloudFiles.set(f.name, f))
          console.log('oss:', cloudFiles.size)
        } catch (err) {
          // catch the ResponseTimeoutError, and re-try
          console.log('ResponseTimeoutError: listDir', 're-trying...')
          if (err && err.name === 'ResponseTimeoutError' || err.name === 'ConnectionTimeoutError') {
            return setTimeout(() => this.syncDir(directory, prefix, options, { resolve, reject, tried }), 3000)
          } else {
            return reject(err)
          }
        }

        // 3. Construct a list of files to upload
        let uploadFiles = []
        for (let f of localFiles.values()) {
          const existed = cloudFiles.get(f.dst)
          if (existed) {
            if (moment(f.mtime).isAfter(moment(existed.lastModified))) {
              uploadFiles.push(f)
            }
          } else {
            uploadFiles.push(f)
          }
        }
        // localFiles.forEach(f => {
        //   const existed = find(cloudFiles, { name: f.dst })
        //   if (existed) {
        //     if (moment(f.mtime).isAfter(moment(existed.lastModified))) {
        //       uploadFiles.push(f)
        //     }
        //   } else {
        //     uploadFiles.push(f)
        //   }
        // })
        console.log('upload:', uploadFiles.length)

        // 4. Put a list of files to OSS
        try {
          putResults = await this.putList(uploadFiles)
          console.log('done uploading')
        } catch (err) {
          // catch the ResponseTimeoutError, and re-try
          console.log('ResponseTimeoutError: putList', 're-trying...')
          if (err && err.name === 'ResponseTimeoutError' || err.name === 'ConnectionTimeoutError') {
            return setTimeout(() => this.syncDir(directory, prefix, options, { resolve, reject, tried }), 3000)
          } else {
            return reject(err)
          }
        }

        // 5. Construct a list of files to delete
        let deleteFiles = []
        if (options.delete) {
          for (let f of cloudFiles.values()) {
            const existed = localFiles.get(f.name)
            if (!existed) {
              deleteFiles.push(f)
            }
          }
          // cloudFiles.forEach(f => {
          //   const existed = find(localFiles, { dst: f.name })
          //   if (!existed) {
          //     deleteFiles.push(f)
          //   }
          // })
          console.log('delete:', deleteFiles.length)

          // 6. Delete a list of files from OSS
          try {
            deleteResults = await this.deleteList(deleteFiles)
            console.log('done deleting')
          } catch (err) {
            // catch the ResponseTimeoutError, and re-try
            console.log('ResponseTimeoutError: deleteList', 're-trying...')
            if (err && err.name === 'ResponseTimeoutError' || err.name === 'ConnectionTimeoutError') {
              return setTimeout(() => this.syncDir(directory, prefix, options, { resolve, reject, tried }), 3000)
            } else {
              return reject(err)
            }
          }
        }

        resolve({
          put: putResults,
          delete: deleteResults
        })
      })
    })
  }

  /**
   * Get all the files of a directory recursively.
   * Return [] if not found.
   */
  async listDir (prefix, projection = []) {
    const query = {
      prefix,
      'max-keys': 1000
    }
    let result = await this.list(query)
    if (!result.objects) {
      return []
    }
    function project (files) {
      if (projection.length) {
        return files.map(f => pick(f, projection))
      }
      return files
    }
    let allFiles = [...project(result.objects)]
    while (result.nextMarker) {
      query.marker = result.nextMarker
      result = await this.list(query)
      allFiles = [...allFiles, ...project(result.objects)]
    }
    return allFiles
  }

  /**
   * Delete a directory on OSS recursively.
   */
  deleteDir (prefix, meta = {}) {
    return new Promise(async (resolve, reject) => {
      resolve = meta.resolve || resolve
      reject = meta.reject || reject
      const tried = (meta.tried || 0) + 1
      console.log(`trying the ${tried} times...`)

      let objects = []
      try {
        objects = (await this.listDir(prefix, ['name'])).map(x => x.name)
      }
      catch (err) {
        console.log('listDIr timeout...')
        if (err && err.name === 'ResponseTimeoutError' || err.name === 'ConnectionTimeoutError') {
          return setTimeout(() => this.deleteDir(prefix, { resolve, reject, tried }), 3000)
        } else {
          return reject(err)
        }
      }
      let results = []
      let cargo = Async.cargo(async (tasks, done) => {
        try {
          console.log(`deleting ${tasks.length} files...`)
          const data = await this.deleteMulti(tasks)
          results = [...results, ...data.deleted]
          done(null, data)
        } catch (err) {
          console.log('deleteMulti timeout...')
          if (err && err.name === 'ResponseTimeoutError' || err.name === 'ConnectionTimeoutError') {
            return setTimeout(() => this.deleteDir(prefix, { resolve, reject, tried }), 3000)
          } else {
            return reject(err)
          }
        }
      }, 1000)

      cargo.push(objects, (err, data) => {
        if (err) {
          return reject(err)
        }
      })

      cargo.drain = (err, data) => {
        if (err) {
          return reject(err)
        }
        console.log(`Finished deleting ${prefix}`)
        resolve(results)
      }
    })
  }

  /**
   * Set the content-disposition header of a file.
   */
  async setDownloadName (file, downloadName) {
    return await this.copy(file, file, {
      headers: {
        'Content-Type': 'binary/octet-stream',
        'Content-Disposition': `attachment; filename="${downloadName}"`
      }
    })
  }
}

// export default OSSSyncDir
module.exports = OSSSyncDir
