const { readConfig, validateBaseUrl } = require('./config')
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const CONNECT_ERRORS = new Set(['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'])
function isConnectFailure(cause) {
  if (!cause) return false
  if (CONNECT_ERRORS.has(cause.code)) return true
  return Array.isArray(cause.errors) && cause.errors.length > 0 && cause.errors.length <= 4 && cause.errors.every(error => CONNECT_ERRORS.has(error?.code))
}

async function request(apiPath, params = {}, options = {}) {
  if (!/^\/api\/[a-z-]+$/.test(apiPath)) throw new Error('不支持的服务接口')
  const config = options.config || readConfig()
  const url = new URL(validateBaseUrl(config.baseUrl) + apiPath)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value))
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs || 8000)
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'manual' })
    if (!response.ok) {
      try { await response.body?.cancel() } catch {}
      const failure = new Error(`眼的本机服务返回 HTTP ${response.status}`)
      failure.code = 'YAN_HTTP_ERROR'
      failure.status = response.status
      throw failure
    }
    let bytes = 0
    const chunks = []
    for await (const chunk of response.body) {
      bytes += chunk.length
      if (bytes > MAX_RESPONSE_BYTES) { controller.abort(); throw new Error('返回内容超过 16 MB，请缩小查询范围') }
      chunks.push(chunk)
    }
    let payload
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('眼的本机服务返回了非 JSON 内容，请核对端口与服务版本') }
    // 眼使用的 4.3.0 健康接口是 {status:"ok"}；业务接口仍是 {ok:true,data}。
    if (apiPath === '/api/health' && payload?.status === 'ok') return payload
    if (!payload || payload.ok !== true) throw new Error('眼的本机服务未返回成功结果，请在眼的界面中检查登录与索引状态')
    return payload.data
  } catch (error) {
    if (controller.signal.aborted && error.message !== '返回内容超过 16 MB，请缩小查询范围') throw new Error('眼的本机服务请求超时，请检查服务状态或缩小查询范围')
    if (error instanceof TypeError) {
      if (isConnectFailure(error.cause)) {
        const failure = new Error('无法连接眼的本机服务。请先检查程序路径、后台服务和原生组件；仅首次初始化缺失时运行 setup.cmd，已有配置时不要直接重新登录或取钥。')
        failure.code = 'YAN_UNREACHABLE'
        throw failure
      }
      throw Object.assign(new Error('眼的本机服务连接或响应异常；未判定为离线，不自动重复启动。请核对服务状态与协议。'), { code: 'YAN_TRANSPORT_ERROR' })
    }
    throw error
  } finally { clearTimeout(timeout) }
}

module.exports = { request }
