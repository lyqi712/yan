const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { randomUUID } = require('node:crypto')
const ROOT = path.resolve(__dirname, '..')
const CONFIG_FILE = path.join(ROOT, '.local', 'config.json')
const KEYS = ['baseUrl', 'accountDir', 'wxlensExe', 'requestTimeoutMs', 'autoStart']

function validateBaseUrl(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('服务地址无效，请填写 http://127.0.0.1:5032') }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('服务地址只允许本机 HTTP IP（127.0.0.1 或 [::1]），不能包含路径、凭据或查询参数')
  }
  return url.origin
}

function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置必须是 JSON 对象')
  for (const key of Object.keys(value)) if (!KEYS.includes(key)) throw new Error(`不支持的配置项：${key}`)
  if (value.autoStart !== undefined && typeof value.autoStart !== 'boolean') throw new Error('autoStart必须为布尔值')
  const result = { autoStart: value.autoStart !== false, baseUrl: validateBaseUrl(value.baseUrl || 'http://127.0.0.1:5032'), requestTimeoutMs: value.requestTimeoutMs ?? 8000 }
  if (!Number.isInteger(result.requestTimeoutMs) || result.requestTimeoutMs < 500 || result.requestTimeoutMs > 30000) throw new Error('请求超时必须为 500–30000 毫秒')
  for (const key of ['accountDir', 'wxlensExe']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 4096 || /[\x00-\x1f]/.test(value[key]))) throw new Error(`${key} 路径无效`)
    result[key] = value[key] ? path.resolve(value[key]) : ''
  }
  return result
}

function readConfig(options = {}) {
  const file = options.file || CONFIG_FILE
  let local = {}
  if (fs.existsSync(file)) {
    try { local = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { throw new Error('本地配置无法解析。请修复 .local/config.json 或备份后修复该文件。') }
  }
  const env = options.env || process.env
  return validateConfig({ ...local,
    ...(env.WXLENS_HTTP_BASE_URL ? { baseUrl: env.WXLENS_HTTP_BASE_URL } : {}),
    ...(env.WXLENS_ACCOUNT_DIR ? { accountDir: env.WXLENS_ACCOUNT_DIR } : {}),
    ...(env.WXLENS_AUTO_START ? { autoStart: env.WXLENS_AUTO_START !== 'false' } : {}),
    ...(env.WXLENS_DESKTOP_EXE ? { wxlensExe: env.WXLENS_DESKTOP_EXE } : {}),
  })
}

function saveConfig(value, file = CONFIG_FILE) {
  const data = validateConfig(value)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = file + '.' + randomUUID() + '.tmp'
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  fs.renameSync(temporary, file)
  return data
}

function listAccounts(base) {
  const candidates = base ? [path.resolve(base)] : [path.join(os.homedir(), 'Documents', 'xwechat_files'), path.join(os.homedir(), 'xwechat_files')]
  const found = new Set()
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'db_storage'))) found.add(candidate)
    try {
      for (const entry of fs.readdirSync(candidate, { withFileTypes: true }).slice(0, 500)) {
        if (entry.isDirectory() && entry.name.startsWith('wxid_') && fs.existsSync(path.join(candidate, entry.name, 'db_storage'))) found.add(path.join(candidate, entry.name))
      }
    } catch {}
  }
  return [...found]
}

function renderMcpConfigs(root = ROOT, node = process.execPath) {
  const definition = { command: node, args: [path.join(root, 'src', 'server.js')] }
  // JSON string literals are also valid TOML basic strings for these paths.
  return {
    json: JSON.stringify({ mcpServers: { yan: definition } }, null, 2),
    codex: `[mcp_servers.yan]\ncommand = ${JSON.stringify(definition.command)}\nargs = ${JSON.stringify(definition.args)}\nstartup_timeout_sec = 30\n`,
    proma: JSON.stringify({ type: 'stdio', ...definition }, null, 2),
  }
}

module.exports = { ROOT, CONFIG_FILE, validateBaseUrl, validateConfig, readConfig, saveConfig, listAccounts, renderMcpConfigs }
