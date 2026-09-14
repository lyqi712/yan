const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { request } = require('../http-client')

test('兼容真实WxLens健康接口status格式，但业务接口仍要求ok封装', async t => {
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ status: 'ok' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const config = { baseUrl: `http://127.0.0.1:${server.address().port}`, requestTimeoutMs: 1000 }
  assert.equal((await request('/api/health', {}, { config })).status, 'ok')
  await assert.rejects(request('/api/messages', {}, { config }), /未返回成功/)
})
