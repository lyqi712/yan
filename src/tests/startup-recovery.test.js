const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createApiClient } = require('../yan-runtime')
const { request } = require('../http-client')
const offline = () => Object.assign(new Error('fixture offline'), { code: 'YAN_UNREACHABLE' })

test('健康接口在线但数据库未连接时，不把启动判为成功', async () => {
  let started = false, polls = 0, business = 0
  const client = createApiClient({ startupTimeoutMs: 1000, pollIntervalMs: 1,
    readConfig: () => ({ autoStart: true }), discover: () => 'fixture', launch: async () => { started = true },
    request: async api => {
      if (!started) throw offline()
      if (api === '/api/health') return { status: 'ok' }
      if (api === '/api/status') return { connected: ++polls >= 3 }
      business++; return { messages: ['synthetic'] }
    },
  })
  assert.deepEqual(await client('/api/messages'), { messages: ['synthetic'] })
  assert.equal(polls, 3)
  assert.equal(business, 1)
})

test('启动失败的冷却期保留具体错误，过期后可恢复查询', async () => {
  let clock = 100000, ready = false, starts = 0
  const client = createApiClient({ now: () => clock, retryDelayMs: 30,
    readConfig: () => ({ autoStart: true }), discover: () => 'fixture',
    launch: async () => { starts++; if (!ready) throw Object.assign(new Error('synthetic launch failed'), { code: 'YAN_LAUNCH_FAILED' }) },
    request: async api => { if (!ready) throw offline(); return { api } },
  })
  await assert.rejects(client('/api/messages'), /synthetic launch failed/)
  await assert.rejects(client('/api/messages'), e => e.code === 'YAN_LAUNCH_FAILED' && /synthetic launch failed/.test(e.message))
  assert.equal(starts, 1)
  clock += 31; ready = true
  assert.equal((await client('/api/messages')).api, '/api/messages')
})

test('健康探测成功不清除启动失败冷却，冷却结束后才允许重启', async () => {
  let clock = 100000, starts = 0, ready = false
  const client = createApiClient({ now: () => clock, retryDelayMs: 30, startupTimeoutMs: 10, pollIntervalMs: 1,
    readConfig: () => ({ autoStart: true }), discover: () => 'fixture',
    launch: async () => { starts++; if (starts > 1) ready = true },
    request: async api => {
      if (api === '/api/health') return { status: 'ok' }
      if (api === '/api/status') return { connected: ready }
      if (ready) return { api }
      throw offline()
    },
  })
  await assert.rejects(client('/api/messages'), error => error.code === 'YAN_STARTUP_NOT_READY')
  await client('/api/health')
  await assert.rejects(client('/api/messages'), error => error.code === 'YAN_STARTUP_NOT_READY')
  assert.equal(starts, 1)
  clock += 31
  assert.equal((await client('/api/messages')).api, '/api/messages')
  assert.equal(starts, 2)
})

test('状态接口明确不支持时，兼容旧版健康接口', async () => {
  let ready = false
  const client = createApiClient({ readConfig: () => ({}), discover: () => 'fixture', launch: async () => { ready = true }, request: async api => {
    if (!ready) throw offline()
    if (api === '/api/status') throw Object.assign(new Error('HTTP 404'), { code: 'YAN_HTTP_ERROR', status: 404 })
    return { api }
  } })
  assert.equal((await client('/api/messages')).api, '/api/messages')
})

test('上游业务错误有安全错误分类但不回显上游私密正文', async t => {
  const server = http.createServer((_req, res) => { res.writeHead(503); res.end('synthetic-secret') })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  t.after(() => { server.closeAllConnections(); server.close() })
  await assert.rejects(request('/api/messages', {}, { config: { baseUrl: `http://127.0.0.1:${server.address().port}`, requestTimeoutMs: 500 } }), e => e.code === 'YAN_HTTP_ERROR' && e.status === 503 && !e.message.includes('synthetic-secret'))
})

