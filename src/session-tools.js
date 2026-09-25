const { createHash } = require('node:crypto')
const { fetchMessageRange, buildSearchContextWindows, classifyAndSynthesize } = require('./record-pipeline')

const senderOf = m => String(m.senderId || m.sender_id || m.sender || '')
const referenceOf = m => ({ sessionId: String(m.sessionId || m.session_id || ''), localId: m.localId ?? null, serverId: m.serverId ?? null, timestamp: Number(m.timestamp || 0) })
const legacyIdentityOf = m => createHash('sha256').update(JSON.stringify([referenceOf(m), senderOf(m), String(m.content || '')])).digest('hex')
const previousStableIdentityOf = m => {
  const reference = referenceOf(m)
  const material = reference.localId !== null || Boolean(reference.serverId) ? [reference] : [reference, senderOf(m), String(m.content || '')]
  return createHash('sha256').update(JSON.stringify(material)).digest('hex')
}
const identityOf = m => {
  const reference = referenceOf(m)
  const material = reference.localId !== null && reference.localId !== ''
    ? [reference.sessionId, 'local', reference.localId]
    : reference.serverId
      ? [reference.sessionId, 'server', reference.serverId]
      : [reference, senderOf(m), String(m.content || '')]
  return createHash('sha256').update(JSON.stringify(material)).digest('hex')
}
const evidenceOf = m => ({ ...m, sourceRef: referenceOf(m), evidenceId: identityOf(m).slice(0, 20) })
function matches(m, params) {
  const text = String(m.content || '').toLocaleLowerCase()
  if (params.sender_ids?.length && !params.sender_ids.includes(senderOf(m))) return false
  if (params.keywords?.length) {
    const hits = params.keywords.map(word => text.includes(word.toLocaleLowerCase()))
    if (params.match_mode === 'all' ? !hits.every(Boolean) : !hits.some(Boolean)) return false
  }
  return true
}
function keywordHits(m, params) { return (params.keywords || []).filter(word => String(m.content || '').toLocaleLowerCase().includes(word.toLocaleLowerCase())) }
function validateRange(params) {
  if (params.start_time != null && params.end_time != null && params.start_time > params.end_time) throw new Error('开始时间不能晚于结束时间')
  if (new Set(params.session_ids).size !== params.session_ids.length) throw new Error('session_ids 存在重复，请先去重')
  if ((params.per_session_limit || 500) * params.session_ids.length > 10000) throw new Error('单次总读取上限为 10,000 条，请减少会话或 per_session_limit')
}
async function collectSessions(request, params) {
  validateRange(params)
  const sessions = [], errors = []
  let scanned = 0
  for (const id of params.session_ids) {
    try {
      const data = await fetchMessageRange(page => request('/api/messages', page), { session_id: id, limit: params.per_session_limit || 500, scan_limit: params.per_session_limit || 500, offset: params.offsets?.[id] || 0 })
      scanned += data.pagination.scanned
      const inTime = data.messages.filter(m => (!params.start_time || Number(m.timestamp) >= params.start_time) && (!params.end_time || Number(m.timestamp) <= params.end_time))
      const selected = inTime.filter(m => matches(m, params)).map(m => ({ ...evidenceOf(m), matchedKeywords: keywordHits(m, params) }))
      const context = params.context_before || params.context_after ? buildSearchContextWindows(data.messages, selected, params) : null
      sessions.push({ session: data.session || { id }, sessionId: id, messages: selected, returned: selected.length, pagination: data.pagination, ...(context ? { context } : {}) })
    } catch (error) { errors.push({ sessionId: id, error: error.message }) }
  }
  return { sessions, errors, totalReturned: sessions.reduce((sum, item) => sum + item.returned, 0), scanned, partial: errors.length > 0 || sessions.some(s => !s.pagination.complete), nextOffsets: Object.fromEntries(sessions.filter(s => !s.pagination.complete).map(s => [s.sessionId, s.pagination.nextOffset])), boundary: '各群分别扫描指定数量的原始消息后筛选。未命中仅代表已扫描窗口，不能推断整个历史没有；nextOffsets 可分别续读。昵称不参与身份匹配。' }
}
function buildSummaryPacket(collection, params = {}) {
  const all = collection.sessions.flatMap(s => s.messages)
  const people = new Map(), days = new Map(), types = new Map(), links = new Map()
  const timeZone = params.time_zone || 'Asia/Shanghai'
  let formatter
  try { formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }) } catch { throw new Error('time_zone 必须是有效 IANA 时区，例如 Asia/Shanghai') }
  for (const m of all) {
    const sender = senderOf(m)
    const person = people.get(sender) || { senderId: sender, names: new Set(), sessions: new Set(), messages: 0 }
    person.names.add(m.senderName || sender); person.sessions.add(m.sessionId); person.messages += 1; people.set(sender, person)
    const day = formatter.format(new Date(Number(m.timestamp || 0) * 1000)); days.set(day, (days.get(day) || 0) + 1)
    types.set(String(m.type ?? 'unknown'), (types.get(String(m.type ?? 'unknown')) || 0) + 1)
    for (const url of String(m.content || '').match(/https?:\/\/[^\s<>"']+/g) || []) {
      if (!links.has(url)) links.set(url, { url, sources: [] })
      if (links.get(url).sources.length < 20) links.get(url).sources.push(m.sourceRef)
    }
  }
  // Classify each session separately: localId alone is not unique across conversations.
  const candidates = collection.sessions.map(s => {
    const analysis = classifyAndSynthesize(s.messages)
    return { sessionId: s.sessionId, workRegister: analysis.workRegister, categories: analysis.categories, quality: analysis.quality, interpretation: '规则候选，需AI结合以下证据核验；不得把关键词匹配当已确认的决定、负责人或完成状态。' }
  })
  return { ...collection, purpose: params.focus || '综合总结', timeZone, statistics: { totalMessages: all.length, people: [...people.values()].map(p => ({ ...p, names: [...p.names], sessions: [...p.sessions] })).sort((a, b) => b.messages - a.messages), days: Object.fromEntries([...days].sort()), messageTypes: Object.fromEntries(types) }, resourceLinks: [...links.values()].slice(0, 200), candidateRegisters: candidates, summaryContract: { generatedBy: '请由调用本工具的AI基于返回证据撰写自然语言总结', requiredSections: ['范围与覆盖', '关键讨论', '决定与依据', '待办（负责人/期限缺失时留空）', '风险和不同意见', '未解决问题', '来源引用'], citation: '每个关键结论引用 sourceRef 的 sessionId + localId + timestamp；禁止跨群混用 localId。', limits: '不推断人物性格、私密属性或无法核验的意图；提问后出现回答不等于问题已解决。' } }
}
module.exports = { senderOf, referenceOf, identityOf, legacyIdentityOf, previousStableIdentityOf, evidenceOf, matches, keywordHits, collectSessions, buildSummaryPacket }
