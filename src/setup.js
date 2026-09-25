const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const readline = require('node:readline/promises')
const { spawn } = require('node:child_process')
const { ROOT, readConfig, saveConfig, renderMcpConfigs } = require('./config')
const { discoverYan, launchDesktop } = require('./yan-runtime')
const INSTALLER = { name: 'yan-4.3.0-Setup.exe', legacyName: 'WxLens-4.3.0-Setup.exe', bytes: 263378074, sha256: '75fffb0b8226b68a5a3e3c17ad9b01d28945eb53ae59f647c49bb82fdd11567e' }
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
  if (!fs.existsSync(file)) throw new Error('当前源码包不含眼的安装器。请使用含 vendor/yan-4.3.0-Setup.exe 的整合包，或指定已经安装的本机程序后重试。')
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
      console.log('已核验眼 4.3.0 安装器的大小和 SHA-256。安装器未签名；请确认其来源为你信任的整合包。')
      if (!(await ask('现在运行眼的安装器？'))) { console.log('未启动安装器。你可以稍后重新运行setup.cmd。'); return }
      await new Promise((resolve, reject) => { const child = spawn(file, [], { stdio: 'inherit', shell: false }); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('安装器退出或取消，未报告成功'))) })
      exe = discoverYan(config)
      if (!exe) { console.log('安装器已退出。若安装在自定义位置，请运行 node src/cli.js config --yan-exe "完整程序路径"，然后再运行setup。'); return }
    }
    const alias = ensureYanAlias(exe)
    if (alias.created) console.log('已创建眼的程序别名 yan.exe；原程序文件保持不变。')
    config = saveConfig({ ...config, yanExe: exe, autoStart: true })
    console.log('已找到眼并保存自动启动设置。首次初始化在眼的界面内完成，眼不读取或输出密钥。')
    if (await ask('现在打开眼，完成微信登录、密钥获取和本地索引初始化？')) await launchDesktop(exe, false)
    console.log('\n接下来：\n1. 按眼的界面提示完成登录、密钥获取和初始化。\n2. 确认其本地 HTTP 服务可用。\n3. 把下面的配置合并到 AI 客户端，重新加载 MCP 后直接提问。\n\n日常无需额外网页。查询发现服务未运行时，眼会尝试在后台启动本机程序。\n')
    console.log(renderMcpConfigs().json)
  } finally { prompt.close() }
}
module.exports = { setup, verifyInstaller, installerFile, ensureYanAlias, INSTALLER }
