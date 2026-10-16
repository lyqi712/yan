const fs = require('node:fs')
const { readConfig, CONFIG_FILE, listAccounts, renderMcpConfigs } = require('./config')
const { getAllowedRoots, getParserCapabilities } = require('./content-tools')
const { request } = require('./http-client')
const { discoverYan, isQueryReady } = require('./yan-runtime')
const { probeNativeRuntime } = require('./native-diagnostics')
const RUNTIME = Object.freeze({ version: require('../package.json').version, startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString() })

async function checkService(config, send = request) {
  try { await send('/api/health', {}, { config }) }
  catch (error) { return [{ id: 'service', status: 'fail', title: '眼的本机服务', detail: error.message, code: error.code }] }
  const checks = [{ id: 'service', status: 'pass', title: '眼的本机服务', detail: '本地健康接口可连接；这不等于聊天数据库已连接' }]
  try {
    const state = await send('/api/status', {}, { config })
    const ready = isQueryReady(state)
    checks.push({ id: 'database', status: ready ? 'pass' : 'fail', title: '聊天数据库查询', detail: ready ? '状态接口报告连接与查询就绪；真实可读性仍需查询验收' : state?.connected === true ? '数据库连接存在但查询未就绪；请在原组件界面检查查询与认证状态，不要重新取钥' : '服务在线但数据库未连接；请检查上游原生初始化、认证与账号配置，不要把健康接口成功当作读取成功' })
  } catch (error) {
    const unsupported = error.code === 'YAN_HTTP_ERROR' && [404, 405, 501].includes(error.status)
    checks.push({ id: 'database', status: unsupported ? 'optional' : 'fail', title: '聊天数据库连接', detail: unsupported ? '此版本没有状态接口；须通过实际查询确认可读性' : '无法核验数据库连接状态；健康接口成功不代表可读' })
  }
  return checks
}

function summarizeReadiness(checks, config, exe) {
  const failed = id => checks.some(item => item.id === id && item.status === 'fail')
  let state, nextStep
  if (failed('native')) {
    state = 'native_error'
    nextStep = '原生组件初始化失败；保留配置，检查组件提供者的适配版本，不要重新取钥或绕过保护。'
  } else if (failed('service')) {
    const unreachable = checks.some(item => item.id === 'service' && item.code === 'YAN_UNREACHABLE')
    state = unreachable ? (config.autoStart && exe ? 'awaiting_auto_start' : 'offline') : 'service_error'
    nextStep = state === 'awaiting_auto_start' ? '服务当前离线，已发现自动启动入口，但尚未验证可读。调用 list_sessions(limit=2) 触发启动并验收；若仍失败，再运行 doctor --native 检查具体原因。'
      : state === 'offline' ? '服务当前离线；打开已安装的眼，再调用 list_sessions 验证。不需要重复初始化或取钥。'
        : '服务返回错误；检查本次错误与服务状态，再运行 doctor --native。不要重复启动已经在线的服务。'
  } else if (failed('database')) {
    state = 'database_not_ready'
    nextStep = 'HTTP服务在线但数据库查询未就绪；检查原组件界面的初始化与认证状态，再通过 list_sessions 验收。'
  } else {
    state = checks.some(item => item.id === 'database' && item.status === 'pass') ? 'query_ready' : 'query_unverified'
    nextStep = '调用 list_sessions(limit=2) 验证实际读取；诊断状态不代替真实查询验收。'
  }
  return { state, queryVerified: false, nextStep }
}

async function diagnose(options = {}) {
  const checks = []
  let config
  try { config = readConfig(); checks.push({ id: 'config', status: 'pass', title: '本地配置', detail: fs.existsSync(CONFIG_FILE) ? '已保存' : '使用默认服务地址；可用config命令补充附件目录' }) }
  catch (error) { return { ok: false, runtime: RUNTIME, checks: [{ id: 'config', status: 'fail', title: '本地配置', detail: error.message }], capabilities: getParserCapabilities() } }
  checks.push({ id: 'node', status: Number(process.versions.node.split('.')[0]) >= 22 ? 'pass' : 'fail', title: 'Node.js', detail: process.versions.node })
  checks.push(...await checkService({ ...config, requestTimeoutMs: options.timeout || 2000 }))
  const exe = discoverYan(config)
  checks.push({ id: 'desktop', status: exe ? 'pass' : 'optional', title: '眼的启动入口', detail: exe ? (config.autoStart ? '可在查询时自动后台启动' : '已关闭自动启动，请自行打开眼') : '未发现程序；现有服务可直接使用，首次安装请运行setup.cmd' })
  if (options.native) {
    const native = await probeNativeRuntime(exe)
    checks.push({ id: 'native', status: native.status, title: '原生数据库组件', detail: native.detail, code: native.code, protectionCode: native.protectionCode, initCode: native.initCode, dllSha256: native.dllSha256 })
  }
  const accounts = listAccounts(config.accountDir || undefined)
  const account = config.accountDir && fs.existsSync(config.accountDir) ? config.accountDir : (accounts.length === 1 ? accounts[0] : '')
  checks.push({ id: 'attachments', status: account && getAllowedRoots(account).length ? 'pass' : 'optional', title: '附件目录', detail: account && getAllowedRoots(account).length ? '已找到本地附件目录' : accounts.length > 1 ? '发现多个账号，请用config --account-dir明确选择' : '尚未指定；聊天检索不依赖此项' })
  const capabilities = getParserCapabilities()
  const { runtimeStatus } = require('./optional-runtime')
  const optionalRuntime = runtimeStatus()
  for (const [id, title, available, detail] of [
    ['ocr', '图片 / 扫描 PDF', capabilities.engines.highAccuracyOcr, optionalRuntime.interpreters.ocr],
    ['media', '音视频深读', capabilities.engines.mediaDeepReader, optionalRuntime.interpreters.media],
    ['xls', '旧 XLS', capabilities.engines.legacyXls, optionalRuntime.interpreters.xls],
  ]) checks.push({ id, status: available ? 'pass' : 'optional', title, detail: available ? `本地解析器可用${detail?.modules ? '，Python模块可加载' : ''}` : '可选组件未就绪；可运行 npm run optional:local 仅探测本机已有模块，不联网安装' })
  const readiness = summarizeReadiness(checks, config, exe)
  return { ok: checks.every(item => item.status !== 'fail'), runtime: RUNTIME, readiness, checks, capabilities, configFile: CONFIG_FILE, nextStep: readiness.nextStep, mcpConfigs: renderMcpConfigs() }
}

if (require.main === module) diagnose().then(data => { console.log(JSON.stringify(data, null, 2)); process.exitCode = data.ok ? 0 : 1 }).catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { diagnose, checkService, summarizeReadiness }
