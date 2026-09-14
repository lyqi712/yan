const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const readline = require('node:readline/promises')
const { spawn } = require('node:child_process')
const { ROOT, readConfig, saveConfig, renderMcpConfigs } = require('./config')
const { discoverWxlens, launchDesktop } = require('./wxlens-runtime')
const INSTALLER = { name: 'WxLens-4.3.0-Setup.exe', bytes: 263378074, sha256: '75fffb0b8226b68a5a3e3c17ad9b01d28945eb53ae59f647c49bb82fdd11567e' }
async function verifyInstaller(file) {
  if (!fs.existsSync(file)) throw new Error('当前源码包不含WxLens安装器。请使用含vendor安装器的整合包，或从你已获授权的来源安装WxLens后重试。')
  const stat = fs.statSync(file)
  if (!stat.isFile() || stat.size !== INSTALLER.bytes) throw new Error('WxLens安装器大小不匹配，停止启动')
  const hash = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  if (hash.digest('hex') !== INSTALLER.sha256) throw new Error('WxLens安装器SHA-256不匹配，停止启动')
  return { ...INSTALLER, verified: true, signature: '原来源记录为未签名，哈希仅证明与已提供文件相同' }
}
async function setup() {
  if (!process.stdin.isTTY) throw new Error('首次设置需要你在本机终端交互操作。请双击setup.cmd；不要通过MCP stdio运行setup。')
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = async text => /^(y|yes|是)$/i.test((await prompt.question(text + ' [y/N] ')).trim())
  try {
    let config = readConfig(), exe = discoverWxlens(config)
    if (!exe) {
      if (process.platform !== 'win32') throw new Error('原整合包的WxLens安装器适用于Windows；此平台请自行准备兼容本机服务。')
      const file = path.join(ROOT, 'vendor', INSTALLER.name)
      await verifyInstaller(file)
      console.log('已核验WxLens 4.3.0安装器的大小和SHA-256。原安装器未签名；请确认其来源为你信任的原项目整合包。')
      if (!(await ask('现在运行交互式WxLens安装器？'))) { console.log('未启动安装器。你可以稍后重新运行setup.cmd。'); return }
      await new Promise((resolve, reject) => { const child = spawn(file, [], { stdio: 'inherit', shell: false }); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('安装器退出或取消，未报告成功'))) })
      exe = discoverWxlens(config)
      if (!exe) { console.log('安装器已退出。若安装在自定义位置，请运行 node src/cli.js config --wxlens-exe "完整程序路径"，然后再运行setup。'); return }
    }
    config = saveConfig({ ...config, wxlensExe: exe, autoStart: true })
    console.log('已找到WxLens并保存自动启动设置。首次初始化在WxLens原有界面内完成，眼不读取或输出密钥。')
    if (await ask('现在打开WxLens界面，完成微信登录、密钥获取和本地索引初始化？')) await launchDesktop(exe, false)
    console.log('\n接下来：\n1. 按WxLens界面提示完成登录/扫码（若界面要求）、一次性密钥获取和初始化。\n2. 确认其本地HTTP服务可用。\n3. 把下面的配置合并到AI客户端，重新加载MCP后直接提问。\n\n日常无需额外网页。眼在查询发现服务未运行时会尝试后台启动WxLens。\n')
    console.log(renderMcpConfigs().json)
  } finally { prompt.close() }
}
module.exports = { setup, verifyInstaller, INSTALLER }
