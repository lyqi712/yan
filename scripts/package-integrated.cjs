const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { pipeline } = require('node:stream/promises')
const JSZip = require('jszip')
const yauzl = require('yauzl')
const { build } = require('./package.cjs')
const { verifyInstaller, INSTALLER } = require('../src/setup')
const ROOT = path.resolve(__dirname, '..')
async function digest(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
async function verify(file, expected) {
  const zip = await new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true }, (error, value) => error ? reject(error) : resolve(value)))
  return new Promise((resolve, reject) => {
    let count = 0
    const fail = error => { zip.close(); reject(error) }
    zip.on('error', fail)
    zip.on('entry', entry => {
      if (entry.fileName.endsWith('/') || entry.fileName === 'yan/checksums.sha256') { zip.readEntry(); return }
      const name = entry.fileName.slice(4)
      if (!entry.fileName.startsWith('yan/') || !expected.has(name)) { fail(new Error('整合包出现清单外文件')); return }
      zip.openReadStream(entry, async (error, stream) => {
        if (error) { fail(error); return }
        try {
          const h = crypto.createHash('sha256'); for await (const chunk of stream) h.update(chunk)
          if (h.digest('hex') !== expected.get(name)) throw new Error('整合包文件校验失败：' + name)
          expected.delete(name); count++; zip.readEntry()
        } catch (e) { fail(e) }
      })
    })
    zip.on('end', () => expected.size ? reject(new Error('整合包遗漏清单文件')) : resolve(count))
    zip.readEntry()
  })
}
async function integrated() {
  const installer = path.join(ROOT, 'vendor', INSTALLER.name)
  await verifyInstaller(installer)
  const source = await build(ROOT), zip = await JSZip.loadAsync(fs.readFileSync(source.file))
  const lines = (await zip.file('yan/checksums.sha256').async('text')).trim().split('\n')
  const relative = 'vendor/' + INSTALLER.name
  lines.push(`${INSTALLER.sha256}  ${relative}`)
  zip.file('yan/checksums.sha256', lines.join('\n') + '\n')
  zip.file('yan/' + relative, fs.createReadStream(installer))
  const file = source.file.replace('-source.zip', '-windows-integrated.zip'), temporary = file + '.building'
  await pipeline(zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'STORE', platform: 'DOS' }), fs.createWriteStream(temporary))
  const expected = new Map(lines.map(line => { const [hash, name] = line.split('  '); return [name, hash] }))
  const files = await verify(temporary, expected), sha256 = await digest(temporary)
  fs.renameSync(temporary, file)
  fs.writeFileSync(file + '.sha256', `${sha256}  ${path.basename(file)}\n`)
  return { file, bytes: fs.statSync(file).size, files, sha256, verified: true, installerExecuted: false }
}
if (require.main === module) integrated().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { integrated }
