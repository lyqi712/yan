const fs = require('node:fs')
const { readConfig, CONFIG_FILE, listAccounts, renderMcpConfigs } = require('./config')
const { getAllowedRoots, getParserCapabilities } = require('./content-tools')
const { request } = require('./http-client')
const { discoverWxlens } = require('./wxlens-runtime')

async function diagnose(options = {}) {
  const checks = []
  let config
  try { config = readConfig(); checks.push({ id: 'config', status: 'pass', title: '本地配置', detail: fs.existsSync(CONFIG_FILE) ? '已保存' : '使用默认服务地址；可用config命令补充附件目录' }) }
  catch (error) { return { ok: false, checks: [{ id: 'config', status: 'fail', title: '本地配置', detail: error.message }], capabilities: getParserCapabilities() } }
  checks.push({ id: 'node', status: Number(process.versions.node.split('.')[0]) >= 22 ? 'pass' : 'fail', title: 'Node.js', detail: process.versions.node })
  try {
    await request('/api/health', {}, { config: { ...config, requestTimeoutMs: options.timeout || 2000 } })
    checks.push({ id: 'service', status: 'pass', title: 'WxLens 服务', detail: '本地接口可连接；聊天索引仍以首次查询结果为准' })
  } catch (error) { checks.push({ id: 'service', status: 'fail', title: 'WxLens 服务', detail: error.message }) }
  const exe = discoverWxlens(config)
  checks.push({ id: 'desktop', status: exe ? 'pass' : 'optional', title: 'WxLens启动入口', detail: exe ? (config.autoStart ? '可在查询时自动后台启动' : '已关闭自动启动，请自行打开WxLens') : '未发现程序；现有服务可直接使用，首次安装请运行setup.cmd' })
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
  return { ok: checks.every(item => item.status !== 'fail'), checks, capabilities, configFile: CONFIG_FILE, nextStep: checks.some(item => item.id === 'service' && item.status === 'fail') ? '首次运行setup.cmd，在WxLens原界面完成微信登录、密钥获取和索引初始化，再运行doctor。日常查询可自动后台启动。' : '将MCP配置合并到AI客户端，重新加载后直接提问；先调用list_sessions定位目标群。', mcpConfigs: renderMcpConfigs() }
}

if (require.main === module) diagnose().then(data => { console.log(JSON.stringify(data, null, 2)); process.exitCode = data.ok ? 0 : 1 }).catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { diagnose }
