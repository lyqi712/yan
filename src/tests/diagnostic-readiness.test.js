const { test } = require('node:test')
const assert = require('node:assert/strict')
const { checkService, summarizeReadiness } = require('../doctor')

test('离线诊断保留连接错误码，待启动不能冒充就绪', async () => {
  const checks = await checkService({}, async () => { throw Object.assign(new Error('offline'), { code: 'YAN_UNREACHABLE' }) })
  assert.equal(checks[0].code, 'YAN_UNREACHABLE')
  const result = summarizeReadiness(checks, { autoStart: true }, 'installed.exe')
  assert.equal(result.state, 'awaiting_auto_start')
  assert.equal(result.queryVerified, false)
  assert.match(result.nextStep, /list_sessions/)
})

test('关闭自动启动或HTTP故障不会被归为可自动启动', () => {
  const offline = [{ id: 'service', status: 'fail', code: 'YAN_UNREACHABLE' }]
  assert.equal(summarizeReadiness(offline, { autoStart: false }, 'installed.exe').state, 'offline')
  assert.equal(summarizeReadiness([{ id: 'service', status: 'fail', code: 'YAN_HTTP_ERROR' }], { autoStart: true }, 'installed.exe').state, 'service_error')
})

test('原生失败、数据库未就绪、旧版状态未知均保持显式边界', () => {
  assert.equal(summarizeReadiness([{ id: 'native', status: 'fail' }], {}, '').state, 'native_error')
  assert.equal(summarizeReadiness([{ id: 'database', status: 'fail' }], {}, '').state, 'database_not_ready')
  assert.equal(summarizeReadiness([{ id: 'database', status: 'optional' }], {}, '').state, 'query_unverified')
  const ready = summarizeReadiness([{ id: 'database', status: 'pass' }], {}, '')
  assert.equal(ready.state, 'query_ready')
  assert.equal(ready.queryVerified, false)
})
