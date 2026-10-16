const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createHash } = require('node:crypto')
const { spawn } = require('node:child_process')

const NATIVE_PROBE = `
const path = require('node:path');
(async () => {
try {
  const root = process.argv[1];
  const fs = require('node:fs');
  const upstream = path.join(root, 'resources', 'app.asar', 'tools', 'wx-mcp-server');
  if (fs.existsSync(path.join(upstream, 'license.js'))) {
    try {
      const { WcdbClient } = require(path.join(upstream, 'wcdb-client.js'));
      const client = new WcdbClient();
      client.setResourcesPath(path.join(root, 'resources', 'resources'));
      await client.initialize();
      client.close();
      process.stdout.write(JSON.stringify({ guarded: true, initialized: true }));
    } catch (error) {
      const allowed = ['LICENSE_DEVICE_ERROR', 'LICENSE_DEVICE_MISMATCH', 'LICENSE_CLOCK_ROLLBACK', 'LICENSE_EXPIRED', 'LICENSE_INVALID'];
      const failure = allowed.includes(error.code) ? error.code : 'NATIVE_INITIALIZATION_FAILED';
      process.stdout.write(JSON.stringify({ guarded: true, initialized: false, failure }));
    }
    process.exit(0);
  }
  const legacyVersion = require(path.join(root, 'resources', 'app.asar', 'package.json')).version;
  if (legacyVersion !== '4.3.0' || process.argv[2] !== '6915913a3a9930694e5c821bf58841e17bbad0f56691e307674fb0e31e9d44b8') {
    process.stdout.write(JSON.stringify({ failure: 'unsupported-runtime' }));
    process.exit(1);
  }
  const koffi = require(path.join(root, 'resources', 'app.asar', 'tools', 'wx-mcp-server', 'node_modules', 'koffi'));
  const resources = path.join(root, 'resources', 'resources');
  const dllDir = path.join(resources, 'wcdb', 'win32', process.arch);
  for (const name of ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'msvcp140_1.dll']) {
    const file = path.join(resources, 'runtime', 'win32', name);
    if (fs.existsSync(file)) try { koffi.load(file); } catch {}
  }
  for (const name of ['WCDB.dll', 'SDL2.dll']) {
    const file = path.join(dllDir, name);
    if (fs.existsSync(file)) koffi.load(file);
  }
  const lib = koffi.load(path.join(dllDir, 'wcdb_api.dll'));
  const protection = lib.func('int32 InitProtection(const char* resourcePath)');
  let protectionCode = null;
  for (const candidate of [dllDir, path.dirname(dllDir), path.resolve(dllDir, '..', '..'), resources]) {
    protectionCode = protection(candidate);
    if (protectionCode === 0 || protectionCode === -101) break;
  }
  let initCode = null;
  if (protectionCode === 0) {
    initCode = lib.func('int32 wcdb_init()')();
    if (initCode === 0) lib.func('int32 wcdb_shutdown()')();
  }
  process.stdout.write(JSON.stringify({ protectionCode, initCode }));
  process.exit(0);
} catch {
  process.stdout.write(JSON.stringify({ failure: 'native-load-or-call' }));
  process.exit(1);
}
})();
`

function describeNativeResult(value) {
  if (value?.guarded === true) {
    if (value.initialized === true) return { status: 'pass', detail: '经上游正常认证与原生初始化入口通过；未加载账号配置或打开聊天数据库，真实读取仍需验收。' }
    const authorization = ['LICENSE_DEVICE_ERROR', 'LICENSE_DEVICE_MISMATCH', 'LICENSE_CLOCK_ROLLBACK', 'LICENSE_EXPIRED', 'LICENSE_INVALID'].includes(value.failure)
    return { status: 'fail', code: authorization ? 'YAN_COMPONENT_AUTHORIZATION_FAILED' : 'YAN_NATIVE_INIT_FAILED', detail: authorization ? '组件认证未通过；请在原组件界面核对认证状态。此认证与微信密钥不同，不要重新取钥或绕过认证。' : '上游正常认证/原生初始化未完成；未回传错误正文。请使用组件诊断入口核对，未证明微信密钥失效。' }
  }
  if (!value || !Number.isInteger(value.protectionCode) || (value.initCode !== null && !Number.isInteger(value.initCode))) {
    return { status: 'fail', code: 'YAN_NATIVE_PROBE_FAILED', detail: '原生组件探测未返回有效结果；请核对运行时、架构与依赖。此结果不代表微信登录失效。' }
  }
  if (value.protectionCode !== 0) return {
    status: 'fail', code: 'YAN_NATIVE_PROTECTION_FAILED', protectionCode: value.protectionCode, initCode: null,
    detail: `原生 InitProtection 返回 ${value.protectionCode}，尚未打开聊天数据库。${value.protectionCode === -101 ? '同类上游报告涉及组件有效期，但本文件原因仍须组件提供者确认。' : ''}请保留配置并取得可信、适配的原生更新；重新登录不能修复此初始化失败。不要调整系统时间、关闭安全防护或跳过保护检查。`,
  }
  if (value.initCode !== 0) return { status: 'fail', code: 'YAN_NATIVE_INIT_FAILED', protectionCode: 0, initCode: value.initCode, detail: `InitProtection 已通过，但 wcdb_init 返回 ${value.initCode}。原生运行时仍未就绪，需组件提供者确认；此探测没有打开聊天数据库。` }
  return { status: 'pass', protectionCode: 0, initCode: 0, detail: '原生两阶段初始化通过；未读取密钥或打开聊天数据库，真实读取仍需查询验收。' }
}

