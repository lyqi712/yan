const path = require('path')

const ATTACHMENT_TYPES = new Set([0, 3, 34, 43, 47, 49, 62])
function normalize(value) { return String(value || '').normalize('NFKC').replace(/\u0008/g, '').toLowerCase().replace(/[\s<>:"/\\|?*]+/g, '') }
function isStrongFilenameSignal(value) {
  const text = String(value || '').replace(/\u0008/g, '').trim()
  return text.length >= 4 && (/\.[a-z0-9]{1,10}(?:\)|）)?$/i.test(text) || /[\p{L}\p{N}][\p{L}\p{N} _.-]{3,}/u.test(text))
}
function messageTimeMs(message) { const value = Number(message.timestamp || 0); return value > 10_000_000_000 ? value : value * 1000 }
function fileTimeMs(file) { const parsed = Date.parse(file.modifiedAt || ''); return Number.isFinite(parsed) ? parsed : 0 }
function publicFile(file) { return { fileName: file.fileName || path.basename(file.sourcePath || ''), extension: path.extname(file.fileName || file.sourcePath || '').toLowerCase(), size: file.size || 0, modifiedAt: file.modifiedAt || null, parseSupport: file.parseSupport || null } }
function isUsableCandidate(file) { return ['text', 'ocr', 'metadata'].includes(String(file?.parseSupport || '').toLowerCase()) }
function isTypeCompatible(messageType, file) {
  const type = Number(messageType); const ext = path.extname(file.fileName || file.sourcePath || '').toLowerCase(); const support = String(file.parseSupport || '').toLowerCase()
  if (type === 3 || type === 47) return support === 'ocr'
  if (type === 34) return support === 'metadata' && ['.silk', '.amr', '.wav', '.mp3', '.m4a', '.aac', '.ogg', '.flac'].includes(ext)
  if (type === 43 || type === 62) return support === 'metadata'
  if (type === 0 || type === 49) return support === 'text'
  return false
}
function isIndexedMediaPlaceholder(message, normalized) {
  const type = Number(message.type)
  return type !== 1 && type !== 10000 && /^\[(图片|多媒体|视频|语音|文件|动画表情|表情)\]$/.test(normalized)
}
function associateAttachments(messages, files, options = {}) {
  const windowMs = Math.max(Number(options.timeWindowSeconds) || 300, 1) * 1000
  const imageWindowMs = Math.min(windowMs, Math.max(Number(options.imageTimeWindowSeconds) || 5, 1) * 1000)
  const candidates = files.filter(isUsableCandidate).map((file, index) => ({ file, index, name: normalize(file.fileName || path.basename(file.sourcePath || '')), time: fileTimeMs(file) }))
  const used = new Set(); const links = []; const unmatchedMessages = []
  for (const message of messages || []) {
    const rawContent = String(message.content || '')
    const content = normalize(rawContent); const strongFilenameSignal = isStrongFilenameSignal(rawContent); const time = messageTimeMs(message)
    let best = null
    for (const candidate of candidates) {
      if (used.has(candidate.index)) continue
      const delta = Math.abs(candidate.time - time)
      let score = 0; let reason = ''
      if (strongFilenameSignal && candidate.name && content && (content.includes(candidate.name) || candidate.name.includes(content))) { score = 1000 - Math.min(delta / 1000, 999); reason = 'filename-match' }
      else if (ATTACHMENT_TYPES.has(Number(message.type)) && isTypeCompatible(message.type, candidate.file) && delta <= (Number(message.type) === 3 || Number(message.type) === 47 ? imageWindowMs : windowMs)) { score = 500 - delta / windowMs * 100; reason = 'type-and-time-proximity' }
      else if (isIndexedMediaPlaceholder(message, rawContent) && delta <= windowMs && (Math.abs(candidate.time - time) <= 5000 || candidate.name.includes(String(message.timestamp || '')))) { score = 450 - Math.min(delta / 5000 * 100, 100); reason = 'indexed-placeholder-time-match' }
      if (!best || score > best.score) best = score > 0 ? { ...candidate, score, reason, delta } : best
    }
    if (!best) {
      if (ATTACHMENT_TYPES.has(Number(message.type))) unmatchedMessages.push({ localId: message.localId, timestamp: message.timestamp, type: message.type, reason: 'no-local-file-candidate' })
      continue
    }
    used.add(best.index)
    links.push({ localId: message.localId, timestamp: message.timestamp, type: message.type, file: publicFile(best.file), confidence: best.reason === 'filename-match' ? 'high' : 'medium', reason: best.reason, timeDeltaSeconds: Math.round(best.delta / 1000) })
  }
  const unmatchedFiles = candidates.filter(candidate => !used.has(candidate.index)).map(candidate => ({ file: publicFile(candidate.file), reason: 'no-message-candidate' }))
  return { schemaVersion: 1, links, unmatchedMessages, unmatchedFiles, coverage: { sourceMessages: (messages || []).length, candidateFiles: candidates.length, ignoredUnsupportedFiles: files.length - candidates.length, linkedMessages: links.length, linkedFiles: used.size, highConfidence: links.filter(link => link.confidence === 'high').length, mediumConfidence: links.filter(link => link.confidence === 'medium').length } }
}
module.exports = { associateAttachments }
