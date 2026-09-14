const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { ownedOutput } = require('./path-safety')
const JSZip = require('jszip')
const { renderContextThreadsMarkdown, renderWorkRegisterMarkdown } = require('./record-pipeline')

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex') }
function safeName(value, fallback = 'item') {
  return String(value || fallback).replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80) || fallback
}
function stableJson(value) { return JSON.stringify(value, null, 2) + '\n' }
function csvCell(value) { const raw = String(value ?? ''); const text = /^[=+@\-\t\r]/.test(raw) ? "'" + raw : raw; return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text }
function redactIdentifiers(value) {
  if (typeof value === 'string') return value.replace(/wxid_[a-z0-9_-]{6,}/gi, '[redacted-wechat-id]')
  if (Array.isArray(value)) return value.map(redactIdentifiers)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !['sourcePath','accountDir','roots'].includes(key)).map(([key, item]) => [key, redactIdentifiers(item)]))
  return value
}
function publicMessage(message) { return redactIdentifiers(message || {}) }
function threadAudit(contextThreads = []) {
  const evidence = contextThreads.flatMap(thread => thread.evidence || [])
  return {
    total: contextThreads.length,
    unanswered: contextThreads.filter(thread => thread.status === 'unanswered').length,
    highConfidenceConfirmedResponses: evidence.filter(item => item.confidence === 'high' && ['mentioned-user-response','self-answer'].includes(item.relation)).length,
    lowConfidenceCandidates: evidence.filter(item => item.confidence !== 'high' && !['question','question-with-mention','follow-up-question'].includes(item.relation)).length,
  }
}
function readme(sessionName, counts) {
  return `# 眼 · 微信证据包\n\n- 会话：${sessionName || '未命名会话'}\n- 原始消息：${counts.rawMessages}\n- 精选消息：${counts.selectedMessages}\n- 噪声账本：${counts.noiseMessages}\n- 附件：${counts.attachments}\n\n## 目录\n\n- \`00-raw/\`：完整原始消息证据。\n- \`01-selected/\`：精选消息与噪声隔离账本。\n- \`02-attachments/\`：附件清单和已提取正文。\n- \`03-analysis/\`：分类与深度分析结构。\n- \`04-audit/\`：消息处置、覆盖率和完整性证据。\n\n这是包含私人消息和附件正文的本地证据包。结构化来源路径已移除，部分微信ID被替换；自由文本、姓名、联系方式和文件名可能仍含个人信息。外发前需逐项检查。原始层保留消息顺序和字段结构，但不是逐字节原始数据库副本。\n`
}

