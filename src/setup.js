const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const readline = require('node:readline/promises')
const { spawn } = require('node:child_process')
const { ROOT, readConfig, saveConfig, renderMcpConfigs } = require('./config')
const { discoverYan, launchDesktop } = require('./yan-runtime')
const INSTALLER = { name: 'yan-4.3.0-Setup.exe', legacyName: 'WxLens-4.3.0-Setup.exe', bytes: 263378074, sha256: '75fffb0b8226b68a5a3e3c17ad9b01d28945eb53ae59f647c49bb82fdd11567e', distributionStatus: 'withdrawn', withdrawnAt: '2026-10-19' }
function installerFile(root = ROOT) {
  const current = path.join(root, 'vendor', INSTALLER.name)
  if (fs.existsSync(current)) return current
  const legacy = path.join(root, 'vendor', INSTALLER.legacyName)
  if (fs.existsSync(legacy)) return legacy
  return current
}
function ensureYanAlias(executable) {
  const resolved = path.resolve(executable)
  if (path.basename(resolved).toLowerCase() !== 'wxlens.exe') return { path: '', created: false }
  const alias = path.join(path.dirname(resolved), 'yan.exe')
  try {
    if (fs.existsSync(alias)) return { path: alias, created: false }
    fs.linkSync(resolved, alias)
    return { path: alias, created: true }
  } catch { return { path: '', created: false } }
}
async function verifyInstaller(file) {
  // Integrity identifies a file; it cannot make a withdrawn component usable.
  // A replacement requires an explicitly reviewed manifest, not an override flag.
  if (INSTALLER.distributionStatus === 'withdrawn') throw Object.assign(new Error('已停止安装和整合分发 WxLens 4.3.0：此固定安装器已有原生保护失效报告（InitProtection=-101），大小或 SHA-256 一致不能证明可用。请保留原配置和数据，向组件提供者取得可用且允许使用的新组件或续期；恢复步骤见 docs/component-recovery.md。不要重复重装或重新取钥。'), { code: 'YAN_INSTALLER_WITHDRAWN' })
  if (!fs.existsSync(file)) throw new Error('当前源码包不含可用的本机组件安装器。请向组件提供者取得可信且允许使用的新构建，或用 config --yan-exe 指定已有可用程序；恢复步骤见 docs/component-recovery.md。')
  const stat = fs.statSync(file)
  if (!stat.isFile() || stat.size !== INSTALLER.bytes) throw new Error('眼的安装器大小不匹配，停止启动')
  const hash = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  if (hash.digest('hex') !== INSTALLER.sha256) throw new Error('眼的安装器SHA-256不匹配，停止启动')
  return { ...INSTALLER, verified: true, signature: '原来源记录为未签名，哈希仅证明与已提供文件相同' }
}
async function setup() {
  if (!process.stdin.isTTY) throw new Error('首次设置需要你在本机终端交互操作。请双击setup.cmd；不要通过MCP stdio运行setup。')
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = async text => /^(y|yes|是)$/i.test((await prompt.question(text + ' [y/N] ')).trim())
  try {
    let config = readConfig(), exe = discoverYan(config)
    if (!exe) {
      if (process.platform !== 'win32') throw new Error('眼的 Windows 安装器不适用于当前系统；请自行准备兼容的本机服务。')
      const file = installerFile()
      await verifyInstaller(file)
      console.log('已核验组件安装器的大小和 SHA-256。请确认其来源、使用许可与当前有效期。')
      if (!(await ask('现在运行眼的安装器？'))) { console.log('未启动安装器。你可以稍后重新运行setup.cmd。'); return }
      await new Promise((resolve, reject) => { const child = spawn(file, [], { stdio: 'inherit', shell: false }); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('安装器退出或取消，未报告成功'))) })
      exe = discoverYan(config)
      if (!exe) { console.log('安装器已退出。若安装在自定义位置，请运行 node src/cli.js config --yan-exe "完整程序路径"，然后再运行setup。'); return }
    }
    const alias = ensureYanAlias(exe)
    if (alias.created) console.log('已创建眼的程序别名 yan.exe；原程序文件保持不变。')
    config = saveConfig({ ...config, yanExe: exe, autoStart: true })
    console.log('已找到眼并保存自动启动设置。已有初始化请直接复用；服务故障先运行 node src/cli.js doctor --native，区分组件与账号问题。')
    if (await ask('现在打开已有程序检查服务状态？')) await launchDesktop(exe, false)
    console.log('\n接下来：\n1. 已有初始化无需重新登录或取钥；仅缺少首次账号初始化时按原组件界面操作。\n2. 确认本地服务可查询；原生保护失败时先按 docs/component-recovery.md 处理组件。\n3. 把下面的配置合并到 AI 客户端，重新加载 MCP，并用 npm run verify:live -- --query 验收实际读取。\n\n日常无需额外网页。查询发现服务未运行时，眼会尝试在后台启动本机程序。\n')
    console.log(renderMcpConfigs().json)
  } finally { prompt.close() }
}
module.exports = { setup, verifyInstaller, installerFile, ensureYanAlias, INSTALLER }
