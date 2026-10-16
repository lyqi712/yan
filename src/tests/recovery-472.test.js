const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { discoverYan, createApiClient, openDesktop } = require('../yan-runtime')
const { checkService } = require('../doctor')
const { describeNativeResult } = require('../native-diagnostics')

for (const name of ['yan.exe', '眼.exe']) test(`程序目录只有 ${name} 时仍能发现`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yan-discover-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const exe = path.join(root, name)
  fs.writeFileSync(exe, 'synthetic, never executed')
  assert.equal(discoverYan({ yanExe: root }), exe)
})

test('日常打开只复用现有入口，不触发setup', async () => {
  let call
  await openDesktop({ readConfig: () => ({ yanExe: 'fixture' }), discover: c => c.yanExe, launch: async (...args) => { call = args } })
  assert.deepEqual(call, ['fixture', false])
  await assert.rejects(openDesktop({ readConfig: () => ({}), discover: () => '' }), /未找到/)
})

test('doctor 不把 connected=true/queryReady=false 当可读，且不输出私密日志', async () => {
  const checks = await checkService({}, async api => api === '/api/health' ? { status: 'ok' } : {
    connected: true, queryReady: false, queryError: 'DATABASE_QUERY_FAILED', startupError: 'synthetic-secret', recentErrors: ['synthetic-secret'],
  })
  assert.equal(checks.find(c => c.id === 'database').status, 'fail')
  assert.doesNotMatch(JSON.stringify(checks), /synthetic-secret/)
})

test('新版状态必须查询就绪才能完成后台启动', async () => {
  let launched = false, polls = 0
  const client = createApiClient({ startupTimeoutMs: 1000, pollIntervalMs: 1, readConfig: () => ({}), discover: () => 'fixture', launch: async () => { launched = true }, request: async api => {
    if (!launched) throw Object.assign(new Error('offline'), { code: 'YAN_UNREACHABLE' })
    if (api === '/api/health') return { status: 'ok' }
    if (api === '/api/status') return { connected: true, queryReady: ++polls >= 3 }
    return { synthetic: true }
  } })
  assert.deepEqual(await client('/api/messages'), { synthetic: true })
  assert.equal(polls, 3)
})

test('正常上游认证初始化结果有白名单分类，不泄露错误原文', () => {
  assert.equal(describeNativeResult({ guarded: true, initialized: true }).status, 'pass')
  const expired = describeNativeResult({ guarded: true, initialized: false, failure: 'LICENSE_EXPIRED', message: 'synthetic-secret' })
  assert.equal(expired.code, 'YAN_COMPONENT_AUTHORIZATION_FAILED')
  assert.doesNotMatch(JSON.stringify(expired), /synthetic-secret/)
  assert.equal(describeNativeResult({ guarded: true, initialized: false, failure: 'untrusted-secret' }).code, 'YAN_NATIVE_INIT_FAILED')
})
