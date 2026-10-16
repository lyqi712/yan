const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { readConfig, listAccounts } = require('./config')
const { request } = require('./http-client')
const PROGRAM_NAMES = ['WxLens.exe', 'yan.exe', '眼.exe']

function sameFile(left, right) {
  try {
    const a = fs.statSync(left)
    const b = fs.statSync(right)
    return a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino
  } catch { return false }
}
function stableExecutable(file) {
  const resolved = path.resolve(file)
  const original = path.join(path.dirname(resolved), 'WxLens.exe')
  if (path.basename(resolved).toLowerCase() !== 'wxlens.exe' && sameFile(resolved, original)) return original
  return resolved
}
function discoverYan(config = readConfig(), env = process.env) {
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const programFiles = env.ProgramFiles || 'C:/Program Files'
  const directories = ['WxLens', 'yan', '眼'].flatMap(name => [path.join(local, 'Programs', name), path.join(local, name), path.join(programFiles, name)])
  const configured = [config.yanExe, config.wxlensExe].filter(Boolean)
  const candidates = [...configured, ...directories]
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return stableExecutable(candidate)
    } catch { continue }
    for (const name of PROGRAM_NAMES) {
      const exe = path.join(candidate, name)
      try { if (fs.statSync(exe).isFile()) return stableExecutable(exe) } catch {}
    }
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
async function openDesktop(options = {}) {
  const exe = (options.discover || discoverYan)((options.readConfig || readConfig)())
  if (!exe) throw new Error('未找到眼的本机程序，请先配置 --yan-exe 或完成首次安装。')
  await (options.launch || launchDesktop)(exe, false)
}
function isQueryReady(state) {
  return state?.connected === true && (!Object.hasOwn(state, 'queryReady') || state.queryReady === true)
}
function createApiClient(options = {}) {
  const read = options.readConfig || readConfig, send = options.request || request, discover = options.discover || discoverYan, launch = options.launch || launchDesktop
  const now = options.now || Date.now
  let starting = null, lastAttempt = null, lastFailure = null, startupGeneration = 0
  const unreachable = error => ['YAN_UNREACHABLE', 'WXLENS_UNREACHABLE'].includes(error.code)
  const terminalHttp = error => error.code === 'YAN_HTTP_ERROR' && error.status >= 300 && error.status < 500 && ![408, 429].includes(error.status)
  async function ensure(config) {
    if (starting) return starting
    if (lastAttempt !== null && now() - lastAttempt < (options.retryDelayMs ?? 30000)) {
      if (lastFailure) throw lastFailure
      return // A recent successful launch is reused; retry the business request once.
    }
    lastAttempt = now()
    startupGeneration++
    starting = (async () => {
      const exe = discover(config)
      if (!exe) throw new Error('未找到眼的本机程序。请运行 setup.cmd 安装或打开眼，首次按其界面完成登录、密钥获取和初始化。已安装在自定义位置时用 --yan-exe 指定。')
      await launch(exe, true)
      const deadline = Date.now() + (options.startupTimeoutMs || 25000)
      let lastStartupError = null
      while (Date.now() < deadline) {
        try {
          const requestOptions = () => ({ config: { ...config, requestTimeoutMs: Math.min(1500, Math.max(50, deadline - Date.now())) } })
          await send('/api/health', {}, requestOptions())
          if (Date.now() >= deadline) break
          try {
            const status = await send('/api/status', {}, requestOptions())
            if (isQueryReady(status)) { lastFailure = null; return }
          } catch (error) {
            if (error.code === 'YAN_HTTP_ERROR' && [404, 405, 501].includes(error.status)) { lastFailure = null; return }
            if (terminalHttp(error)) throw error
            if (error.code === 'YAN_HTTP_ERROR' && error.status >= 500) lastStartupError = error
          }
        } catch (error) {
          if (terminalHttp(error)) throw error
          if (error.code === 'YAN_HTTP_ERROR' && error.status >= 500) lastStartupError = error
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(options.pollIntervalMs ?? 250, Math.max(0, deadline - Date.now()))))
      }
      if (lastStartupError) throw lastStartupError
      throw Object.assign(new Error('已尝试后台启动眼，但服务尚未就绪。请运行 node src/cli.js doctor --native 区分服务启动、原生初始化与账号初始化故障；已有配置时不要直接重新登录或取钥。仅首次初始化缺失时使用 setup.cmd。'), { code: 'YAN_STARTUP_NOT_READY' })
    })().catch(error => { lastFailure = error; throw error }).finally(() => { starting = null })
    return starting
  }
  return async (api, params = {}) => {
    const config = read()
    const observedGeneration = startupGeneration
    try {
      const result = await send(api, params, { config })
      if (observedGeneration === startupGeneration && api !== '/api/health' && (api !== '/api/status' || isQueryReady(result))) lastFailure = null
      return result
    }
    catch (error) {
      if (!unreachable(error) || config.autoStart === false) throw error
      // An older request may fail after another request has already restarted the service.
      if (starting || observedGeneration === startupGeneration) await ensure(config)
      else if (lastFailure) throw lastFailure
      const retryGeneration = startupGeneration
      try {
        const result = await send(api, params, { config })
        if (retryGeneration === startupGeneration && api !== '/api/health' && (api !== '/api/status' || isQueryReady(result))) lastFailure = null
        return result
      } catch (retryError) {
        if (retryGeneration === startupGeneration && unreachable(retryError) && !lastFailure) lastFailure = retryError
        throw retryError
      }
    }
  }
}
module.exports = { discoverYan, discoverWxlens: discoverYan, discoverAccount, launchDesktop, createApiClient, stableExecutable, isQueryReady, openDesktop }