test('原生诊断只解析有界JSON，不回传子进程日志和账号配置', async t => {
  const { probeNativeRuntime } = require('../native-diagnostics')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yan-native-fixture-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const exe = path.join(root, 'WxLens.exe')
  const dllDir = path.join(root, 'resources', 'resources', 'wcdb', 'win32', process.arch)
  fs.mkdirSync(dllDir, { recursive: true }); fs.writeFileSync(path.join(dllDir, 'wcdb_api.dll'), 'synthetic, never loaded')
  fs.writeFileSync(path.join(root, 'electron.exe'), 'synthetic, never executed')
  fs.mkdirSync(path.join(root, 'resources', 'app.asar'), { recursive: true })
  const result = await probeNativeRuntime(exe, { platform: 'win32', run: async (_command, args, options) => {
    assert.equal(options.env.WX_MCP_KEY, undefined)
    assert.equal(options.env.WX_MCP_DB_PATH, undefined)
    assert.equal(options.env.NODE_OPTIONS, undefined)
    assert.equal(options.shell, false)
    assert.match(args[1], /InitProtection/)
    assert.doesNotMatch(args[1], /loadConfig|open_account|dpapiDecrypt/)
    return { stdout: JSON.stringify({ protectionCode: -101, initCode: null }), stderr: 'synthetic-secret', code: 0 }
  } })
  assert.equal(result.status, 'fail'); assert.equal(result.code, 'YAN_NATIVE_PROTECTION_FAILED')
  assert.equal(result.protectionCode, -101); assert.equal(result.dllSha256.length, 64)
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/)
})

test('启动轮询保留可安全分类的HTTP 503，而非统一覆盖为超时', async () => {
  let started = false
  const client = createApiClient({ startupTimeoutMs: 10, pollIntervalMs: 1,
    readConfig: () => ({ autoStart: true }), discover: () => 'fixture', launch: async () => { started = true },
    request: async api => {
      if (!started) throw offline()
      if (api === '/api/health') return { status: 'ok' }
      throw Object.assign(new Error('HTTP 503'), { code: 'YAN_HTTP_ERROR', status: 503 })
    },
  })
  await assert.rejects(client('/api/messages'), error => error.code === 'YAN_HTTP_ERROR' && error.status === 503 && error.message === 'HTTP 503')
})

test('原生启动第二层失败也明确报告，不把InitProtection通过当完整恢复', () => {
  const { describeNativeResult } = require('../native-diagnostics')
  const failed = describeNativeResult({ protectionCode: 0, initCode: -1000 })
  assert.equal(failed.status, 'fail'); assert.equal(failed.code, 'YAN_NATIVE_INIT_FAILED')
  assert.match(failed.detail, /-1000/)
  assert.equal(describeNativeResult({ protectionCode: 0, initCode: 0 }).status, 'pass')
  assert.equal(describeNativeResult({ protectionCode: '0', initCode: 0 }).status, 'fail')
})

test('doctor区分HTTP健康、数据库未连接和旧版缺少状态接口', async () => {
  const { checkService } = require('../doctor')
  const send = connected => async api => api === '/api/health' ? { status: 'ok' } : { connected }
  assert.equal((await checkService({}, send(false)))[1].status, 'fail')
  assert.equal((await checkService({}, send(true)))[1].status, 'pass')
  const legacy = await checkService({}, async api => {
    if (api === '/api/health') return { status: 'ok' }
    throw Object.assign(new Error('unsupported'), { code: 'YAN_HTTP_ERROR', status: 404 })
  })
  assert.equal(legacy[1].status, 'optional')
  const broken = await checkService({}, async api => {
    if (api === '/api/health') return { status: 'ok' }
    throw Object.assign(new Error('broken'), { code: 'YAN_HTTP_ERROR', status: 503 })
  })
  assert.equal(broken[1].status, 'fail')
})

test('原生探测超时或输出不合法时，不回传日志且不伪造通过', async t => {
  const { probeNativeRuntime } = require('../native-diagnostics')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yan-native-invalid-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dllDir = path.join(root, 'resources', 'resources', 'wcdb', 'win32', process.arch)
  fs.mkdirSync(dllDir, { recursive: true }); fs.writeFileSync(path.join(dllDir, 'wcdb_api.dll'), 'fixture')
  fs.writeFileSync(path.join(root, 'electron.exe'), 'fixture'); fs.mkdirSync(path.join(root, 'resources', 'app.asar'))
  for (const output of [{ code: 0, stdout: 'synthetic-secret' }, { code: 1, stdout: '{}' }, { code: 0, stdout: 'a'.repeat(4097) }, { timedOut: true }]) {
    const result = await probeNativeRuntime(path.join(root, 'WxLens.exe'), { platform: 'win32', run: async () => output })
    assert.equal(result.status, 'fail'); assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/)
  }
})

