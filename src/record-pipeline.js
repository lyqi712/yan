const path = require('path')
const { randomUUID } = require('node:crypto')
const { zstdDecompressSync } = require('node:zlib')
const { ownedOutput } = require('./path-safety')
const MAX_DECODED_TEXT_BYTES = 8 * 1024 * 1024

const CATEGORY_RULES = [
  { id: 'content-growth', name: '内容、自媒体与增长', keywords: ['小红书','公众号','抖音','视频号','选题','标题','内容','流量','涨粉','引流','矩阵','爆款'] },
  { id: 'business-conversion', name: '商业、成交与私域', keywords: ['客户','成交','报价','复购','私域','销售','商业','变现','GMV','交付','信任','社群'] },
  { id: 'agent-tooling', name: 'Agent、Skill 与自动化', keywords: ['Agent','agent','Skill','skill','Claude','Codex','提示词','Prompt','自动化','工作流','MCP','Hermes'] },
  { id: 'learning-career', name: '学习、校园与职业发展', keywords: ['大学','校园','学习','考试','求职','就业','面试','高考','专业','课程','训练营'] },
  { id: 'product-operations', name: '产品、运营与项目执行', keywords: ['产品','需求','用户','运营','项目','MVP','迭代','测试','复盘','SOP','模板','清单'] },
  { id: 'technology-research', name: '技术、AI 与研究', keywords: ['AI','模型','代码','开发','技术','研究','架构','数据','开源','API','部署'] },
]
const RISK_TERMS = ['风险','失败','不要','避免','成本','封号','投诉','违规','坑','错误','警告','亏','隐私']
const ACTION_TERMS = ['模板','SOP','清单','教程','课程','工具','脚本','方案','案例','流程','任务','方法','步骤','资料包']
const MESSAGE_LABEL_RULES = [
  { id: 'question', test: text => /[?？]/.test(text) || /(?:吗|嘛|么|呢|呀|啊|没)$/u.test(text.trim()) || /(怎么|怎么样|咋|如何|为什么|为啥|是否|能否|可不可以|有没有|有谁|谁知道|有啥|什么|哪(?:个|里|些)?|那个|多少)/.test(text) },
  { id: 'answer-or-explanation', test: text => /^(没有|有|能|不能|可以|不可以|是|不是|对|不对|正常|不正常|凑合)/.test(text) || /(可以|因为|所以|其实|就是|包含|意味着|原因|建议|我觉得|肯定|需要|正常用|看技术|取决于|按小时|按月|月工资|一个月|日薪|时薪|还没入职)/.test(text) && text.length >= 6 },
  { id: 'action-plan', test: text => /(先|再|然后|接下来|后面|到时候|计划|安排|准备|步骤|执行|推进|运营|拉进来|规划|设计)/.test(text) },
  { id: 'decision', test: text => /(决定|确定|就按|优先|必须|不要|先做|后续收费|首期免费|定个方向)/.test(text) },
  { id: 'risk-or-problem', test: text => /(问题|风险|失败|错误|报错|成本|不太清楚|超时|投诉|违规|封号|避免)/.test(text) },
  { id: 'evidence-or-result', test: text => /(测试|验证|结果|达到|数据|\d+(?:\.\d+)?%|\d+分|通过|失败)/.test(text) },
  { id: 'resource-or-attachment', test: text => /https?:\/\//i.test(text) || /(文件|附件|图片|视频|文档|链接|资料|工具包|知识库)/.test(text) },
  { id: 'business-model', test: text => /(付费|收费|免费|分销|会员|成交|报价|变现|销售|复购|KOL|很好卖)/i.test(text) },
  { id: 'community-operations', test: text => /(社群|群运营|拉人|拉进来|积分|共享知识库|内容库|主题分享)/.test(text) },
  { id: 'content-production', test: text => /(直播|内容|海报|表情包|起号|选题|宣传词|课程|原创IP)/i.test(text) },
]
const RESOLUTION_LABELS = new Set(['action-plan','decision','evidence-or-result'])

function isZstdHex(value) {
  const compact = String(value || '').replace(/\s+/g, '')
  return /^28b52ffd[0-9a-f]*$/i.test(compact) && compact.length >= 8
}
function isTrueFlag(value) {
  return value === true || value === 1 || (typeof value === 'string' && value.trim().toLowerCase() === 'true')
}
function sourceReportedContentTruncated(message) {
  return ['contentTruncated', 'content_truncated', 'truncated', 'rawContentTruncated'].some(key => isTrueFlag(message?.[key]))
}
function contentIntegrityOf(message) {
  const content = message?.content == null ? '' : String(message.content)
  const originalLength = Number(message?.originalLength)
  const observedLength = Number.isFinite(Number(message?.storedContentLength)) ? Number(message.storedContentLength) : content.length
  const lengthMismatch = Number.isFinite(originalLength) && originalLength >= 0 && originalLength > observedLength
  const undecoded = Boolean(message?.contentUndecoded) || isZstdHex(content)
  const sourceReportedTruncated = sourceReportedContentTruncated(message)
  const readable = !undecoded
  return {
    characters: Array.from(content).length,
    utf8Bytes: Buffer.byteLength(content, 'utf8'),
    sourceReportedTruncated,
    lengthMismatch,
    contentDecoded: message?.contentDecoded || (undecoded ? 'encoded' : 'plain'),
    contentUndecoded: undecoded,
    readable,
    complete: readable && !sourceReportedTruncated && !lengthMismatch,
  }
}
function summarizeContentIntegrity(messages) {
  const rows = (messages || []).map(contentIntegrityOf)
  const sourceReportedTruncated = rows.filter(row => row.sourceReportedTruncated).length
  const undecoded = rows.filter(row => row.contentUndecoded).length
  const lengthMismatch = rows.filter(row => row.lengthMismatch).length
  return {
    returnedMessages: rows.length,
    complete: rows.every(row => row.complete),
    sourceReportedTruncated,
    undecoded,
    lengthMismatch,
    warning: sourceReportedTruncated || undecoded || lengthMismatch ? '部分消息正文由上游截断、未解码或长度不一致；当前结果不能当作全部正文完整。' : '',
  }
}
function decodeStoredMessage(message) {
  if (!message || typeof message !== 'object') return message
  const content = message.content == null ? '' : String(message.content)
  const compact = content.replace(/\s+/g, '')
  if (!isZstdHex(compact)) return message
  if (compact.length % 2 !== 0) return { ...message, storedContentLength: compact.length, contentDecoded: 'zstd-failed', contentUndecoded: true, contentUndecodedReason: 'odd-hex' }
  if (typeof zstdDecompressSync !== 'function') return { ...message, storedContentLength: compact.length, contentDecoded: 'zstd-unavailable', contentUndecoded: true }
  let raw
  try { raw = zstdDecompressSync(Buffer.from(compact, 'hex')) } catch { return { ...message, storedContentLength: compact.length, contentDecoded: 'zstd-failed', contentUndecoded: true } }
  if (raw.length === 0) return { ...message, storedContentLength: compact.length, contentDecoded: 'zstd-empty', contentUndecoded: true, contentUndecodedReason: sourceReportedContentTruncated(message) ? 'source-truncated' : 'empty-decoded-payload' }
  if (raw.length > MAX_DECODED_TEXT_BYTES) return { ...message, storedContentLength: compact.length, contentDecoded: 'zstd-too-large', contentUndecoded: true }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
    return { ...message, storedContentLength: compact.length, content: text, contentDecoded: 'zstd', contentUndecoded: false }
  } catch { return { ...message, storedContentLength: compact.length, contentDecoded: 'zstd-not-utf8', contentUndecoded: true } }
}
function unwrapMessages(data) {
  const messages = Array.isArray(data) ? data : (Array.isArray(data?.messages) ? data.messages : [])
  return { messages: messages.map(decodeStoredMessage), session: Array.isArray(data) ? null : (data?.session || null) }
}
function isStrongContentSource(message) {
  return ['exact-message', 'session-message'].includes(String(message?.contentSource || ''))
}
function chooseContentVariant(hit, source) {
  const hitIntegrity = contentIntegrityOf(hit)
  const sourceIntegrity = contentIntegrityOf(source)
  if (sourceIntegrity.complete && (!hitIntegrity.complete || !isStrongContentSource(hit) || isStrongContentSource(source))) return { message: source, integrity: sourceIntegrity }
  if (hitIntegrity.complete) return { message: hit, integrity: hitIntegrity }
  if (sourceIntegrity.readable) return { message: source, integrity: sourceIntegrity }
  return { message: hit, integrity: hitIntegrity }
}
function mergeSearchHit(hit, source) {
  if (!source) return hit
  const chosen = chooseContentVariant(hit, source)
  const selected = chosen.message
  const senderId = String(source.senderId || source.sender_id || '') || String(hit.senderId || hit.sender_id || '')
  const sourceType = Number(source.type)
  const hitType = Number(hit.type)
  const type = sourceType > 0 ? sourceType : (hitType > 0 ? hitType : hit.type)
  const merged = {
    ...hit,
    ...source,
    content: selected.content,
    sender: senderId ? (source.sender || hit.sender || senderId) : (hit.sender || ''),
    senderId,
    senderName: senderId ? (source.senderName || hit.senderName || '') : (hit.senderName || ''),
    type,
    typeName: sourceType > 0 ? (source.typeName || hit.typeName) : hit.typeName,
    isSend: senderId ? (source.isSend ?? hit.isSend) : hit.isSend,
    isSelf: senderId ? Boolean(source.isSelf ?? hit.isSelf) : Boolean(hit.isSelf),
    nameResolved: senderId ? Boolean(source.nameResolved ?? hit.nameResolved) : Boolean(hit.nameResolved),
    serverId: source.serverId || hit.serverId || '',
    contentDecoded: selected.contentDecoded || (selected === source ? source.contentDecoded : hit.contentDecoded),
    contentUndecoded: Boolean(selected.contentUndecoded),
    contentSource: selected.contentSource || (selected === source ? 'session-message' : 'search-index'),
    contentIntegrity: chosen.integrity,
  }
  for (const field of ['truncated', 'contentTruncated', 'content_truncated', 'rawContentTruncated', 'originalLength', 'storedContentLength']) {
    if (selected[field] !== undefined) merged[field] = selected[field]
    else delete merged[field]
  }
  return merged
}
function searchHitNeedsHydration(message) {
  const senderId = String(message?.senderId || message?.sender_id || '')
  const type = Number(message?.type)
  const identityIncomplete = !senderId || !Number.isFinite(type) || type === 0
  const integrity = contentIntegrityOf(message)
  return identityIncomplete || !integrity.complete || Boolean(message?.contentUndecoded) || message?.contentDecoded === 'zstd' || isZstdHex(message?.content)
}
function identityCompleteOf(message) {
  const senderId = String(message?.senderId || message?.sender_id || message?.sender || '')
  const type = Number(message?.type)
  return Boolean(senderId) && Number.isFinite(type) && type !== 0
}
function annotateSearchHits(messages, source = 'search-index', statuses = new Map(), fallbackSession = '') {
  return (messages || []).map(message => {
    const sessionId = String(message.sessionId || message.session_id || fallbackSession || '')
    const key = `${sessionId}:${Number(message.localId)}`
    const needsHydration = searchHitNeedsHydration(message) || !identityCompleteOf(message)
    const hydration = statuses.get(key) || message.hydrationStatus || (needsHydration
      ? { attempted: false, found: false, complete: false, partial: true, reason: 'hydration-required' }
      : { attempted: false, found: true, complete: true, partial: false, reason: 'not-needed' })
    const contentIntegrity = contentIntegrityOf(message)
    return { ...message, sessionId: message.sessionId || message.session_id || fallbackSession || undefined, contentSource: message.contentSource || source, contentIntegrity, contentComplete: contentIntegrity.complete, identityComplete: identityCompleteOf(message), hydrationStatus: hydration }
  })
}
async function hydrateSearchHits(fetchPage, hits, options = {}) {
  const decodedHits = (hits || []).map(decodeStoredMessage)
  const statuses = new Map()
  if (!decodedHits.some(searchHitNeedsHydration) || typeof fetchPage !== 'function') return annotateSearchHits(decodedHits, 'search-index', statuses, options.session_id)
  const scanLimit = Math.min(Math.max(Number(options.scan_limit) || 2000, 1), 20000)
  const bySession = new Map()
  for (const hit of decodedHits) {
    if (!searchHitNeedsHydration(hit)) continue
    const sessionId = String(hit.sessionId || hit.session_id || options.session_id || '')
    if (!sessionId || hit.localId == null) continue
    if (!bySession.has(sessionId)) bySession.set(sessionId, new Set())
    bySession.get(sessionId).add(Number(hit.localId))
  }
  const sources = new Map()
  for (const [sessionId, ids] of bySession) {
    let offset = 0, scanned = 0, stopReason = 'scan-limit', fetchError = ''
    try {
      while (ids.size && scanned < scanLimit) {
        const requestSize = Math.min(100, scanLimit - scanned)
        const page = unwrapMessages(await fetchPage({ session_id: sessionId, limit: requestSize, offset }))
        if (!page.messages.length) { stopReason = 'exhausted'; break }
        let consumed = 0
        for (const message of page.messages) {
          if (scanned >= scanLimit) break
          scanned += 1; consumed += 1
          const localId = Number(message.localId)
          if (!ids.has(localId)) continue
          const source = { ...message, sessionId: message.sessionId || sessionId, contentSource: 'session-message' }
          sources.set(`${sessionId}:${localId}`, source)
          ids.delete(localId)
          const sourceIntegrity = contentIntegrityOf(source)
          const sourceIdentityComplete = identityCompleteOf(source)
          statuses.set(`${sessionId}:${localId}`, { attempted: true, found: true, complete: sourceIntegrity.complete && sourceIdentityComplete, partial: !(sourceIntegrity.complete && sourceIdentityComplete), lookupComplete: true, contentComplete: sourceIntegrity.complete, identityComplete: sourceIdentityComplete, scanned, nextOffset: offset + consumed, stopReason: 'found' })
        }
        offset += consumed
        if (page.messages.length < requestSize) { stopReason = 'exhausted'; break }
        if (!consumed) { stopReason = 'no-progress'; break }
      }
      if (!ids.size && scanned < scanLimit) { stopReason = 'found' }
    } catch (error) {
      fetchError = String(error?.message || error).slice(0, 300)
      stopReason = 'request-error'
    }
    for (const localId of ids) statuses.set(`${sessionId}:${localId}`, { attempted: true, found: false, complete: false, partial: true, scanned, nextOffset: offset, scanLimit, stopReason, ...(fetchError ? { error: fetchError } : {}) })
  }
  return annotateSearchHits(decodedHits.map(hit => {
    const sessionId = String(hit.sessionId || hit.session_id || options.session_id || '')
    const key = `${sessionId}:${Number(hit.localId)}`
    if (searchHitNeedsHydration(hit) && (!sessionId || hit.localId == null) && !statuses.has(key)) statuses.set(key, { attempted: false, found: false, complete: false, partial: true, stopReason: 'missing-reference' })
    const merged = mergeSearchHit(hit, sources.get(key))
    const status = statuses.get(key)
    if (status?.found) {
      const contentComplete = contentIntegrityOf(merged).complete
      const identityComplete = identityCompleteOf(merged)
      statuses.set(key, { ...status, contentComplete, identityComplete, complete: contentComplete && identityComplete, partial: !(contentComplete && identityComplete) })
    }
    return merged
  }), 'search-index', statuses, options.session_id)
}
function messageVariantKey(message, fallbackSession = '') {
  const sessionId = String(message?.sessionId || message?.session_id || fallbackSession || '')
  const localId = message?.localId ?? message?.local_id ?? ''
  const serverId = message?.serverId ?? message?.server_id ?? ''
  if (localId !== '' && localId !== null) return `${sessionId}:local:${localId}`
  if (serverId !== '' && serverId !== null) return `${sessionId}:server:${serverId}`
  return `${sessionId}:content:${String(message?.content || '')}`
}
function mergeMessageVariants(messages, fallbackSession = '') {
  const groups = new Map()
  for (const message of messages || []) {
    const key = messageVariantKey(message, fallbackSession)
    const rows = groups.get(key) || []
    rows.push(message)
    groups.set(key, rows)
  }
  return [...groups.values()].map(rows => rows.slice(1).reduce((current, candidate) => mergeSearchHit(current, candidate), rows[0]))
}
function messageKey(message) {
  const sessionId = message.sessionId || message.session_id || ''
  if (message.localId !== undefined && message.localId !== null && message.localId !== '') return `${sessionId}:local:${message.localId}`
  if (message.serverId !== undefined && message.serverId !== null && message.serverId !== '') return `${sessionId}:server:${message.serverId}`
  return `${sessionId}:${message.timestamp || ''}:${message.content || ''}`
}
function buildSearchContextWindows(messages, hits, options = {}) {
  const before = Math.min(Math.max(Number(options.context_before) || 0, 0), 50)
  const after = Math.min(Math.max(Number(options.context_after) || 0, 0), 50)
  const sessionIdOf = item => String(item?.sessionId || item?.session_id || '')
  const bySession = new Map()
  for (const message of messages || []) {
    const sessionId = sessionIdOf(message)
    if (!bySession.has(sessionId)) bySession.set(sessionId, [])
    bySession.get(sessionId).push(message)
  }
  for (const rows of bySession.values()) rows.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0) || Number(a.localId || 0) - Number(b.localId || 0))
  const intervalsBySession = new Map(); const unresolvedHits = []
  for (const hit of hits || []) {
    const sessionId = sessionIdOf(hit); const rows = bySession.get(sessionId) || []
    const index = rows.findIndex(message => Number(message.localId) === Number(hit.localId))
    if (index < 0) { unresolvedHits.push({ ...hit, contextStatus: 'unresolved', reason: 'exact-session-localId-not-found' }); continue }
    if (!intervalsBySession.has(sessionId)) intervalsBySession.set(sessionId, [])
    intervalsBySession.get(sessionId).push({ start: Math.max(index - before, 0), end: Math.min(index + after, rows.length - 1), hitIndexes: [index], beforeTruncated: index - before < 0, afterTruncated: index + after >= rows.length })
  }
  const windows = []
  for (const [sessionId, intervals] of intervalsBySession) {
    const rows = bySession.get(sessionId); intervals.sort((a, b) => a.start - b.start || a.end - b.end)
    const merged = []
    for (const interval of intervals) {
      const prior = merged.at(-1)
      if (prior && interval.start <= prior.end + 1) {
        prior.end = Math.max(prior.end, interval.end); prior.hitIndexes.push(...interval.hitIndexes)
        prior.beforeTruncated ||= interval.beforeTruncated; prior.afterTruncated ||= interval.afterTruncated
      } else merged.push({ ...interval, hitIndexes: [...interval.hitIndexes] })
    }
    for (const interval of merged) {
      const hitIndexes = [...new Set(interval.hitIndexes)].sort((a, b) => a - b)
      const hitLocalIds = hitIndexes.map(index => Number(rows[index].localId))
      const hitSet = new Set(hitLocalIds)
      windows.push({ sessionId, hitLocalIds, boundary: { beforeTruncated: interval.beforeTruncated, afterTruncated: interval.afterTruncated }, messages: rows.slice(interval.start, interval.end + 1).map(message => ({ ...message, isHit: hitSet.has(Number(message.localId)) })) })
    }
  }
  windows.sort((a, b) => Number(a.messages[0]?.timestamp || 0) - Number(b.messages[0]?.timestamp || 0) || a.sessionId.localeCompare(b.sessionId))
  return { windows, unresolvedHits, coverage: { hits: (hits || []).length, resolvedHits: (hits || []).length - unresolvedHits.length, unresolvedHits: unresolvedHits.length, windows: windows.length, contextBefore: before, contextAfter: after } }
}
function buildIncrementalWindow(messages, options = {}) {
  const hasTimestamp = options.after_timestamp !== undefined && options.after_timestamp !== null && options.after_timestamp !== ''
  const hasLocalId = options.after_local_id !== undefined && options.after_local_id !== null && options.after_local_id !== ''
  const afterTimestamp = hasTimestamp ? Math.max(Number(options.after_timestamp) || 0, 0) : 0
  const afterLocalId = hasLocalId ? Math.max(Number(options.after_local_id) || 0, 0) : 0
  const seen = new Set(); const unique = []; let duplicatesDropped = 0
  for (const message of messages || []) {
    const key = messageKey(message)
    if (seen.has(key)) { duplicatesDropped += 1; continue }
    seen.add(key); unique.push(message)
  }
  unique.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0) || Number(a.localId || 0) - Number(b.localId || 0))
  if (!hasTimestamp && !hasLocalId) {
    const latest = unique.at(-1)
    return { messages: unique, incremental: { mode: 'full-fallback', cursorProvided: false, warning: 'No incremental cursor was provided; returning the complete fetched window without exactly-once guarantees.', sourceMessages: (messages || []).length, uniqueMessages: unique.length, overlapDropped: 0, duplicatesDropped, newMessages: unique.length, hasNewMessages: unique.length > 0, inputCursor: null, nextCursor: latest ? { timestamp: Number(latest.timestamp || 0), localId: Number(latest.localId || 0) } : null } }
  }
  if (!hasTimestamp) throw new Error('增量游标必须包含 after_timestamp；建议同时提供 after_local_id')
  const inputCursor = { timestamp: afterTimestamp, localId: afterLocalId }
  const selected = unique.filter(message => {
    const timestamp = Number(message.timestamp || 0); const localId = Number(message.localId || 0)
    return timestamp > afterTimestamp || (timestamp === afterTimestamp && localId > afterLocalId)
  })
  const latest = selected.at(-1)
  const safeToAdvance = !options.pagination || (options.pagination.complete && !options.offset)
  return { messages: selected, incremental: { mode: 'incremental', cursorProvided: true, warning: hasTimestamp && hasLocalId ? '' : 'Partial cursor provided; same-timestamp de-duplication may be incomplete.', sourceMessages: (messages || []).length, uniqueMessages: unique.length, overlapDropped: unique.length - selected.length, duplicatesDropped, newMessages: selected.length, hasNewMessages: selected.length > 0, inputCursor, cursorAdvanced: safeToAdvance, backlog: !safeToAdvance, resumeOffset: options.pagination?.nextOffset ?? null, cursorBoundary: safeToAdvance ? '' : '扫描未完整或从offset续读；确认游标保持不变以防漏消息。收齐全部分页后，调用方才可采用其中最大的 observedLatestCursor。', observedLatestCursor: latest ? { timestamp: Number(latest.timestamp || 0), localId: Number(latest.localId || 0) } : inputCursor, nextCursor: safeToAdvance && latest ? { timestamp: Number(latest.timestamp || 0), localId: Number(latest.localId || 0) } : inputCursor } }
}
async function fetchMessageRange(fetchPage, options = {}) {
  const targetLimit = Math.min(Math.max(Number(options.limit) || 500, 1), 5000)
  const pageSize = Math.min(Math.max(Number(options.page_size) || 100, 1), 100)
  const scanLimit = Math.min(Math.max(Number(options.scan_limit) || 10000, 1), 20000)
  const startTime = Number(options.start_time || 0), endTime = Number(options.end_time || 0)
  if (startTime && endTime && startTime > endTime) throw new Error('开始时间不能晚于结束时间')
  const seen = new Map(), sourceKeys = new Set()
  let offset = Math.max(Number(options.offset) || 0, 0), pagesFetched = 0, complete = false, session = null, scanned = 0, stopReason = 'limit'
  while (seen.size < targetLimit && scanned < scanLimit) {
    const requestSize = Math.min(pageSize, scanLimit - scanned)
    const page = unwrapMessages(await fetchPage({ session_id: options.session_id, limit: requestSize, offset }))
    session ||= page.session; pagesFetched += 1
    if (!page.messages.length) { complete = true; stopReason = 'exhausted'; break }
    let newKeys = 0, consumed = 0
    for (const original of page.messages) {
      if (scanned >= scanLimit || seen.size >= targetLimit) break
      consumed += 1; scanned += 1
      const message = { ...original, sessionId: original.sessionId || original.session_id || options.session_id || '', contentSource: original.contentSource || 'session-message' }
      const key = messageKey(message)
      if (sourceKeys.has(key)) continue
      sourceKeys.add(key); newKeys += 1
      const timestamp = Number(message.timestamp || 0)
      if ((endTime && timestamp > endTime) || (startTime && timestamp < startTime)) continue
      if (options.sender_id && String(message.senderId || message.sender_id || message.sender || '') !== options.sender_id) continue
      if (options.message_types?.length && !options.message_types.includes(Number(message.type))) continue
      const contentIntegrity = contentIntegrityOf(message)
      seen.set(key, { ...message, contentIntegrity, contentComplete: contentIntegrity.complete });
    }
    offset += consumed
    if (!newKeys && consumed) { stopReason = 'no-progress'; break }
    if (consumed === page.messages.length && page.messages.length < requestSize) { complete = true; stopReason = 'exhausted'; break }
    // Upstream ordering is not a proven contract; do not stop on one old timestamp.
  }
  if (!complete && scanned >= scanLimit) stopReason = 'scan-limit'
  const messages = [...seen.values()].sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0) || Number(a.localId || 0) - Number(b.localId || 0))
  return { formatVersion: 4, session, messages, returned: messages.length, contentIntegrity: summarizeContentIntegrity(messages), pagination: { requested: targetLimit, pageSize, pagesFetched, scanned, scanLimit, nextOffset: offset, complete, stopReason, warning: complete ? '' : '结果仅覆盖已扫描窗口。可使用 nextOffset 继续；消息新增时 offset 分页可能发生重叠。' } }
}
async function findMessageById(fetchPage, options = {}) {
  const sessionId = String(options.session_id || '')
  const localId = options.local_id == null ? null : String(options.local_id)
  const serverId = options.server_id == null ? null : String(options.server_id)
  if (!sessionId || (localId === null && !serverId)) throw new Error('请提供session_id以及local_id或server_id')
  const scanLimit = Math.min(Math.max(Number(options.scan_limit) || 1000, 1), 20000)
  const pageSize = Math.min(Math.max(Number(options.page_size) || 100, 1), 100)
  const startOffset = Math.max(Number(options.offset) || 0, 0)
  const seen = new Set()
  let offset = startOffset, scanned = 0, complete = false, stopReason = 'scan-limit'
  while (scanned < scanLimit) {
    const requestSize = Math.min(pageSize, scanLimit - scanned)
    const page = unwrapMessages(await fetchPage({ session_id: sessionId, limit: requestSize, offset }))
    if (!page.messages.length) { complete = true; stopReason = 'exhausted'; break }
    let consumed = 0, newMessages = 0
    for (const original of page.messages) {
      if (consumed >= requestSize) break
      consumed += 1; scanned += 1
      const message = { ...original, sessionId: original.sessionId || original.session_id || sessionId, contentSource: original.contentSource || 'session-message' }
      const key = messageKey(message)
      if (seen.has(key)) continue
      seen.add(key); newMessages += 1
      const matchesLocalId = localId === null || String(message.localId ?? '') === localId
      const matchesServerId = serverId === null || String(message.serverId ?? message.server_id ?? '') === serverId
      if (!matchesLocalId || !matchesServerId) continue
      const contentIntegrity = contentIntegrityOf(message)
      const enrichedMessage = { ...message, contentIntegrity, contentComplete: contentIntegrity.complete }
      return {
        found: true,
        message: enrichedMessage,
        contentIntegrity,
        coverage: { sessionId, scanned, startOffset, nextOffset: offset + consumed, scanLimit, scanExhausted: false, stopReason: 'found', contentComplete: contentIntegrity.complete },
        partial: !contentIntegrity.complete,
        boundary: contentIntegrity.complete
          ? '按会话内稳定消息ID精确回查；不施加单条消息字符上限，只受眼的单次HTTP响应上限约束。眼返回的 zstd 十六进制正文会先解成 UTF-8；解不开时保留原字段并标记 contentUndecoded，不把压缩十六进制当成明文。'
          : '已找到消息，但眼报告正文不完整、长度不一致或压缩内容未解码；当前结果不能当作完整正文。可用search_messages的索引命中或在上游补齐后再次回查。',
      }
    }
    offset += consumed
    if (!newMessages && consumed) { stopReason = 'no-progress'; break }
    if (consumed === page.messages.length && page.messages.length < requestSize) { complete = true; stopReason = 'exhausted'; break }
  }
  if (!complete && scanned >= scanLimit) stopReason = 'scan-limit'
  return {
    found: false,
    message: null,
    coverage: { sessionId, scanned, startOffset, nextOffset: offset, scanLimit, scanExhausted: complete, stopReason },
    partial: !complete,
    boundary: complete ? '已扫描到当前索引末尾，未找到该ID。' : '在当前有界扫描窗口内未找到该ID；使用nextOffset继续，不代表整个会话历史不存在该消息。',
  }
}
function normalizeMessageContent(value) {
  return String(value || '').replace(/\u0008/g, '\n').replace(/[\u200b-\u200f\u2060\ufeff]/g, '').replace(/\s+/g, ' ').trim()
}
function isHexBlob(text) {
  const compact = text.replace(/\s+/g, '')
  return compact.length >= 96 && /^[0-9a-f]+$/i.test(compact) && compact.length % 2 === 0
}
function isMentionOnly(text) {
  if (!text.includes('@')) return false
  if (/^@.{1,100}[）)]$/u.test(text)) return true
  let stripped = text.replace(/@[\p{L}\p{N}_.·（）()｜|\-—~～📚]+/gu, '')
  stripped = stripped.replace(/[\s\u2000-\u206f\ufe00-\ufe0f\u3000，,。.!！?？:：;；~～👌🏻]+/gu, '')
  return stripped.length === 0
}
function noiseReason(message, normalized, duplicateOf) {
  const type = Number(message.type)
  if (duplicateOf) return 'duplicate'
  if (type === 10000 || normalized === '[系统消息]') {
    if (/撤回了一条消息/.test(normalized)) return 'system-recall'
    if (/(邀请.+加入了群聊|通过扫描.+加入群聊|加入了群聊|移出了群聊|退出了群聊)/.test(normalized)) return 'system-membership-change'
    if (/(修改群名为|修改群公告|发布了群公告)/.test(normalized)) return 'system-group-metadata-change'
    if (/不是朋友关系，请注意隐私安全/.test(normalized)) return 'system-privacy-warning'
    if (normalized === '[系统消息]') return 'system-message-opaque'
    return 'system-message-other'
  }
  if (isHexBlob(normalized)) return 'encoded-or-encrypted-blob'
  if (!normalized) return 'empty'
  if (isMentionOnly(normalized)) return 'mention-only'
  if (/^\[(图片|多媒体|视频|语音|文件|动画表情|表情)\]$/.test(normalized)) return 'media-placeholder'
  const compactSocial = normalized.replace(/[👌👍🙏🏻\s，,。.!！?？~～]/gu, '')
  if (/^(好的?|好[的吧呀啊]?|嗯+|哦+|收到|谢谢|感谢|辛苦了|可以|行|知道了|明白了|ok|okay|哈哈+|呵呵+)(谢谢|感谢)?$/i.test(compactSocial)) return 'acknowledgement-or-smalltalk'
  if (/^(好的?|好[的吧呀啊]?|嗯+|哦+|收到|谢谢|感谢|辛苦了|可以|行|知道了|明白了|ok|okay)[，,。.!！?？\s]*(我|我们)?(先|再)?(收集|整理|看看|试试|确认|处理|跟进|问问)(一下|下)?[了吧呀啊]?$/iu.test(normalized)) return 'acknowledgement-or-smalltalk'
  if (normalized.length <= 3 && !/[0-9]/.test(normalized) && !/[?？]/.test(normalized) && !/^(咋|怎么|为何|为啥|谁|啥|哪|几|有吗|能吗|行吗|没有|有|能|不能|可以|不行|是|不是|对|不对)/.test(normalized)) return 'too-short'
  return ''
}
function qualitySignals(message, normalized) {
  const signals = []
  if (normalized.length >= 40) signals.push('substantive-length')
  if (/[?？]/.test(normalized) && normalized.length >= 12) signals.push('question')
  if (/(因为|导致|原因|解决|修复|方案|建议|步骤|方法|流程|复盘|总结|结论|需求|问题|报错|风险|成本|验证|测试|结果|决定|应该|必须|不要|避免)/.test(normalized)) signals.push('decision-or-problem-solving')
  if (/https?:\/\//i.test(normalized)) signals.push('resource-link')
  if (/\d/.test(normalized) && normalized.length >= 12) signals.push('specific-fact')
  if (Number(message.type) !== 1 && !/^\[.+\]$/.test(normalized)) signals.push('rich-content')
  return signals
}
function curateMessages(messages) {
  const selectedMessages = []; const noiseMessages = []; const seen = new Map()
  for (const message of messages) {
    const originalContent = message.content == null ? '' : String(message.content)
    const normalized = normalizeMessageContent(originalContent)
    const sender = message.senderId || message.sender || ''
    const fingerprint = `${sender}:${normalized.toLowerCase()}`
    const duplicateOf = normalized && seen.has(fingerprint) ? seen.get(fingerprint) : null
    if (normalized && !duplicateOf) seen.set(fingerprint, message.localId)
    const reason = noiseReason(message, normalized, duplicateOf)
    if (reason) {
      noiseMessages.push({ localId: message.localId, time: message.time, sender: message.senderName || sender, type: message.type, reason, duplicateOf, content: originalContent, contentChars: Array.from(originalContent).length, contentBytes: Buffer.byteLength(originalContent, 'utf8'), contentTruncated: false, excerpt: normalized.slice(0, 300), excerptTruncated: normalized.length > 300 })
      continue
    }
    const signals = qualitySignals(message, normalized)
    const qualityScore = Math.min(100, 35 + Math.min(normalized.length, 160) / 4 + signals.length * 10)
    selectedMessages.push({ ...message, content: originalContent, normalizedContent: normalized, qualityScore: Math.round(qualityScore), qualitySignals: signals })
  }
  const byReason = {}; for (const row of noiseMessages) byReason[row.reason] = (byReason[row.reason] || 0) + 1
  return { selectedMessages, noiseMessages, quality: { sourceMessages: messages.length, selectedMessages: selectedMessages.length, noiseMessages: noiseMessages.length, selectedRatio: messages.length ? selectedMessages.length / messages.length : 0, noiseByReason: byReason } }
}
function messageLabels(message) {
  const text = normalizeMessageContent(message?.content)
  return MESSAGE_LABEL_RULES.filter(rule => rule.test(text)).map(rule => rule.id)
}
function isExplicitTopicShift(message, labels, thread) {
  const text = normalizeMessageContent(message.content)
  if (/^(换个话题|另外|顺便问|说到别的|新话题)/.test(text)) return true
  if (!labels.includes('question')) return false
  return Number(message.timestamp || 0) - thread.lastTimestamp > 90
}
function mentionedNames(text) {
  return [...String(text || '').matchAll(/@([^@\s\u2000-\u206f\u3000]{1,40})/gu)].map(match => match[1].trim()).filter(name => name && name !== '所有人')
}
function buildContextThreads(messages, labelsById, options = {}) {
  const maxGap = Math.max(Number(options.context_gap_seconds) || 600, 30)
  const ordered = [...messages].sort((a,b) => Number(a.timestamp || 0) - Number(b.timestamp || 0) || Number(a.localId || 0) - Number(b.localId || 0))
  const threads = []
  const claimedResponseIds = new Set()
  for (let index = 0; index < ordered.length; index += 1) {
    const question = ordered[index]; const questionLabels = labelsById[String(question.localId)] || []
    if (!questionLabels.includes('question')) continue
    const prior = threads.at(-1)
    if (prior && prior.messageLocalIds.includes(question.localId)) continue
    const priorQuestion = prior ? ordered.find(item => item.localId === prior.questionLocalIds[0]) : null
    const sameQuestionSender = priorQuestion && (priorQuestion.senderName || priorQuestion.senderId || priorQuestion.sender || '') === (question.senderName || question.senderId || question.sender || '')
    if (prior && sameQuestionSender && Number(question.timestamp || 0) - prior.lastTimestamp <= 30 && prior.responseLocalIds.length === 0) {
      prior.questionLocalIds.push(question.localId); prior.messageLocalIds.push(question.localId); prior.evidence.push({ localId: question.localId, timestamp: question.timestamp || null, relation: 'follow-up-question', confidence: 'medium' }); prior.lastTimestamp = Number(question.timestamp || 0); continue
    }
    const explicitMentionNames = mentionedNames(question.content)
    const threadMaxGap = explicitMentionNames.length
      ? Math.max(maxGap, Math.max(Number(options.explicit_mention_gap_seconds) || 21600, 600))
      : maxGap
    const thread = { id: `thread-${question.localId}`, questionLocalIds: [question.localId], responseLocalIds: [], messageLocalIds: [question.localId], participants: [...new Set([question.senderName || question.senderId || question.sender || ''])].filter(Boolean), startedAt: question.timestamp || null, endedAt: question.timestamp || null, lastTimestamp: Number(question.timestamp || 0), status: 'unanswered', confidence: explicitMentionNames.length ? 'high' : 'medium', evidence: [{ localId: question.localId, timestamp: question.timestamp || null, relation: explicitMentionNames.length ? 'question-with-mention' : 'question', confidence: explicitMentionNames.length ? 'high' : 'high', gapSeconds: 0 }] }
    let consecutiveUnrelated = 0
    for (let cursor = index + 1; cursor < ordered.length; cursor += 1) {
      const reply = ordered[cursor]; const gap = Number(reply.timestamp || 0) - Number(question.timestamp || 0)
      if (gap < 0 || gap > threadMaxGap) break
      if (claimedResponseIds.has(reply.localId)) continue
      const replyLabels = labelsById[String(reply.localId)] || []
      const questionSender = question.senderName || question.senderId || question.sender || ''
      const replySender = reply.senderName || reply.senderId || reply.sender || ''
      if (replyLabels.includes('question') && replySender === questionSender && Number(reply.timestamp || 0) - thread.lastTimestamp <= 30 && thread.responseLocalIds.length === 0) {
        thread.questionLocalIds.push(reply.localId); thread.messageLocalIds.push(reply.localId); thread.evidence.push({ localId: reply.localId, timestamp: reply.timestamp || null, relation: 'follow-up-question', confidence: 'medium' }); thread.lastTimestamp = Number(reply.timestamp || 0); thread.endedAt = reply.timestamp || null; continue
      }
      if (isExplicitTopicShift(reply, replyLabels, thread) && !explicitMentionNames.includes(reply.senderName || reply.senderId || reply.sender || '')) break
      const isAnswer = replyLabels.includes('answer-or-explanation') || replyLabels.some(label => RESOLUTION_LABELS.has(label))
      const replyText = normalizeMessageContent(reply.content)
      const sameSender = replySender === questionSender
      const isSelfAnswer = sameSender && isAnswer && /(我查到了|查到原因|原因是|因为|所以|解决了|处理好了|答案是|结论是|应该是)/.test(replyText)
      const isSelfPlanContinuation = sameSender && thread.responseLocalIds.length > 0 && replyLabels.some(label => RESOLUTION_LABELS.has(label))
      const isSelfContinuation = isSelfAnswer || isSelfPlanContinuation
      const isMentionedResponder = explicitMentionNames.includes(replySender)
      if ((sameSender && !isSelfContinuation) || !isAnswer) {
        consecutiveUnrelated += 1
        if (consecutiveUnrelated >= 2) break
        continue
      }
      consecutiveUnrelated = 0
      thread.responseLocalIds.push(reply.localId); thread.messageLocalIds.push(reply.localId); thread.lastTimestamp = Number(reply.timestamp || 0); thread.endedAt = reply.timestamp || null
      claimedResponseIds.add(reply.localId)
      thread.evidence.push({ localId: reply.localId, timestamp: reply.timestamp || null, relation: isSelfContinuation ? 'self-answer' : isMentionedResponder ? 'mentioned-user-response' : 'candidate-response', confidence: isMentionedResponder ? 'high' : isAnswer ? 'medium' : 'low', gapSeconds: gap })
      const participant = reply.senderName || reply.senderId || reply.sender || ''; if (participant && !thread.participants.includes(participant)) thread.participants.push(participant)
      if (replyLabels.some(label => RESOLUTION_LABELS.has(label))) thread.status = 'resolved-with-plan'
      else if (thread.status === 'unanswered' && replyLabels.includes('answer-or-explanation')) thread.status = 'answered'
    }
    threads.push(thread)
  }
  for (const thread of threads) delete thread.lastTimestamp
  return threads
}
function workRegisterEvidence(message, confidence = 'medium') {
  return {
    localId: message.localId,
    timestamp: message.timestamp || null,
    sender: message.senderName || message.senderId || message.sender || '',
    ...contentExcerpt(normalizeMessageContent(message.content)),
    confidence,
  }
}
function extractAssigneeHint(text) {
  const mention = mentionedNames(text)[0]
  if (mention) return mention
  return String(text || '').match(/(?:请|让|由|安排)([\p{L}\p{N}_-]{1,20})(?=在|于|负责|处理|整理|完成|跟进|提交|发送|发给)/u)?.[1] || ''
}
function extractDueHint(text) {
  return String(text || '').match(/(今天|今晚|明天(?:上午|中午|下午|晚上)?|后天|本周[一二三四五六日天]|下周[一二三四五六日天]?|\d{1,2}月\d{1,2}日|\d{1,2}[点时](?:前|之前)?)(?:前|之前|内|完成)?/u)?.[0] || ''
}
function buildWorkRegister(messages, labelsById) {
  const decisions = []; const tasks = []; const risks = []; const results = []
  for (const message of messages) {
    const labels = labelsById[String(message.localId || messageKey(message))] || []
    const text = normalizeMessageContent(message.content)
    const explicitDecision = /(?:^|[，。；;\s])(?:决定|确定|就按|定为|定下来)/.test(text)
    const agreementDecision = /^(?:也行|可以|行|好|同意)[，,\s]*(?:就|那就|先|拿|把).{2,80}(?:试试|尝试|做|推进|执行|安排)/.test(text)
    if (explicitDecision || agreementDecision) decisions.push(workRegisterEvidence(message, explicitDecision ? 'high' : 'medium'))
    const assigneeHint = extractAssigneeHint(text); const dueHint = extractDueHint(text)
    const assignmentCue = /(?:^|[，。；;\s])(?:请|让|由|安排|麻烦)(?:@|[\p{L}\p{N}_-])/u.test(text) || /(?:负责|提交|发送|发给|跟进|处理|执行|推进|整理).{0,20}(?:任务|事项|项目|客户|报价|文档|报告|方案|测试|验证)/.test(text)
    const completionCue = /(?:前|之前|内)(?:完成|提交|发送|发给|跟进|处理|执行|推进|整理)/.test(text)
    if ((assigneeHint || dueHint) && (assignmentCue || completionCue)) {
      tasks.push({ ...workRegisterEvidence(message), assigneeHint, dueHint })
    }
    if (labels.includes('risk-or-problem')) risks.push(workRegisterEvidence(message))
    const resultCue = /(?:已|已经|最终|结果(?:为|是)?)[^。；？?]{0,80}(?:通过|完成|解决|上线|交付|达到|成功)|(?:验证|测试|任务|项目|方案|交付|修复|处理)[^。；？?]{0,40}(?:通过|完成|解决|上线|交付|达到|成功)(?:了|啦|完成|$)/.test(text)
    const negatedOrHypothetical = /(?:不能|没有|没能|未|失败|忘记|如果|能否|能不能|要不要|是否|[？?])/.test(text)
    if (resultCue && !negatedOrHypothetical) results.push(workRegisterEvidence(message))
  }
  return { summary: { decisions: decisions.length, tasks: tasks.length, risks: risks.length, results: results.length }, decisions, tasks, risks, results }
}
function contentExcerpt(value, limit = 500) {
  const text = String(value ?? '')
  return { excerpt: text.slice(0, limit), excerptTruncated: text.length > limit }
}
function classifyAndSynthesize(messages, options = {}) {
  const curated = curateMessages(messages)
  messages = curated.selectedMessages
  const minScore = Number(options.min_category_score || 1); const categories = []; const evidenceIndex = {}; const assigned = new Set(); const risks = []; const actionableAssets = []
  for (const rule of CATEGORY_RULES) {
    const evidence = []
    for (const message of messages) {
      const content = String(message.content || ''); const matched = rule.keywords.filter(keyword => content.toLowerCase().includes(keyword.toLowerCase()))
      if (matched.length < minScore) continue
      evidence.push({ localId: message.localId, timestamp: message.timestamp, time: message.time, sender: message.senderName || message.senderId || message.sender || '', ...contentExcerpt(content), matchedKeywords: matched })
      assigned.add(messageKey(message)); evidenceIndex[String(message.localId || messageKey(message))] ||= []; evidenceIndex[String(message.localId || messageKey(message))].push(rule.id)
    }
    if (evidence.length) {
      const keywordCounts = {}; for (const item of evidence) for (const keyword of item.matchedKeywords) keywordCounts[keyword] = (keywordCounts[keyword] || 0) + 1
      categories.push({ id: rule.id, name: rule.name, messageCount: evidence.length, topKeywords: Object.entries(keywordCounts).sort((a,b) => b[1]-a[1]).slice(0,10).map(([keyword,count]) => ({ keyword,count })), evidence })
    }
  }
  for (const message of messages) {
    const content = String(message.content || '')
    if (RISK_TERMS.some(term => content.includes(term))) risks.push({ localId: message.localId, time: message.time, ...contentExcerpt(content) })
    if (ACTION_TERMS.some(term => content.includes(term))) actionableAssets.push({ localId: message.localId, time: message.time, ...contentExcerpt(content), assetSignals: ACTION_TERMS.filter(term => content.includes(term)) })
  }
  const uncategorized = messages.filter(message => !assigned.has(messageKey(message))).map(message => ({ localId: message.localId, time: message.time, sender: message.senderName || message.senderId || '', ...contentExcerpt(String(message.content || ''), 300) }))
  const messageLabelsById = Object.fromEntries(messages.map(message => [String(message.localId || messageKey(message)), messageLabels(message)]))
  const contextThreads = buildContextThreads(messages, messageLabelsById, options)
  const workRegister = buildWorkRegister(messages, messageLabelsById)
  const senders = {}; const types = {}; let minTimestamp = 0; let maxTimestamp = 0
  for (const message of messages) {
    const sender = message.senderName || message.senderId || message.sender || '[未知]'; senders[sender] = (senders[sender] || 0) + 1; types[message.typeName || message.type || 'unknown'] = (types[message.typeName || message.type || 'unknown'] || 0) + 1
    const timestamp = Number(message.timestamp || 0); if (timestamp) { minTimestamp = minTimestamp ? Math.min(minTimestamp, timestamp) : timestamp; maxTimestamp = Math.max(maxTimestamp, timestamp) }
  }
  return { schemaVersion: 3, coverage: { sourceMessages: curated.quality.sourceMessages, selectedMessages: curated.quality.selectedMessages, noiseMessages: curated.quality.noiseMessages, categorizedMessages: assigned.size, uncategorizedMessages: uncategorized.length, contextThreads: contextThreads.length, minTimestamp, maxTimestamp, uniqueSenders: Object.keys(senders).length }, quality: curated.quality, selectedMessages: curated.selectedMessages, noiseMessages: curated.noiseMessages, categories, messageLabels: messageLabelsById, contextThreads, workRegister, risks, actionableAssets, uncategorized, evidenceIndex, distributions: { senders, types }, methodology: { taxonomy: 'quality-gated deterministic multi-label v3', contextBoundary: 'Question/response threads are deterministic candidate groupings based on chronological proximity and message-function labels; the calling AI should validate ambiguous topic shifts.', qualityBoundary: 'Raw messages are preserved separately; selectedMessages excludes auditable noise categories without deleting source evidence.', inferenceBoundary: 'Classification is deterministic evidence routing; deeper semantic conclusions should be produced by the calling model from cited localIds.' } }
}
function safeName(value) {
  return String(value || 'chat').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'chat'
}
function resolveOwnedOutputDir(sessionId, requested, baseDir = path.resolve(__dirname, '..', 'output')) {
  const base = path.resolve(baseDir)
  const destination = requested || path.join(base, `${safeName(sessionId)}-${randomUUID()}`)
  return ownedOutput(destination, base)
}
function threadEvidenceDisposition(item) {
  if (item.relation === 'question' || item.relation === 'question-with-mention' || item.relation === 'follow-up-question') return '问题证据'
  if (item.confidence === 'high' && ['mentioned-user-response','self-answer'].includes(item.relation)) return '已确认回复'
  return '候选，未确认为回复'
}
function renderContextThreadsMarkdown(contextThreads = [], quality = {}) {
  const noiseByReason = quality.noiseByReason || {}
  const lines = ['# 问题—回复—解决链审计', '', `- 线程总数：${contextThreads.length}`, `- 未解决：${contextThreads.filter(thread => thread.status === 'unanswered').length}`, `- 排除统计：${Object.entries(noiseByReason).map(([reason, count]) => `${reason}×${count}`).join('、') || '无'}`, '', '> 只有带高置信显式关系的回答标记为“已确认回复”；其他时间/功能标签候选明确标记为“候选，未确认为回复”。', '']
  for (const thread of contextThreads) {
    lines.push(`## ${thread.id}`, '', `- 状态：${thread.status}`, `- 线程置信度：${thread.confidence || 'unknown'}`, `- 问题 localId：${(thread.questionLocalIds || []).join(', ') || '无'}`, `- 回复候选 localId：${(thread.responseLocalIds || []).join(', ') || '无'}`, `- 开始 timestamp：${thread.startedAt ?? '未知'}`, `- 结束 timestamp：${thread.endedAt ?? '未知'}`, '', '### 逐条证据', '')
    for (const item of thread.evidence || []) lines.push(`- localId ${item.localId}｜timestamp ${item.timestamp ?? '未知'}｜gapSeconds ${item.gapSeconds ?? '未知'}｜relation ${item.relation || 'unknown'}｜confidence ${item.confidence || 'unknown'}｜${threadEvidenceDisposition(item)}`)
    if (!(thread.evidence || []).length) lines.push('- 无逐条证据')
    lines.push('')
  }
  return lines.join('\n')
}
function renderWorkRegisterMarkdown(workRegister = {}) {
  const groups = [
    ['决定', workRegister.decisions || []],
    ['任务', workRegister.tasks || []],
    ['风险', workRegister.risks || []],
    ['结果', workRegister.results || []],
  ]
  const lines = ['# 证据化工作台账', '', `- 决定：${workRegister.summary?.decisions || 0}`, `- 任务：${workRegister.summary?.tasks || 0}`, `- 风险：${workRegister.summary?.risks || 0}`, `- 结果：${workRegister.summary?.results || 0}`, '', '> 负责人和期限仅从消息明文提取；空值表示原文未明确，不做推断。', '']
  for (const [title, items] of groups) {
    lines.push(`## ${title}`, '')
    for (const item of items) {
      const hints = title === '任务' ? `｜负责人提示 ${item.assigneeHint || '未明确'}｜期限提示 ${item.dueHint || '未明确'}` : ''
      const excerpt = String(item.excerpt || '').replace(/\s+/g, ' ')
      lines.push(`- localId ${item.localId}｜timestamp ${item.timestamp ?? '未知'}｜sender ${item.sender || '未知'}｜confidence ${item.confidence || 'unknown'}${hints}｜${excerpt}${item.excerptTruncated ? '…（摘录，完整消息见分析数据）' : ''}`)
    }
    if (!items.length) lines.push('- 无')
    lines.push('')
  }
  return lines.join('\n')
}
function renderMarkdown(session, synthesis) {
  const lines = [`# 微信聊天记录高价值整合`, '', `- 会话：${session?.name || session?.id || '[未知]'}`, `- 原始消息：${synthesis.coverage.sourceMessages}`, `- 精选消息：${synthesis.coverage.selectedMessages}`, `- 噪声隔离：${synthesis.coverage.noiseMessages}`, `- 已分类：${synthesis.coverage.categorizedMessages}`, `- 未分类但保留：${synthesis.coverage.uncategorizedMessages}`, '', '## 质量门', '', `- 精选比例：${(synthesis.quality.selectedRatio * 100).toFixed(1)}%`, `- 噪声分布：${Object.entries(synthesis.quality.noiseByReason).map(([reason,count]) => `${reason}×${count}`).join('、') || '无'}`, '', '## 分类总览', '']
  for (const category of synthesis.categories) {
    lines.push(`### ${category.name}（${category.messageCount} 条）`, '', `高频信号：${category.topKeywords.map(item => `${item.keyword}×${item.count}`).join('、')}`, `证据展示：前${Math.min(category.evidence.length, 50)} / ${category.evidence.length} 条；完整原文见结构化分析数据。`, '')
    for (const item of category.evidence.slice(0, 50)) lines.push(`- [localId ${item.localId}] ${item.sender}：${item.excerpt.replace(/\s+/g, ' ').slice(0, 300)}${item.excerptTruncated ? '…（摘录）' : ''}`)
    lines.push('')
  }
  lines.push(`## 可产品化资产（展示 ${Math.min(synthesis.actionableAssets.length, 100)} / ${synthesis.actionableAssets.length} 条）`, '')
  for (const item of synthesis.actionableAssets.slice(0, 100)) lines.push(`- [localId ${item.localId}] ${item.assetSignals.join('/')}：${item.excerpt.replace(/\s+/g, ' ').slice(0, 300)}${item.excerptTruncated ? '…（摘录）' : ''}`)
  lines.push('', `## 风险与反面案例（展示 ${Math.min(synthesis.risks.length, 100)} / ${synthesis.risks.length} 条）`, '')
  for (const item of synthesis.risks.slice(0, 100)) lines.push(`- [localId ${item.localId}] ${item.excerpt.replace(/\s+/g, ' ').slice(0, 300)}${item.excerptTruncated ? '…（摘录）' : ''}`)
  lines.push('', renderWorkRegisterMarkdown(synthesis.workRegister || {}), '')
  lines.push('', renderContextThreadsMarkdown(synthesis.contextThreads || [], synthesis.quality || {}), '')
  const taggedCount = Object.entries(synthesis.messageLabels || {}).filter(([, labels]) => labels.length).length
  lines.push('', `## 消息功能标签（展示 ${Math.min(taggedCount, 300)} / ${taggedCount} 项）`, '')
  for (const [localId, labels] of Object.entries(synthesis.messageLabels || {}).filter(([, labels]) => labels.length).slice(0, 300)) lines.push(`- [localId ${localId}] ${labels.join(' / ')}`)
  lines.push('', '## 数据边界', '', '- 分类允许一条消息进入多个类别。', '- 每项结论保留 localId 证据定位。', '- 合并转发和文章卡片仍受眼的本地索引完整性限制。', '- 本文件提供证据化结构，不把关键词分类冒充最终语义判断。', '')
  return lines.join('\n')
}
module.exports = { unwrapMessages, decodeStoredMessage, hydrateSearchHits, annotateSearchHits, mergeSearchHit, mergeMessageVariants, contentIntegrityOf, summarizeContentIntegrity, sourceReportedContentTruncated, CATEGORY_RULES, fetchMessageRange, findMessageById, buildIncrementalWindow, buildSearchContextWindows, normalizeMessageContent, curateMessages, classifyAndSynthesize, renderWorkRegisterMarkdown, renderContextThreadsMarkdown, renderMarkdown, resolveOwnedOutputDir }
