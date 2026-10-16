const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const vm = require('node:vm')
const { runProbe, NATIVE_PROBE } = require('../native-diagnostics')
const { createApiClient } = require('../yan-runtime')

function mockChild(kill) {
  const child = new EventEmitter()
  child.pid = 12345
  child.stdout = new EventEmitter()
  child.stderr = { resume() {} }
  child.kill = () => kill(child)
  return child
}

test('探测超时由统一close处理，不因监听顺序丢失分类', async () => {
  const child = mockChild(c => { c.emit('close', null); return true })
  const result = await runProbe('synthetic', [], {}, { spawn: () => child, timeoutMs: 1, terminationMs: 10 })
  assert.equal(result.timedOut, true)
  assert.equal(result.exitConfirmed, true)
})

for (const mode of ['false', 'throw', 'no-close']) test(`探测终止${mode}时不能声称已停止`, async () => {
  const child = mockChild(() => { if (mode === 'throw') throw new Error('fixture'); return mode !== 'false' })
  const result = await runProbe('synthetic', [], {}, { spawn: () => child, timeoutMs: 1, terminationMs: 2 })
  assert.equal(result.terminationFailed, true)
  assert.notEqual(result.exitConfirmed, true)
})

test('终止error但没有close仍报告未确认退出', async () => {
  const child = mockChild(c => { c.emit('error', new Error('synthetic')); return false })
  const result = await runProbe('synthetic', [], {}, { spawn: () => child, timeoutMs: 1, terminationMs: 2 })
  assert.equal(result.terminationFailed, true)
  assert.notEqual(result.exitConfirmed, true)
})

test('终止error后延迟close必须等待退出', async () => {
  const child = mockChild(c => { c.emit('error', new Error('synthetic')); setTimeout(() => c.emit('close', null), 5); return true })
  const result = await runProbe('synthetic', [], {}, { spawn: () => child, timeoutMs: 1, terminationMs: 20 })
  assert.equal(result.exitConfirmed, true)
  assert.equal(result.timedOut, true)
})

test('输出超限后等待延迟退出，不返回或保留日志', async () => {
  const child = mockChild(c => { setTimeout(() => c.emit('close', null), 5); return true })
  const pending = runProbe('synthetic', [], {}, { spawn: () => child, timeoutMs: 30, terminationMs: 20 })
  child.stdout.emit('data', Buffer.alloc(4097, 's'))
  const result = await pending
  assert.equal(result.outputExceeded, true)
  assert.equal(result.exitConfirmed, true)
  assert.equal(result.stdout, '')
})

test('新版缺少认证入口时fail-closed，不调用koffi', async () => {
  let nativeCalls = 0, output = '', exits = 0
  vm.runInNewContext(NATIVE_PROBE, {
    require: file => {
      if (file === 'node:path') return require('node:path')
      if (file === 'node:fs') return { existsSync: () => false }
      if (file.endsWith('package.json')) return { version: '4.7.2' }
      nativeCalls++
      throw new Error('Unexpected native call')
    },
    process: { argv: ['synthetic', '/fixture', 'synthetic-hash'], stdout: { write: s => { output += s } }, exit: () => { if (++exits === 1) throw new Error('synthetic-exit') } },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(nativeCalls, 0)
  assert.match(output, /unsupported-runtime/)
  assert.doesNotMatch(output, /initialized.*true/)
})

test('认证失败不得降级为直接原生探测', async () => {
  let nativeCalls = 0, output = '', exits = 0
  vm.runInNewContext(NATIVE_PROBE, {
    require: file => {
      if (file === 'node:path') return require('node:path')
      if (file === 'node:fs') return { existsSync: () => true }
      if (file.endsWith('wcdb-client.js')) return { WcdbClient: class { setResourcesPath() {} initialize() { throw Object.assign(new Error('synthetic-private'), { code: 'LICENSE_EXPIRED' }) } } }
      nativeCalls++
      throw new Error('Unexpected native call')
    },
    process: { argv: ['synthetic', '/fixture'], stdout: { write: s => { output += s } }, exit: () => { if (++exits === 1) throw new Error('synthetic-exit') } },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(nativeCalls, 0)
  assert.match(output, /LICENSE_EXPIRED/)
  assert.doesNotMatch(output, /synthetic-private/)
})

test('未就绪status成功响应不能解除启动失败冷却', async () => {
  let launches = 0
  const client = createApiClient({ startupTimeoutMs: 5, pollIntervalMs: 1, now: () => 100, readConfig: () => ({}), discover: () => 'synthetic', launch: async () => { launches++ }, request: async api => {
    if (api === '/api/health') return { status: 'ok' }
    if (api === '/api/status') return { connected: true, queryReady: false }
    throw Object.assign(new Error('offline'), { code: 'YAN_UNREACHABLE' })
  } })
  await assert.rejects(client('/api/messages'))
  await client('/api/status')
  await assert.rejects(client('/api/messages'))
  assert.equal(launches, 1)
})
