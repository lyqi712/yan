const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
let checked = 0
for (const dir of ['src', 'scripts']) {
  const visit = folder => { for (const entry of fs.readdirSync(folder, { withFileTypes: true })) { const file = path.join(folder, entry.name); if (entry.isDirectory()) visit(file); else if (/\.(?:js|cjs)$/.test(entry.name)) { const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }); if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(1) } checked += 1 } } }
  visit(path.join(root, dir))
}
const required = ['README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'package.json', 'package-lock.json', 'src/server.js', 'src/advanced-tools.js', 'setup.cmd', 'src/setup.js', 'src/yan-runtime.js', 'docs/first-use.md', 'docs/monitoring.md', 'docs/optional-runtime.md']
for (const file of required) if (!fs.existsSync(path.join(root, file))) throw new Error('缺少发行文件：' + file)
const pkg = require('../package.json'), lock = require('../package-lock.json')
if (pkg.version !== lock.version || pkg.name !== lock.name) throw new Error('package与锁文件不一致')
console.log(`语法检查 ${checked} 个JavaScript文件；发行必需项和版本一致性通过。`)
