const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..'), lock = require('../package-lock.json')
const rows = Object.entries(lock.packages).filter(([name]) => name).map(([key, item]) => {
  const installed = path.join(root, key, 'package.json'); const pkg = fs.existsSync(installed) ? JSON.parse(fs.readFileSync(installed, 'utf8')) : {}
  return { name: pkg.name || key.split('node_modules/').at(-1), version: item.version, license: item.license || pkg.license || 'UNKNOWN', source: pkg.repository?.url || (typeof pkg.repository === 'string' ? pkg.repository : '') || `https://www.npmjs.com/package/${pkg.name || key.split('node_modules/').at(-1)}` }
}).sort((a, b) => a.name.localeCompare(b.name))
const markdown = '# Node依赖清单\n\n由 `npm run licenses` 根据当前锁文件与已安装包元数据生成。源码发行包不包含 node_modules；安装时各依赖自行携带许可证。许可冲突以原包许可为准。\n\n| 依赖 | 锁定版本 | 许可 | 来源 |\n| --- | --- | --- | --- |\n' + rows.map(row => `| ${row.name} | ${row.version} | ${typeof row.license === 'string' ? row.license : JSON.stringify(row.license)} | ${row.source} |`).join('\n') + '\n'
fs.mkdirSync(path.join(root, 'docs'), { recursive: true }); fs.writeFileSync(path.join(root, 'docs', 'node-dependencies.md'), markdown)
if (rows.some(row => row.license === 'UNKNOWN')) { console.error('存在未识别许可，请审查清单'); process.exitCode = 1 } else console.log(`已生成 ${rows.length} 项依赖许可清单。`)
