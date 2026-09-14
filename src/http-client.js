const { readConfig, validateBaseUrl } = require('./config')
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

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
    const response = await fetch(url, { signal: controller.signal, redirect: 'error' })
    if (!response.ok) throw new Error(`WxLens 返回 HTTP ${response.status}`)
    let bytes = 0
    const chunks = []
    for await (const chunk of response.body) {
      bytes += chunk.length
      if (bytes > MAX_RESPONSE_BYTES) { controller.abort(); throw new Error('返回内容超过 16 MB，请缩小查询范围') }
      chunks.push(chunk)
    }
    let payload
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('WxLens 返回了非 JSON 内容，请核对端口与服务版本') }
    // WxLens 4.3.0 health is {status:"ok"}; data endpoints retain {ok:true,data}.
    if (apiPath === '/api/health' && payload?.status === 'ok') return payload
    if (!payload || payload.ok !== true) throw new Error('WxLens 未返回成功结果，请在 WxLens 中检查登录与索引状态')
    return payload.data
  } catch (error) {
    if (controller.signal.aborted && error.message !== '返回内容超过 16 MB，请缩小查询范围') throw new Error('WxLens 请求超时，请检查服务状态或缩小查询范围')
    if (error instanceof TypeError) { const failure = new Error('无法连接本机WxLens。请完成WxLens初始化后重试。'); failure.code = 'WXLENS_UNREACHABLE'; throw failure }
    throw error
  } finally { clearTimeout(timeout) }
}

module.exports = { request }
