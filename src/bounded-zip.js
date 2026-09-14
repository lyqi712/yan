const yauzl = require('yauzl')
const JSZip = require('jszip')
const fs = require('node:fs')
const MAX_ENTRIES = 2000
const MAX_ENTRY = 10 * 1024 * 1024
const MAX_TOTAL = 50 * 1024 * 1024

// Validate metadata AND actual streamed output before any whole-archive parser runs.
function validateArchive(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(error)
      let count = 0, declaredTotal = 0, actualTotal = 0, settled = false
      function fail(reason) { if (settled) return; settled = true; zip.close(); reject(reason) }
      zip.on('error', fail)
      zip.on('end', () => { if (!settled) { settled = true; resolve({ entries: count, bytes: actualTotal }) } })
      zip.on('entry', entry => {
        declaredTotal += entry.uncompressedSize
        if (++count > MAX_ENTRIES || entry.uncompressedSize > MAX_ENTRY || declaredTotal > MAX_TOTAL) return fail(new Error('压缩包超过安全读取预算（2000项 / 单项10MB / 总计50MB）'))
        if (entry.generalPurposeBitFlag & 1) return fail(new Error('不支持加密压缩包，请先在本机解密'))
        if (/\/$/.test(entry.fileName)) { zip.readEntry(); return }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return fail(streamError)
          let bytes = 0
          stream.on('error', fail)
          stream.on('data', chunk => {
            bytes += chunk.length; actualTotal += chunk.length
            if (bytes > MAX_ENTRY || actualTotal > MAX_TOTAL) { stream.destroy(); fail(new Error('压缩包实际解压内容超过安全读取预算')) }
          })
          stream.on('end', () => { if (!settled) zip.readEntry() })
        })
      })
      zip.readEntry()
    })
  })
}

async function loadBoundedZip(file) {
  await validateArchive(file)
  return JSZip.loadAsync(fs.readFileSync(file))
}
module.exports = { validateArchive, loadBoundedZip }
