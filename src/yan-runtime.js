const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { readConfig, listAccounts } = require('./config')
const { request } = require('./http-client')
const PROGRAM_NAMES = ['yan.exe', '眼.exe', 'WxLens.exe']

function discoverYan(config = readConfig(), env = process.env) {
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const programFiles = env.ProgramFiles || 'C:/Program Files'
  const directories = ['yan', '眼', 'WxLens'].flatMap(name => [path.join(local, 'Programs', name), path.join(local, name), path.join(programFiles, name)])
  const candidates = [config.yanExe || config.wxlensExe, ...directories].filter(Boolean)
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return path.resolve(candidate)
      for (const name of PROGRAM_NAMES) {
        const exe = path.join(candidate, name)
        if (fs.statSync(exe).isFile()) return path.resolve(exe)
      }
    } catch {}
  }
  return ''
}
function discoverAccount(config = readConfig()) {
  if (config.accountDir) return config.accountDir
  const accounts = listAccounts()
  if (accounts.length > 1) throw new Error('发现多个账号。请运行 node src/cli.js config --account-dir 目标账号目录，再重试。')
  return accounts[0] || ''
}
function launchDesktop(executable, background = false, spawnProcess = spawn) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, background ? ['--background'] : [], { detached: true, stdio: 'ignore', windowsHide: background, env, shell: false })
    child.once('error', () => reject(new Error('眼启动失败。请手动打开眼，或重新配置 --yan-exe 路径。')))
    child.once('spawn', () => { child.unref(); resolve() })
  })
}
function createApiClient(options = {}) {
  const read = options.readConfig || readConfig, send = options.request || request, discover = options.discover || discoverYan, launch = options.launch || launchDesktop
  let starting = null, lastAttempt = 0
  async function ensure(config) {
    if (starting) return starting
    if (Date.now() - lastAttempt < 30000) throw new Error('眼仍未就绪。首次使用请运行 setup.cmd，在眼的界面完成微信登录、密钥获取和本地初始化后重试。')
    lastAttempt = Date.now()
    starting = (async () => {
      const exe = discover(config)
      if (!exe) throw new Error('未找到眼的本机程序。请运行 setup.cmd 安装或打开眼，首次按其界面完成登录、密钥获取和初始化。已安装在自定义位置时用 --yan-exe 指定。')
      await launch(exe, true)
      const deadline = Date.now() + (options.startupTimeoutMs || 15000)
      while (Date.now() < deadline) {
        try { await send('/api/health', {}, { config: { ...config, requestTimeoutMs: Math.min(1500, Math.max(50, deadline - Date.now())) } }); return }
        catch { await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now())))) }
      }
      throw new Error('已尝试启动眼，服务尚未就绪。首次使用请运行 setup.cmd，在眼的界面完成微信登录、密钥获取和初始化。眼不会索取或输出密钥。')
    })().finally(() => { starting = null })
    return starting
  }
  return async (api, params = {}) => {
    const config = read()
    try { return await send(api, params, { config }) }
    catch (error) {
      if (!['YAN_UNREACHABLE', 'WXLENS_UNREACHABLE'].includes(error.code) || config.autoStart === false) throw error
      await ensure(config); return send(api, params, { config })
    }
  }
}
module.exports = { discoverYan, discoverWxlens: discoverYan, discoverAccount, launchDesktop, createApiClient }
