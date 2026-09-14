const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { readConfig, listAccounts } = require('./config')
const { request } = require('./http-client')

function discoverWxlens(config = readConfig(), env = process.env) {
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const candidates = [config.wxlensExe, path.join(local, 'Programs', 'WxLens', 'WxLens.exe'), path.join(local, 'WxLens', 'WxLens.exe'), path.join(env.ProgramFiles || 'C:/Program Files', 'WxLens', 'WxLens.exe')].filter(Boolean)
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) return path.resolve(candidate); const exe = path.join(candidate, 'WxLens.exe'); if (fs.statSync(exe).isFile()) return path.resolve(exe) } catch {}
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
    child.once('error', () => reject(new Error('WxLens启动失败。请手动打开WxLens，或重新配置wxlensExe路径。')))
    child.once('spawn', () => { child.unref(); resolve() })
  })
}
function createApiClient(options = {}) {
  const read = options.readConfig || readConfig, send = options.request || request, discover = options.discover || discoverWxlens, launch = options.launch || launchDesktop
  let starting = null, lastAttempt = 0
  async function ensure(config) {
    if (starting) return starting
    if (Date.now() - lastAttempt < 30000) throw new Error('WxLens仍未就绪。首次使用请运行 setup.cmd，在WxLens界面完成微信登录、密钥获取和本地初始化后重试。')
    lastAttempt = Date.now()
    starting = (async () => {
      const exe = discover(config)
      if (!exe) throw new Error('未找到WxLens。请运行 setup.cmd 安装/打开WxLens，首次按其界面完成登录、密钥获取和初始化。已安装在自定义位置时用 --wxlens-exe 指定。')
      await launch(exe, true)
      const deadline = Date.now() + (options.startupTimeoutMs || 15000)
      while (Date.now() < deadline) {
        try { await send('/api/health', {}, { config: { ...config, requestTimeoutMs: Math.min(1500, Math.max(50, deadline - Date.now())) } }); return }
        catch { await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now())))) }
      }
      throw new Error('已尝试启动WxLens，服务尚未就绪。首次使用请运行 setup.cmd，在WxLens原界面完成微信登录、密钥获取和初始化。眼不会索取或输出密钥。')
    })().finally(() => { starting = null })
    return starting
  }
  return async (api, params = {}) => {
    const config = read()
    try { return await send(api, params, { config }) }
    catch (error) {
      if (error.code !== 'WXLENS_UNREACHABLE' || config.autoStart === false) throw error
      await ensure(config); return send(api, params, { config })
    }
  }
}
module.exports = { discoverWxlens, discoverAccount, launchDesktop, createApiClient }
