const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { ROOT, readConfig } = require('./config')
const { contains, canonical } = require('./path-safety')
const { identityOf, evidenceOf, matches, keywordHits } = require('./session-tools')
const { unwrapMessages } = require('./record-pipeline')

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
const BOUNDARY = '按调用轮询，不自行常驻或发送通知。只覆盖指定会话的本地索引；依赖上游最新消息在前的顺序，索引延迟或历史回填不保证发现。首次建立当前窗口基线，不宣称历史全量。批次需读取完整并确认后才提交检查点。'
function createWatchStore(options = {}) {
  const root = path.resolve(options.root || path.join(ROOT, '.local', 'watchlists'))
  const config = options.config || (() => readConfig())
  function file(id) {
    if (!ID.test(id)) throw new Error('关注列表ID只能使用小写字母、数字、下划线或短横线，最多64字符')
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    const target = path.join(root, id + '.json')
    if (!contains(canonical(root), canonical(target))) throw new Error('关注列表路径越界')
    return target
  }
  function read(id) { const target = file(id); if (!fs.existsSync(target)) return null; if (fs.statSync(target).size > 64 * 1024 * 1024) throw new Error('关注列表文件过大'); return JSON.parse(fs.readFileSync(target, 'utf8')) }
  function save(id, data) { const serialized = JSON.stringify(data); if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) throw new Error('本轮批次超过16MB，未保存或推进进度。请降低per_session_limit后重试。'); const target = file(id), temporary = target + '.' + randomUUID() + '.tmp'; fs.writeFileSync(temporary, serialized, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, target) }
  async function locked(id, action) {
    const lock = file(id) + '.lock'
    let fd
    try { fd = fs.openSync(lock, 'wx', 0o600) } catch (error) { if (error.code === 'EEXIST') throw new Error('此关注列表正在被另一个客户端处理。若进程曾异常退出，请关闭所有眼进程后按文档移除对应.lock文件。'); throw error }
    try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); return await action() }
    finally { fs.closeSync(fd); fs.unlinkSync(lock) }
  }
  function publicInfo(state) { return { id: state.id, name: state.name, sessionIds: state.sessionIds, keywords: state.keywords, senderIds: state.senderIds, matchMode: state.matchMode, paused: state.paused, createdAt: state.createdAt, updatedAt: state.updatedAt, pendingBatchId: state.pending?.id || null, checkpointCount: Object.keys(state.checkpoints).length, boundary: BOUNDARY } }
  function sourceIdentity() { const cfg = config(); return JSON.stringify([cfg.baseUrl, cfg.accountDir]) }
  function viewBatch(state, offset = 0, limit = 500) {
    const batch = state.pending
    if (!batch) throw new Error('没有待确认批次，请先运行 poll_watchlist')
    if (offset > batch.servedThrough) throw new Error('请按 nextOffset 顺序读取批次，避免跳过消息')
    const rows = batch.messages.slice(offset, offset + limit)
    batch.servedThrough = Math.max(batch.servedThrough, offset + rows.length)
    return { watchlistId: state.id, batchId: batch.id, createdAt: batch.createdAt, groups: batch.groups, messages: rows, delivery: { offset, returned: rows.length, total: batch.messages.length, nextOffset: offset + rows.length, complete: offset + rows.length >= batch.messages.length, acknowledged: false }, partial: batch.groups.some(g => ['error', 'backlog', 'order-unverified', 'identity-unavailable', 'catching-up', 'baseline-building'].includes(g.status)), instruction: '继续读取所有分页并完成用户要求的整理后，再调用 ack_watchlist_batch。重复poll会返回同一批次，避免响应丢失后漏消息。', boundary: BOUNDARY }
  }
  return {
    configure: params => locked(params.id, async () => {
      const previous = read(params.id)
      if (previous?.pending) throw new Error('有待确认批次，请先读取并确认该批次，再修改关注列表')
      if (previous && params.replace !== true) throw new Error('列表已存在；修改时显式提供 replace=true')
      if (!params.session_ids?.length || new Set(params.session_ids).size !== params.session_ids.length) throw new Error('请提供不重复的会话ID')
      const state = { schemaVersion: 1, id: params.id, name: params.name || params.id, sessionIds: params.session_ids, keywords: params.keywords || [], senderIds: params.sender_ids || [], matchMode: params.match_mode || 'any', paused: params.paused || false, source: sourceIdentity(), checkpoints: previous?.checkpoints || {}, createdAt: previous?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), pending: null, progress: {} }
      // Configuration edits create a fresh matching baseline: no silent retroactive claims.
      if (previous) state.checkpoints = {}
      save(params.id, state); return { ...publicInfo(state), baselineReset: Boolean(previous) }
    }),
    list: () => {
      if (!fs.existsSync(root)) return { watchlists: [] }
      const items = fs.readdirSync(root).filter(name => /^[a-z0-9][a-z0-9_-]{0,63}\.json$/.test(name)).slice(0, 100)
      return { watchlists: items.map(name => publicInfo(read(name.slice(0, -5)))), boundary: BOUNDARY }
    },
    poll: (params, request) => locked(params.id, async () => {
      const state = read(params.id); if (!state) throw new Error('关注列表不存在')
      if (state.pending) { const response = viewBatch(state, 0, params.delivery_limit || 500); save(state.id, state); return response }
      if (state.paused) return { watchlistId: state.id, paused: true, messages: [], boundary: BOUNDARY }
      if (state.source !== sourceIdentity()) throw new Error('上游服务或账号配置已变化；请显式重新配置此关注列表建立新基线')
      const perSession = params.per_session_limit ?? 1000
      if (!Number.isInteger(perSession) || perSession < 2 || perSession > 5000) throw new Error('per_session_limit必须为2–5000；至少保留一条续扫进度预算')
      if (perSession * state.sessionIds.length > 20000) throw new Error('本轮扫描预算最多20,000条，请减少每群扫描量')
      const batch = { id: randomUUID(), createdAt: new Date().toISOString(), messages: [], groups: [], checkpoints: {}, progress: {}, servedThrough: 0 }
      for (const sessionId of state.sessionIds) {
        try {
          const prior = state.checkpoints[sessionId]
          const priorProgress = state.progress?.[sessionId]
          const progress = priorProgress ? structuredClone(priorProgress) : { head: null, tail: null, offset: 0, seen: [], headSeen: [], initial: !prior, includeInitial: Boolean(params.include_initial) }
          const alreadySeen = new Set([...(prior?.seen || []), ...progress.seen])
          const pageSeen = new Set(), collected = []
          let offset = Math.max(0, progress.offset - (progress.tail ? Math.min(100, Math.max(1, Math.floor(perSession / 4))) : 0)), scanned = 0, exhausted = false, finished = false, tailFound = !progress.tail, lastTime = Infinity
          const baselineTime = prior?.timestamp ?? null
          while (scanned < perSession && !finished) {
            const count = Math.min(100, perSession - scanned)
            const page = unwrapMessages(await request('/api/messages', { session_id: sessionId, limit: count, offset }))
            if (!page.messages.length) { exhausted = true; finished = true; break }
            let consumed = 0, uniqueCount = 0
            for (const raw of page.messages.slice(0, count)) {
              const m = { ...raw, sessionId }, timestamp = Number(m.timestamp || 0)
              if (!Number.isFinite(timestamp) || timestamp < 0 || (m.localId == null && m.serverId == null)) throw new Error('上游消息缺少稳定ID或有效时间戳')
              if (timestamp > lastTime) throw new Error('上游时间顺序不是倒序，未推进该群进度')
              lastTime = timestamp
              const key = identityOf(m)
              consumed += 1; scanned += 1
              if (pageSeen.has(key)) continue
              pageSeen.add(key); uniqueCount += 1
              if (!tailFound) { if (key === progress.tail) tailFound = true; continue }
              if (!progress.head) progress.head = { anchor: key, timestamp }
              // Complete the whole checkpoint second; localId order within a second is not assumed.
              const stopTime = prior ? baselineTime : progress.includeInitial ? 0 : progress.head.timestamp
              if (timestamp < stopTime) { finished = true; break }
              if (timestamp === progress.head.timestamp) progress.headSeen.push(key)
              progress.tail = key; progress.offset = offset + consumed
              if (!alreadySeen.has(key)) {
                progress.seen.push(key); alreadySeen.add(key)
                if (prior || progress.includeInitial) collected.push(m)
              }
            }
            offset += consumed
            if (!uniqueCount && consumed) throw new Error('上游分页重复，未推进该群进度')
            if (page.messages.length < count) { exhausted = true; finished = true }
          }
          if (!tailFound) throw new Error('续扫锚点未找到，可能有大量新增或索引变化；本群保持原进度，请提高扫描预算后重试')
          if (alreadySeen.size > 50000) throw new Error('单轮追赶超过50,000条，请缩小关注范围或显式重建基线')
          const selected = collected.filter(m => matches(m, { sender_ids: state.senderIds, keywords: state.keywords, match_mode: state.matchMode }))
          batch.messages.push(...selected.map(m => ({ sourceRef: evidenceOf(m).sourceRef, evidenceId: identityOf(m).slice(0, 20), sessionId, localId: m.localId, serverId: m.serverId, timestamp: Number(m.timestamp), senderId: String(m.senderId || m.sender_id || m.sender || '').slice(0, 512), senderName: String(m.senderName || '').slice(0, 512), type: m.type, content: String(m.content || '').slice(0, 2000), contentTruncated: String(m.content || '').length > 2000, matchedKeywords: keywordHits(m, { keywords: state.keywords }) })))
          if (finished) {
            batch.checkpoints[sessionId] = progress.head ? { ...progress.head, seen: [...new Set(progress.headSeen)] } : prior || { anchor: null, timestamp: 0, seen: [] }
            batch.progress[sessionId] = null
          } else batch.progress[sessionId] = progress
          batch.groups.push({ sessionId, status: finished ? (prior ? 'checked' : 'baseline') : (prior ? 'catching-up' : 'baseline-building'), scanned, newMessages: collected.length, matchedMessages: selected.length, initialHistoryEmitted: !prior && progress.includeInitial, historyComplete: exhausted, continuationOffset: finished ? null : progress.offset, message: finished ? '' : '本轮已交付的分页确认后，将保存续扫位置；下次poll继续追赶。确认游标在覆盖旧边界后才提交。' })
        } catch (error) { batch.groups.push({ sessionId, status: 'error', error: error.message }) }
      }
      batch.messages.sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
      state.pending = batch
      const response = viewBatch(state, 0, params.delivery_limit || 500)
      save(state.id, state); return response
    }),
    readBatch: params => locked(params.id, async () => { const state = read(params.id); if (!state?.pending || state.pending.id !== params.batch_id) throw new Error('批次不存在或已确认'); const response = viewBatch(state, params.offset || 0, params.limit || 500); save(state.id, state); return response }),
    acknowledge: params => locked(params.id, async () => {
      const state = read(params.id); if (!state) throw new Error('关注列表不存在')
      if (state.lastAcknowledged === params.batch_id) return { acknowledged: true, alreadyAcknowledged: true, batchId: params.batch_id }
      if (!state.pending || state.pending.id !== params.batch_id) throw new Error('批次不匹配')
      if (state.pending.servedThrough < state.pending.messages.length) throw new Error('批次仍有未读取分页；请按 nextOffset 读取完整后确认')
      Object.assign(state.checkpoints, state.pending.checkpoints)
      state.progress ||= {}
      for (const [id, progress] of Object.entries(state.pending.progress || {})) { if (progress) state.progress[id] = progress; else delete state.progress[id] }
      state.lastAcknowledged = state.pending.id; state.pending = null; state.updatedAt = new Date().toISOString()
      save(state.id, state); return { acknowledged: true, batchId: params.batch_id, checkpointCount: Object.keys(state.checkpoints).length }
    }),
  }
}
module.exports = { createWatchStore, BOUNDARY }