function runProbe(command, args, options, controls = {}) {
  return new Promise(resolve => {
    let stdout = '', bytes = 0, done = false, timer, terminationTimer, reason = null
    const finish = result => { if (done) return; done = true; clearTimeout(timer); clearTimeout(terminationTimer); resolve(result) }
    let child
    try { child = (controls.spawn || spawn)(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch { finish({ code: -1, stdout: '' }); return }
    child.stderr.resume()
    const terminate = cause => {
      if (reason || done) return
      reason = cause
      terminationTimer = setTimeout(() => finish({ code: -1, stdout: '', timedOut: cause === 'timeout', terminationFailed: true }), controls.terminationMs ?? 250)
      try { child.kill() } catch {}
    }
    timer = setTimeout(() => terminate('timeout'), controls.timeoutMs ?? 5000)
    child.stdout.on('data', chunk => {
      if (reason || done) return
      bytes += chunk.length
      if (bytes > 4096) { stdout = ''; terminate('oversize'); return }
      stdout += chunk.toString('utf8')
    })
    child.once('error', () => {
      if (!child.pid && !reason) { finish({ code: -1, stdout: '', notStarted: true }); return }
      terminate('process-error')
    })
    child.once('close', code => finish(reason ? { code: -1, stdout: '', timedOut: reason === 'timeout', outputExceeded: reason === 'oversize', exitConfirmed: true } : { code, stdout, exitConfirmed: true }))
  })
}

async function probeNativeRuntime(executable, options = {}) {
  if ((options.platform || process.platform) !== 'win32') return { status: 'optional', detail: '原生探测仅支持眼所使用的 Windows 本机组件。' }
  if (!executable) return { status: 'optional', detail: '没有发现程序，无法探测其原生组件。' }
  const root = path.dirname(path.resolve(executable))
  const runtime = path.join(root, 'electron.exe')
  const dll = path.join(root, 'resources', 'resources', 'wcdb', 'win32', process.arch, 'wcdb_api.dll')
  let dllSha256
  try {
    if (!fs.statSync(runtime).isFile() || !fs.existsSync(path.join(root, 'resources', 'app.asar'))) throw new Error()
    const size = fs.statSync(dll).size
    if (size <= 0 || size > 32 * 1024 * 1024) throw new Error()
    dllSha256 = createHash('sha256').update(fs.readFileSync(dll)).digest('hex')
  } catch { return { status: 'optional', detail: '此安装布局不支持原生探测；请使用组件提供者的诊断入口。' } }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yan-native-probe-'))
  const sourceEnv = options.env || process.env
  const env = { ELECTRON_RUN_AS_NODE: '1' }
  for (const [name, value] of Object.entries(sourceEnv)) if (/^(SystemRoot|WINDIR|SystemDrive|PATH|PATHEXT|COMSPEC|TEMP|TMP)$/i.test(name)) env[name] = value
  Object.assign(env, { HOME: profile, USERPROFILE: profile, APPDATA: path.join(profile, 'Roaming'), LOCALAPPDATA: path.join(profile, 'Local'), XDG_CONFIG_HOME: path.join(profile, 'config'), XDG_DATA_HOME: path.join(profile, 'data'), WX_MCP_CONFIG_DIR: path.join(profile, 'wx-config') })
  for (const dir of [env.APPDATA, env.LOCALAPPDATA, env.WX_MCP_CONFIG_DIR]) fs.mkdirSync(dir, { recursive: true })
  let output
  try { output = await (options.run || runProbe)(runtime, ['-e', NATIVE_PROBE, root, dllSha256], { env, cwd: root, windowsHide: true, shell: false }) }
  catch { return { status: 'fail', code: 'YAN_NATIVE_PROBE_FAILED', dllSha256, detail: '原生探测进程无法启动；未回传进程日志或配置。' } }
  finally { if (output?.exitConfirmed || output?.notStarted || (options.run && !output?.terminationFailed)) try { fs.rmSync(profile, { recursive: true, force: true }) } catch {} }
  if (output.terminationFailed) return { status: 'fail', code: 'YAN_NATIVE_PROBE_TERMINATION_FAILED', dllSha256, detail: '已请求终止原生探测，但未确认进程退出；请检查本次探测进程，不要继续重复探测。' }
  if (output.timedOut) return { status: 'fail', code: 'YAN_NATIVE_PROBE_TIMEOUT', dllSha256, detail: '原生探测超过5秒已停止；未读取账号配置。' }
  if (output.code !== 0 || typeof output.stdout !== 'string' || Buffer.byteLength(output.stdout) > 4096) return { ...describeNativeResult(null), dllSha256 }
  let value
  try { value = JSON.parse(output.stdout.trim()) } catch { value = null }
  return { ...describeNativeResult(value), dllSha256 }
}

module.exports = { probeNativeRuntime, describeNativeResult, runProbe, NATIVE_PROBE }