async function buildExportPackage(input) {
  if (!input.outputDir) throw new Error('缺少输出目录')
  const outputDir = ownedOutput(input.outputDir, path.resolve(__dirname, '..', 'output'))
  if (!outputDir) throw new Error('输出目录必须位于眼的 output 目录内')
  fs.mkdirSync(outputDir, { recursive: true })
  const rawMessages = (input.rawMessages || []).map(publicMessage)
  const selectedMessages = (input.synthesis?.selectedMessages || []).map(publicMessage)
  const noiseMessages = redactIdentifiers(input.synthesis?.noiseMessages || [])
  const safeSynthesis = redactIdentifiers(input.synthesis || {})
  const attachments = input.attachments || []
  const counts = { rawMessages: rawMessages.length, selectedMessages: selectedMessages.length, noiseMessages: noiseMessages.length, attachments: attachments.length }
  const entries = new Map()
  entries.set('README.md', readme(input.session?.name, counts))
  entries.set('00-raw/source_messages.json', stableJson({ session: { name: input.session?.name || '' }, pagination: input.pagination || {}, messages: rawMessages }))
  entries.set('01-selected/selected_messages.json', stableJson(selectedMessages))
  entries.set('01-selected/noise_ledger.json', stableJson(noiseMessages))
  entries.set('03-analysis/classified_analysis.json', stableJson({ ...safeSynthesis, selectedMessages, noiseMessages }))
  entries.set('03-analysis/message_labels.json', stableJson(safeSynthesis.messageLabels || {}))
  entries.set('03-analysis/context_threads.json', stableJson(safeSynthesis.contextThreads || []))
  entries.set('03-analysis/context_threads.md', renderContextThreadsMarkdown(safeSynthesis.contextThreads || [], safeSynthesis.quality || {}) + '\n')
  entries.set('03-analysis/work_register.json', stableJson(safeSynthesis.workRegister || { summary: { decisions: 0, tasks: 0, risks: 0, results: 0 }, decisions: [], tasks: [], risks: [], results: [] }))
  entries.set('03-analysis/work_register.md', renderWorkRegisterMarkdown(safeSynthesis.workRegister || {}) + '\n')
  const disposition = ['localId,status,reason,qualityScore']
  for (const message of selectedMessages) disposition.push([message.localId, 'selected', '', message.qualityScore || ''].map(csvCell).join(','))
  for (const message of noiseMessages) disposition.push([message.localId, 'noise', message.reason || '', ''].map(csvCell).join(','))
  entries.set('04-audit/message_disposition.csv', disposition.join('\n') + '\n')
  entries.set('04-audit/coverage_report.json', stableJson({ counts, pagination: input.pagination || {}, incremental: input.incremental || null, quality: input.synthesis?.quality || {}, threadAudit: threadAudit(safeSynthesis.contextThreads || []), exclusions: safeSynthesis.quality?.noiseByReason || {}, generatedAt: new Date().toISOString() }))
  entries.set('04-audit/incremental_window.json', stableJson(input.incremental || { mode: 'full-fallback', cursorProvided: false, warning: 'No incremental cursor metadata was supplied for this export.' }))
  const attachmentManifest = []
  for (let index = 0; index < attachments.length; index += 1) {
    const item = attachments[index]
    const id = String(index + 1).padStart(4, '0')
    const relativeTextPath = `02-attachments/extracted-text/${id}-${safeName(item.fileName, 'attachment')}.txt`
    entries.set(relativeTextPath, String(item.text || ''))
    attachmentManifest.push({ id, fileName: item.fileName || '', extension: path.extname(item.fileName || '').toLowerCase(), sha256: item.sha256 || '', size: item.size || 0, modifiedAt: item.modifiedAt || null, parser: item.parser || '', truncated: Boolean(item.truncated), originalChars: item.originalChars || 0, coverage: item.coverage || {}, warnings: item.warnings || [], extractedTextPath: relativeTextPath })
  }
  entries.set('02-attachments/errors.json', stableJson(redactIdentifiers(input.attachmentErrors || [])))
  entries.set('02-attachments/manifest.json', stableJson(attachmentManifest))
  entries.set('02-attachments/message-attachment-links.json', stableJson(redactIdentifiers(input.attachmentAssociation || { schemaVersion: 1, links: [], unmatchedMessages: [], unmatchedFiles: [], coverage: {} })))
  const manifest = { schemaVersion: 1, product: 'yan', generatedAt: new Date().toISOString(), session: { name: input.session?.name || '' }, counts, privacy: { mode: 'local-evidence', redactionCoverage: 'partial', structuredSourcePathsRemoved: true, freeTextMayContainPersonalData: true, requiresReviewBeforeSharing: true, databaseFilesIncluded: false }, completeness: { messagePaginationComplete: Boolean(input.pagination?.complete), mergedForwardMayBePreviewOnly: true, externalArticleFetch: false, missingAttachmentsAutoDownloaded: false }, files: [] }
  for (const [name, content] of entries) manifest.files.push({ path: name, sha256: sha256(Buffer.from(content)), bytes: Buffer.byteLength(content) })
  entries.set('manifest.json', stableJson(manifest))
  const checksumLines = [...entries.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, content]) => `${sha256(Buffer.from(content))}  ${name}`)
  entries.set('checksums.sha256', checksumLines.join('\n') + '\n')
  const zip = new JSZip()
  for (const [name, content] of entries) zip.file(name, content)
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'DOS' })
  const zipPath = path.join(outputDir, `yan-evidence-${crypto.randomUUID()}.zip`)
  fs.writeFileSync(zipPath, buffer, { flag: 'wx' })
  const verified = await JSZip.loadAsync(fs.readFileSync(zipPath), { checkCRC32: true })
  const names = Object.keys(verified.files).filter(name => !verified.files[name].dir)
  if (!names.includes('manifest.json') || !names.includes('checksums.sha256')) throw new Error('ZIP integrity verification failed: required manifest files are missing')
  for (const item of manifest.files) {
    const entry = verified.file(item.path)
    if (!entry || sha256(await entry.async('nodebuffer')) !== item.sha256) throw new Error('ZIP SHA-256 verification failed')
  }
  return { zipPath: zipPath.replace(/\\/g, '/'), sha256: sha256(buffer), bytes: buffer.length, entries: names.length, manifest, integrity: { testzip: 'PASS', crc32Checked: true, contentHashesChecked: true } }
}

module.exports = { buildExportPackage }
