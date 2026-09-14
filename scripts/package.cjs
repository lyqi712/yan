const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const JSZip = require('jszip')
const ROOT = path.resolve(__dirname, '..')
const TOP_FILES = ['README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'CHANGELOG.md', 'SECURITY.md', 'package.json', 'package-lock.json', '.gitignore', '.gitattributes', 'install.cmd', 'start.cmd', 'doctor.cmd', 'setup.cmd']
const TOP_DIRS = ['src', 'scripts', 'docs', 'ocr-runtime', '.github']
const EXCLUDED = new Set(['node_modules', '.local', 'output', 'dist', '.venv', '__pycache__', 'models', '.git'])
function collectFiles(root = ROOT) {
  const found = []
  const walk = relative => {
    const full = path.join(root, relative), stat = fs.lstatSync(full)
    if (stat.isSymbolicLink()) throw new Error('发行目录包含链接：' + relative)
    if (stat.isDirectory()) { for (const name of fs.readdirSync(full).sort()) if (!EXCLUDED.has(name)) walk(path.posix.join(relative, name)); return }
    if (!stat.isFile() || /(?:^|\/)\.env(?:\.|$)|\.(?:exe|dll|db|sqlite|onnx|bin|safetensors|log|pyc|zip)$/i.test(relative)) throw new Error('发行目录含禁止文件：' + relative)
    if (stat.size > 5 * 1024 * 1024) throw new Error('源码发行文件过大：' + relative)
    found.push(relative)
  }
  for (const name of TOP_FILES) { if (!fs.existsSync(path.join(root, name))) throw new Error('发行文件缺失：' + name); walk(name) }
  for (const name of TOP_DIRS) if (fs.existsSync(path.join(root, name))) walk(name)
  return found.sort()
}
const hash = buffer => crypto.createHash('sha256').update(buffer).digest('hex')
async function build(root = ROOT) {
  const files = collectFiles(root), zip = new JSZip(), hashes = []
  for (const name of files) { const content = fs.readFileSync(path.join(root, name)); hashes.push(`${hash(content)}  ${name}`); zip.file('yan/' + name, content) }
  zip.file('yan/checksums.sha256', hashes.join('\n') + '\n')
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'DOS' })
  const verified = await JSZip.loadAsync(buffer, { checkCRC32: true })
  for (const line of hashes) { const [expected, name] = line.split('  '); if (hash(await verified.file('yan/' + name).async('nodebuffer')) !== expected) throw new Error('打包后哈希不一致：' + name) }
  const output = path.join(root, 'dist'); fs.mkdirSync(output, { recursive: true })
  const filename = `yan-v${JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version}-source.zip`, file = path.join(output, filename)
  fs.writeFileSync(file, buffer); fs.writeFileSync(file + '.sha256', `${hash(buffer)}  ${filename}\n`)
  return { file, sha256: hash(buffer), bytes: buffer.length, sourceFiles: files.length, verified: true }
}
if (require.main === module) build().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { collectFiles, build }
