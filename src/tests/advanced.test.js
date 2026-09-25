const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createWatchStore } = require('../watchlists')
const { collectSessions, buildSummaryPacket } = require('../session-tools')
const { buildIncrementalWindow, classifyAndSynthesize } = require('../record-pipeline')
const { identityOf, legacyIdentityOf, previousStableIdentityOf } = require('../session-tools')
function row(id, sender = 'a', timestamp = id, content = `方案${id}`) { return { localId: id, senderId: sender, senderName: '重名', timestamp, content, type: 1 } }
test('稳定消息ID使压缩表示变化不产生新的关注身份', () => {
  const encoded = { sessionId: 'g', localId: 7, serverId: 'server-7', timestamp: 70, senderId: 'a', content: '28b52ffddeadbeef' }
  const decoded = { ...encoded, content: '已解码正文🙂' }
  assert.equal(identityOf(encoded), identityOf(decoded))
  assert.equal(identityOf(encoded), identityOf({ ...encoded, timestamp: 71 }))
  assert.notEqual(legacyIdentityOf(encoded), legacyIdentityOf(decoded))
})
test('旧版带时间戳身份键仍被关注列表兼容', () => {
  const encoded = { sessionId: 'g', localId: 7, serverId: 'server-7', timestamp: 70, senderId: 'a', content: 'encoded' }
  const moved = { ...encoded, timestamp: 71 }
  assert.notEqual(previousStableIdentityOf(encoded), previousStableIdentityOf(moved))
  assert.equal(identityOf(encoded), identityOf(moved))
})
function setup(t, groups) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yan-watch-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = createWatchStore({ root, config: () => ({ baseUrl: 'http://127.0.0.1:1', accountDir: 'synthetic' }) })
  const request = async (_api, p) => { if (groups[p.session_id] instanceof Error) throw groups[p.session_id]; return { messages: (groups[p.session_id] || []).slice(p.offset || 0, (p.offset || 0) + p.limit) } }
  return { store, request }
}
test('按ID跨群精确提取、同名分离、失败群明确partial、上下文保持来源', async t => {
  const { request } = setup(t, { g1: [row(2, 'b'), row(1, 'a')], g2: [row(1, 'a')], g3: new Error('故障样本') })
  const result = await collectSessions(request, { session_ids: ['g1', 'g2', 'g3'], sender_ids: ['a'], context_after: 1 })
  assert.equal(result.totalReturned, 2); assert.equal(result.partial, true); assert.equal(result.errors[0].sessionId, 'g3')
  assert.notEqual(result.sessions[0].messages[0].evidenceId, result.sessions[1].messages[0].evidenceId)
  assert.equal(result.sessions[0].context.windows[0].messages[1].senderId, 'b')
  const packet = buildSummaryPacket(result, { focus: '人物发言' })
  assert.equal(packet.statistics.people.length, 1); assert.equal(packet.candidateRegisters.length, 2)
})
test('总结拒绝反向日期，时区校验，分页无命中不能报告全量', async t => {
  const { request } = setup(t, { g: [row(3), row(2), row(1)] })
  await assert.rejects(collectSessions(request, { session_ids: ['g'], start_time: 2, end_time: 1 }), /时间/)
  const result = await collectSessions(request, { session_ids: ['g'], per_session_limit: 1, keywords: ['缺失'] })
  assert.equal(result.totalReturned, 0); assert.equal(result.partial, true); assert.equal(result.nextOffsets.g, 1)
  assert.throws(() => buildSummaryPacket(result, { time_zone: 'bad/zone' }), /时区/)
})
test('增量积压未完整时不得推进确认游标', () => {
  const result = buildIncrementalWindow([row(8), row(7), row(6)], { after_timestamp: 2, after_local_id: 2, pagination: { complete: false, nextOffset: 3 } })
  assert.equal(result.incremental.nextCursor.localId, 2); assert.equal(result.incremental.observedLatestCursor.localId, 8); assert.equal(result.incremental.backlog, true)
})
test('关注批次支持重试、连续分页、全部读取后确认及同秒新增', async t => {
  const groups = { g: [row(1, 'a', 100)] }, { store, request } = setup(t, groups)
  await store.configure({ id: 'work', session_ids: ['g'] })
  const baseline = await store.poll({ id: 'work' }, request)
  assert.equal(baseline.messages.length, 0); await store.acknowledge({ id: 'work', batch_id: baseline.batchId })
  groups.g.unshift(row(3, 'a', 100), row(2, 'a', 100))
  const batch = await store.poll({ id: 'work', delivery_limit: 1 }, request)
  assert.equal(batch.delivery.total, 2)
  const again = await store.poll({ id: 'work', delivery_limit: 1 }, request)
  assert.equal(again.batchId, batch.batchId)
  await assert.rejects(store.acknowledge({ id: 'work', batch_id: batch.batchId }), /分页/)
  await assert.rejects(store.readBatch({ id: 'work', batch_id: batch.batchId, offset: 2 }), /顺序/)
  await store.readBatch({ id: 'work', batch_id: batch.batchId, offset: 1 })
  await store.acknowledge({ id: 'work', batch_id: batch.batchId })
  assert.equal((await store.acknowledge({ id: 'work', batch_id: batch.batchId })).alreadyAcknowledged, true)
  assert.equal((await store.poll({ id: 'work' }, request)).messages.length, 0)
})
test('单群故障和积压不提交该群检查点，下一轮可以补齐', async t => {
  const groups = { g: [row(1)], bad: new Error('离线') }, { store, request } = setup(t, groups)
  await store.configure({ id: 'work', session_ids: ['g', 'bad'] })
  let batch = await store.poll({ id: 'work' }, request); assert.equal(batch.partial, true)
  await store.acknowledge({ id: 'work', batch_id: batch.batchId })
  groups.g = [row(4), row(3), row(2), row(1)]
  batch = await store.poll({ id: 'work', per_session_limit: 2 }, request)
  assert.equal(batch.groups[0].status, 'catching-up'); await store.acknowledge({ id: 'work', batch_id: batch.batchId })
  batch = await store.poll({ id: 'work', per_session_limit: 10 }, request)
  assert.equal(batch.groups[0].status, 'checked'); assert.equal(batch.messages.length, 1)
})
test('空群基线以后第一条新消息不能被静默跳过', async t => {
  const groups = { g: [] }, { store, request } = setup(t, groups)
  await store.configure({ id: 'work', session_ids: ['g'] })
  const batch = await store.poll({ id: 'work' }, request); await store.acknowledge({ id: 'work', batch_id: batch.batchId })
  groups.g.push(row(1)); assert.equal((await store.poll({ id: 'work' }, request)).messages.length, 1)
})
test('并发客户端锁住同一个列表，路径不能越界', async t => {
  const { store } = setup(t, {})
  await assert.rejects(store.configure({ id: '../bad', session_ids: ['g'] }), /ID/)
  await store.configure({ id: 'work', session_ids: ['g'] })
  let release
  const running = store.poll({ id: 'work' }, () => new Promise(resolve => { release = resolve }))
  await assert.rejects(store.poll({ id: 'work' }, async () => []), /另一个客户端/)
  release([]); await running
})
test('同秒锚点后一整页仍会读取，不依赖localId倒序', async t => {
  const groups = { g: Array.from({ length: 100 }, (_, i) => row(i + 1, 'a', 100)) }, { store, request } = setup(t, groups)
  await store.configure({ id: 'work', session_ids: ['g'] })
  let batch = await store.poll({ id: 'work' }, request); await store.acknowledge({ id: 'work', batch_id: batch.batchId })
  groups.g.push(row(101, 'a', 100))
  batch = await store.poll({ id: 'work' }, request); assert.deepEqual(batch.messages.map(m => m.localId), [101]); await store.acknowledge({ id: 'work', batch_id: batch.batchId })
  assert.equal((await store.poll({ id: 'work' }, request)).messages.length, 0)
})
test('小窗口基线扩大后，旧消息不能误报为新增', async t => {
  const groups = { g: [row(3), row(2), row(1)] }, { store, request } = setup(t, groups)
  await store.configure({ id: 'work', session_ids: ['g'] })
  let batch = await store.poll({ id: 'work', per_session_limit: 2 }, request); await store.acknowledge({ id: 'work', batch_id: batch.batchId })
  batch = await store.poll({ id: 'work' }, request); assert.equal(batch.messages.length, 0); await store.acknowledge({ id: 'work', batch_id: batch.batchId })
  batch = await store.poll({ id: 'work' }, request); assert.equal(batch.messages.length, 0)
})
test('超过5000条积压可以跨批追赶，追赶期间新增在下一轮补齐', async t => {
  const groups = { g: [row(1)] }, { store, request } = setup(t, groups)
  await store.configure({ id: 'work', session_ids: ['g'] })
  let batch = await store.poll({ id: 'work' }, request); await store.acknowledge({ id: 'work', batch_id: batch.batchId })
  groups.g = Array.from({ length: 5102 }, (_, i) => row(5102 - i))
  const found = new Set()
  for (let round = 0; round < 6; round += 1) {
    batch = await store.poll({ id: 'work', per_session_limit: 5000 }, request)
    for (const m of batch.messages) found.add(m.localId)
    while (!batch.delivery.complete) { batch = await store.readBatch({ id: 'work', batch_id: batch.batchId, offset: batch.delivery.nextOffset }); for (const m of batch.messages) found.add(m.localId) }
    await store.acknowledge({ id: 'work', batch_id: batch.batchId })
    if (round === 0) groups.g.unshift(row(5103))
  }
  assert.equal(found.size, 5102); assert.equal(found.has(1), false); assert.equal(found.has(5103), true)
})
test('超长中文正文在关注批次与重读分页中保持原文且明确长度', async t => {
  const content = '开始🙂甲乙丙'.repeat(1200) + '结尾-END'
  const groups = { g: [row(2, 'a', 2, content), row(1, 'a', 1)] }, { store, request } = setup(t, groups)
  await store.configure({ id: 'work', session_ids: ['g'] })
  const batch = await store.poll({ id: 'work', include_initial: true, per_session_limit: 10, delivery_limit: 1 }, request)
  assert.equal(batch.delivery.total, 2)
  const nextPage = await store.readBatch({ id: 'work', batch_id: batch.batchId, offset: 1, limit: 1 })
  const message = nextPage.messages[0]
  assert.equal(message.content, content)
  assert.equal(message.contentTruncated, false)
  assert.equal(message.contentChars, Array.from(content).length)
  assert.equal(message.contentBytes, Buffer.byteLength(content, 'utf8'))
  await store.acknowledge({ id: 'work', batch_id: batch.batchId })
})
test('分析结果保留长消息原文，摘录截断显式标记', () => {
  const content = '这是需要保留的完整长正文。'.repeat(80)
  const synthesis = classifyAndSynthesize([row(1, 'a', 1, content), row(2, 'a', 2, content)])
  assert.equal(synthesis.selectedMessages[0].content, content)
  assert.equal(synthesis.noiseMessages[0].excerptTruncated, true)
})
test('关注批次保留上游的truncated标记，不把部分正文当完整', async t => {
  const groups = { g: [{ ...row(1, 'a', 1, '部分正文'), truncated: true, originalLength: 200 }] }
  const { store, request } = setup(t, groups)
  await store.configure({ id: 'truncated', session_ids: ['g'] })
  const batch = await store.poll({ id: 'truncated', include_initial: true }, request)
  assert.equal(batch.messages[0].contentTruncated, true)
  assert.equal(batch.messages[0].contentComplete, false)
  assert.equal(batch.groups[0].contentComplete, false)
  assert.equal(batch.partial, true)
  assert.equal(batch.messages[0].contentOriginalLength, 200)
})
test('超大批次在保存前拒绝，列表仍可读取并降低预算重试', async t => {
  const groups = Object.fromEntries(['a','b','c'].map(id => [id, Array.from({ length: 1000 }, (_, i) => row(1000-i, 'a', 1000-i, '文'.repeat(8000)))])), { store, request } = setup(t, groups)
  await store.configure({ id: 'work', session_ids: ['a','b','c'] })
  await assert.rejects(store.poll({ id: 'work', per_session_limit: 1000, include_initial: true }, request), /16MB/)
  assert.equal(store.list().watchlists[0].pendingBatchId, null)
  const batch = await store.poll({ id: 'work', per_session_limit: 100, include_initial: true }, request)
  assert.equal(batch.messages.length, 300); assert.equal(batch.messages[0].contentTruncated, false); assert.equal(batch.messages[0].contentChars, 8000)
  await store.acknowledge({ id: 'work', batch_id: batch.batchId })
})
