const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')
const JSZip = require('jszip')
const mammoth = require('mammoth')
const cheerio = require('cheerio')
const iconv = require('iconv-lite')
const chardet = require('chardet')
const { withinRoots } = require('./path-safety')
const { loadBoundedZip, validateArchive } = require('./bounded-zip')
const { runtimePath, pythonModuleAvailable, runtimeStatus } = require('./optional-runtime')
const { preferEnv } = require('./config')
function fromEnv(name) { return preferEnv(process.env, name) }

const DEFAULT_MAX_TEXT = 200000
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.xml', '.html', '.htm', '.log', '.rtf', '.srt', '.vtt'])
const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.odt', '.epub'])
const SPREADSHEET_EXTENSIONS = new Set(['.xls', '.xlsx', '.xlsm', '.ods'])
const PRESENTATION_EXTENSIONS = new Set(['.pptx', '.odp'])
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff', '.dat'])
const AUDIO_VIDEO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.mp4', '.mov', '.mkv', '.avi', '.webm'])
const ARCHIVE_EXTENSIONS = new Set(['.zip'])
const SUPPORTED_EXTENSIONS = new Set([...TEXT_EXTENSIONS, ...DOCUMENT_EXTENSIONS, ...SPREADSHEET_EXTENSIONS, ...PRESENTATION_EXTENSIONS, ...IMAGE_EXTENSIONS, ...AUDIO_VIDEO_EXTENSIONS, ...ARCHIVE_EXTENSIONS])
const MAX_ARCHIVE_ENTRIES = 200
const MAX_ARCHIVE_ENTRY_BYTES = 10 * 1024 * 1024
const MAX_ARCHIVE_TOTAL_BYTES = 50 * 1024 * 1024

function xmlDecode(value) {
  return String(value || '').replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}
function stripXml(xml) {
  return xmlDecode(String(xml || '').replace(/<w:tab\s*\/?\s*>/gi, '\t').replace(/<w:br\s*\/?\s*>/gi, '\n')
    .replace(/<\/w:p>/gi, '\n').replace(/<\/text:p>/gi, '\n').replace(/<\/row>/gi, '\n').replace(/<\/c>/gi, '\t').replace(/<[^>]+>/g, ''))
    .replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim()
}
function stripHtml(html) {
  const $ = cheerio.load(String(html || ''))
  $('script,style,noscript,svg').remove()
  return $('body').text().replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n/g, '\n\n').trim()
}
function safeStat(filePath) { try { return fs.statSync(filePath) } catch { return null } }
function resolveAccountDir(config) {
  if (!config?.dbPath) return null
  if (fs.existsSync(path.join(config.dbPath, 'db_storage'))) return path.resolve(config.dbPath)
  if (config.myWxid) {
    const candidate = path.join(config.dbPath, config.myWxid)
    if (fs.existsSync(path.join(candidate, 'db_storage'))) return path.resolve(candidate)
  }
  try {
    const candidates = fs.readdirSync(config.dbPath).filter(name => name.toLowerCase().startsWith('wxid_')).map(name => path.join(config.dbPath, name)).filter(candidate => fs.existsSync(path.join(candidate, 'db_storage')))
    if (candidates.length === 1) return path.resolve(candidates[0])
    if (candidates.length > 1) throw new Error('发现多个微信账号，请在设置中明确选择一个账号目录')
  } catch (error) { if (error.message.includes('多个微信账号')) throw error }
  return null
}
function getAllowedRoots(accountDir) {
  return [path.join(accountDir, 'msg', 'file'), path.join(accountDir, 'msg', 'attach'), path.join(accountDir, 'cache'), path.join(accountDir, 'temp')]
    .filter(candidate => fs.existsSync(candidate) && withinRoots(candidate, [accountDir])).map(candidate => path.resolve(candidate))
}
function isWithinAllowedRoots(candidate, roots) {
  return withinRoots(candidate, roots)
}
const commandCache = new Map()
function commandExists(command) {
  if (commandCache.has(command)) return commandCache.get(command)
  const probe = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { encoding: 'utf8', windowsHide: true })
  const found = probe.status === 0
  commandCache.set(command, found)
  return found
}
function sniffMagic(buffer) {
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image'
  if (buffer.slice(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'image'
  if (buffer.slice(0, 4).toString() === 'GIF8' || buffer.slice(0, 2).toString() === 'BM') return 'image'
  if (buffer.slice(0, 4).toString() === '%PDF') return 'pdf'
  if (buffer.slice(0, 2).toString() === 'PK') return 'zip'
  return ''
}
function detectFileKind(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.dat') {
    let fd
    try { fd = fs.openSync(filePath, 'r'); const header = Buffer.alloc(16); const size = fs.readSync(fd, header, 0, 16, 0); return sniffMagic(header.subarray(0, size)) || 'binary' } catch { return 'binary' } finally { if (fd !== undefined) fs.closeSync(fd) }
  }
  if (PRESENTATION_EXTENSIONS.has(ext)) return ext.slice(1)
  if (SPREADSHEET_EXTENSIONS.has(ext)) return 'spreadsheet'
  if (DOCUMENT_EXTENSIONS.has(ext)) return ext.slice(1)
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (AUDIO_VIDEO_EXTENSIONS.has(ext)) return 'media'
  if (ARCHIVE_EXTENSIONS.has(ext)) return 'zip'
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  return 'unsupported'
}
function parserSupport(ext, filePath = '') {
  const kind = filePath ? detectFileKind(filePath) : detectFileKind(`x${ext}`)
  if (kind === 'pdf') return commandExists('pdftotext') || highAccuracyOcrAvailable() ? 'text' : 'missing-pdf-engine'
  if (kind === 'image') return highAccuracyOcrAvailable() ? 'ocr' : 'missing-ocr-engine'
  if (kind === 'doc') return commandExists('antiword') ? 'text' : 'missing-antiword'
  if (kind === 'spreadsheet' && ext.toLowerCase() === '.xls') return legacyXlsAvailable() ? 'text' : 'missing-xlrd'
  if (kind === 'media') return commandExists('ffprobe') ? 'metadata' : 'missing-ffprobe'
  if (['text','docx','odt','epub','spreadsheet','pptx','odp','zip'].includes(kind)) return 'text'
  return 'unsupported'
}
function walkFilesDetailed(roots, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 2000)
  const keyword = String(options.keyword || '').toLowerCase()
  const extensions = options.extensions?.length ? new Set(options.extensions.map(ext => ext.startsWith('.') ? ext.toLowerCase() : '.' + ext.toLowerCase())) : SUPPORTED_EXTENSIONS
  const minTimestamp = Number(options.start_time || 0) * 1000
  const maxTimestamp = Number(options.end_time || 0) * 1000
  const results = []; const stack = [...roots].reverse(); let visited = 0; let matchedFiles = 0; let traversalLimitHit = false
  const maxVisited = Math.min(Math.max(Number(options.max_entries) || 20000, 1), 100000)
  while (stack.length && visited < maxVisited) {
    const current = stack.pop(); let entries = []
    try { entries = fs.readdirSync(current, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (++visited > maxVisited) { traversalLimitHit = true; break }
      const full = path.join(current, entry.name)
      if (!isWithinAllowedRoots(full, roots)) continue
      if (entry.isDirectory()) { stack.push(full); continue }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (!extensions.has(ext) || (keyword && !entry.name.toLowerCase().includes(keyword))) continue
      const stat = safeStat(full)
      if (!stat || (minTimestamp && stat.mtimeMs < minTimestamp) || (maxTimestamp && stat.mtimeMs > maxTimestamp)) continue
      matchedFiles += 1
      results.push({ fileName: entry.name, extension: ext, kind: detectFileKind(full), sourcePath: path.resolve(full).replace(/\\/g, '/'), size: stat.size, modifiedAt: stat.mtime.toISOString(), parseSupport: parserSupport(ext, full) })
      if (results.length > limit * 2) { results.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)); results.length = limit }
    }
  }
  const files = results.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, limit)
  const truncatedByTraversal = traversalLimitHit || stack.length > 0
  const coverage = { visitedEntries: visited, maxVisitedEntries: maxVisited, matchedFiles, returnedFiles: files.length, limit, truncatedByTraversal, truncatedByLimit: matchedFiles > limit, complete: !truncatedByTraversal && matchedFiles <= limit }
  return { files, coverage }
}
function walkFiles(roots, options = {}) {
  return walkFilesDetailed(roots, options).files
}
function decodeText(buffer) {
  const encoding = chardet.detect(buffer) || 'UTF-8'
  try { return { text: iconv.decode(buffer, encoding), encoding } } catch { return { text: buffer.toString('utf8'), encoding: 'UTF-8-fallback' } }
}
async function extractDocx(filePath) {
  await validateArchive(filePath)
  try {
    const output = await mammoth.extractRawText({ path: filePath })
    return { text: output.value.trim(), coverage: { warnings: output.messages.length }, parser: 'mammoth' }
  } catch (error) {
    const fallback = await extractXmlPackage(filePath, [/^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/i], 'docx-xml-fallback')
    return { ...fallback, warnings: [`Mammoth fallback: ${error.message}`] }
  }
}
async function extractSpreadsheet(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.xls') return extractLegacyXls(filePath)
  const zip = await loadBoundedZip(filePath); let shared = []
  if (zip.file('xl/sharedStrings.xml')) {
    const xml = await zip.file('xl/sharedStrings.xml').async('string')
    shared = [...xml.matchAll(/<si[\s>][\s\S]*?<\/si>/gi)].map(match => stripXml(match[0]))
  }
  if (zip.file('content.xml')) {
    const text = stripXml(await zip.file('content.xml').async('string'))
    return { text, coverage: { sheetsParsed: 1 }, parser: 'ods-xml' }
  }
  const sheets = Object.keys(zip.files).filter(name => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })); const chunks = []
  for (const name of sheets) {
    const xml = await zip.file(name).async('string'); const rows = []
    for (const rowMatch of xml.matchAll(/<row[\s>][\s\S]*?<\/row>/gi)) {
      const cells = []
      for (const cellMatch of rowMatch[0].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/gi)) {
        const attrs = cellMatch[1]; const body = cellMatch[2]; const value = body.match(/<v>([\s\S]*?)<\/v>/i)?.[1] ?? body.match(/<t[^>]*>([\s\S]*?)<\/t>/i)?.[1] ?? ''
        cells.push(/t="s"/i.test(attrs) ? (shared[Number(value)] || '') : xmlDecode(value))
      }
      if (cells.some(Boolean)) rows.push(cells.join('\t'))
    }
    chunks.push(`## ${path.basename(name, '.xml')}\n${rows.join('\n')}`)
  }
  return { text: chunks.join('\n\n'), coverage: { sheetsParsed: sheets.length }, parser: 'spreadsheet-xml' }
}
async function extractPptx(filePath) {
  const zip = await loadBoundedZip(filePath); const names = Object.keys(zip.files)
    .filter(name => /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/i.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const chunks = []
  for (const name of names) {
    const xml = await zip.file(name).async('string')
    const text = [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/gi)].map(match => xmlDecode(match[1])).join('\n').trim()
    if (text) chunks.push(`## ${name}\n${text}`)
  }
  return { text: chunks.join('\n\n'), coverage: { partsParsed: names.length }, parser: 'pptx-xml' }
}
async function extractXmlPackage(filePath, prefixes, parserName) {
  const zip = await loadBoundedZip(filePath); const names = Object.keys(zip.files).filter(name => prefixes.some(pattern => pattern.test(name))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })); const chunks = []
  for (const name of names) {
    const raw = await zip.file(name).async('string'); const text = /\.x?html$/i.test(name) ? stripHtml(raw) : stripXml(raw)
    if (text) chunks.push(`## ${name}\n${text}`)
  }
  return { text: chunks.join('\n\n'), coverage: { partsParsed: names.length }, parser: parserName }
}
function extractPdf(filePath) {
  if (highAccuracyOcrAvailable()) return extractImage(filePath)
  if (commandExists('pdftotext')) {
    const result = spawnSync('pdftotext', ['-layout', filePath, '-'], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, windowsHide: true, timeout: 60000 })
    if (result.status === 0) {
      const text = String(result.stdout || '').replace(/\r/g, '').trim()
      if (text) return { text, coverage: { pagesParsed: Math.max(1, String(result.stdout || '').split('\f').length), ocrUsed: false }, parser: 'pdftotext', warnings: ['仅读取文本层；混合PDF中的扫描页可能未覆盖。'] }
    }
  }
  if (!highAccuracyOcrAvailable()) throw new Error('PDF parser unavailable: neither pdftotext nor isolated PyMuPDF/OCR runtime is available')
  const ocr = extractImage(filePath)
  return { ...ocr, parser: `${ocr.parser}-pdf`, warnings: ocr.coverage?.ocrUsed ? ['PDF text layer was unavailable; page OCR was used.', ...(ocr.warnings || [])] : (ocr.warnings || []) }
}
function extractDoc(filePath) {
  if (!commandExists('antiword')) throw new Error('DOC parser unavailable: antiword not found')
  const result = spawnSync('antiword', [filePath], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, windowsHide: true, timeout: 60000 })
  if (result.status !== 0) throw new Error(`antiword failed: ${String(result.stderr || '').trim()}`)
  return { text: String(result.stdout || '').trim(), coverage: {}, parser: 'antiword' }
}
const OCR_ROOT = path.resolve(fromEnv('OCR_ROOT') || path.join(__dirname, '..', 'ocr-runtime'))
const DEFAULT_PYTHON = path.join(OCR_ROOT, '.venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']))
const OCR_PYTHON = fromEnv('OCR_PYTHON') || runtimePath('ocr', DEFAULT_PYTHON)
const OCR_SCRIPT = fromEnv('OCR_SCRIPT') || path.join(OCR_ROOT, 'ocr_runner.py')
const XLS_PYTHON = fromEnv('XLS_PYTHON') || runtimePath('xls', DEFAULT_PYTHON) || OCR_PYTHON
const XLS_SCRIPT = fromEnv('XLS_SCRIPT') || path.join(OCR_ROOT, 'xls_runner.py')
function legacyXlsAvailable() { return fs.existsSync(fromEnv('XLS_PYTHON') || XLS_PYTHON) && fs.existsSync(fromEnv('XLS_SCRIPT') || XLS_SCRIPT) && pythonModuleAvailable(fromEnv('XLS_PYTHON') || XLS_PYTHON, 'xlrd') }
function extractLegacyXls(filePath) {
  const python = fromEnv('XLS_PYTHON') || XLS_PYTHON
  const script = fromEnv('XLS_SCRIPT') || XLS_SCRIPT
  if (!fs.existsSync(python) || !fs.existsSync(script)) throw new Error('Legacy XLS parser unavailable: see docs/optional-runtime.md to install the optional xlrd runtime')
  const result = spawnSync(python, [script, '--input', filePath, '--json'], { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024, windowsHide: true, timeout: Math.min(Math.max(Number(fromEnv('XLS_TIMEOUT_MS')) || 120000, 10000), 300000), env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
  if (result.error) throw new Error(`Legacy XLS parser launch failed: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`Legacy XLS parser failed: ${String(result.stderr || result.stdout || '').trim()}`)
  let payload; try { payload = JSON.parse(String(result.stdout || '').trim()) } catch { throw new Error('Legacy XLS parser returned invalid JSON') }
  return { text: String(payload.text || '').trim(), coverage: payload.coverage || {}, parser: payload.parser || 'xlrd-safe-legacy-xls', warnings: payload.warnings || [] }
}
function highAccuracyOcrAvailable() {
  const python = fromEnv('OCR_PYTHON') || OCR_PYTHON
  return fs.existsSync(python) && fs.existsSync(fromEnv('OCR_SCRIPT') || OCR_SCRIPT) && pythonModuleAvailable(python, ['rapidocr', 'pymupdf'])
}
function extractImage(filePath) {
  const python = fromEnv('OCR_PYTHON') || OCR_PYTHON
  const script = fromEnv('OCR_SCRIPT') || OCR_SCRIPT
  if (!fs.existsSync(python) || !fs.existsSync(script)) throw new Error('High-accuracy OCR unavailable: isolated RapidOCR runtime not found')
  const result = spawnSync(python, [script, '--input', filePath, '--json'], {
    encoding: 'utf8', maxBuffer: 100 * 1024 * 1024, windowsHide: true,
    timeout: Math.min(Math.max(Number(fromEnv('OCR_TIMEOUT_MS')) || 300000, 10000), 900000),
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True' },
  })
  if (result.error) throw new Error(`RapidOCR launch failed: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`RapidOCR failed: ${String(result.stderr || result.stdout || '').trim()}`)
  let payload
  try { payload = JSON.parse(String(result.stdout || '').trim()) } catch { throw new Error('RapidOCR returned invalid JSON') }
  return {
    text: String(payload.text || '').trim(),
    coverage: { ocrUsed: payload.ocrUsed !== false, confidence: payload.confidence ?? null, pagesParsed: payload.processedPages || payload.pages || 1, totalPages: payload.pages || 1, partial: Boolean(payload.metadata?.partial), linesDetected: payload.lines || 0 },
    parser: payload.parser || 'rapidocr-local-models', warnings: payload.warnings || [], metadata: payload.metadata,
  }
}
const MEDIA_PYTHON = fromEnv('MEDIA_PYTHON') || runtimePath('media', OCR_PYTHON)
const MEDIA_SCRIPT = fromEnv('MEDIA_SCRIPT') || path.join(OCR_ROOT, 'media_runner.py')
function mediaDeepReaderAvailable() {
  const python = fromEnv('MEDIA_PYTHON') || MEDIA_PYTHON
  return fs.existsSync(python) && fs.existsSync(fromEnv('MEDIA_SCRIPT') || MEDIA_SCRIPT) && pythonModuleAvailable(python, 'faster_whisper')
}
function extractMedia(filePath) {
  if (!commandExists('ffprobe')) throw new Error('Media parser unavailable: ffprobe not found')
  if (mediaDeepReaderAvailable()) {
    const python = fromEnv('MEDIA_PYTHON') || MEDIA_PYTHON; const script = fromEnv('MEDIA_SCRIPT') || MEDIA_SCRIPT
    const result = spawnSync(python, [script, '--input', filePath, '--json'], { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024, windowsHide: true, timeout: Math.min(Math.max(Number(fromEnv('MEDIA_TIMEOUT_MS')) || 900000, 30000), 3600000), env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
    if (result.error) throw new Error(`Media deep reader launch failed: ${result.error.message}`)
    if (result.status !== 0) throw new Error(`Media deep reader failed: ${String(result.stderr || result.stdout || '').trim()}`)
    let payload; try { payload = JSON.parse(String(result.stdout || '').trim()) } catch { throw new Error('Media deep reader returned invalid JSON') }
    return { text: String(payload.text || '').trim(), coverage: payload.coverage || {}, parser: payload.parser || 'local-video-deep-reader', warnings: payload.warnings || [], metadata: payload.metadata || {} }
  }
  const result = spawnSync('ffprobe', ['-v','error','-show_entries','format=filename,format_name,duration,size,bit_rate:stream=index,codec_name,codec_type,width,height,sample_rate,channels','-of','json',filePath], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, windowsHide: true, timeout: 60000 })
  if (result.status !== 0) throw new Error(`ffprobe failed: ${String(result.stderr || '').trim()}`)
  const metadata = JSON.parse(result.stdout || '{}')
  return { text: JSON.stringify(metadata, null, 2), coverage: { streams: metadata.streams?.length || 0, asrSegments: 0, keyframes: 0 }, parser: 'ffprobe-metadata-only', metadata, warnings: ['Local ASR/keyframe reader is not installed; metadata only.'] }
}
function extractTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase(); const decoded = decodeText(fs.readFileSync(filePath)); let text = decoded.text
  if (ext === '.html' || ext === '.htm' || ext === '.xml') text = stripHtml(text)
  else if (ext === '.rtf') text = text.replace(/\\'[0-9a-f]{2}/gi, '').replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '')
  return { text: text.replace(/\r/g, ''), coverage: { encoding: decoded.encoding }, parser: `text-${decoded.encoding}` }
}
async function extractZip(filePath) {
  const zip = await loadBoundedZip(filePath); const chunks = []; let total = 0; let entries = 0; const warnings = []
  for (const name of Object.keys(zip.files).sort()) {
    const entry = zip.files[name]
    if (entry.dir || entries >= MAX_ARCHIVE_ENTRIES) continue
    const ext = path.extname(name).toLowerCase()
    if (!TEXT_EXTENSIONS.has(ext)) continue
    const buffer = await entry.async('nodebuffer')
    if (buffer.length > MAX_ARCHIVE_ENTRY_BYTES || total + buffer.length > MAX_ARCHIVE_TOTAL_BYTES) { warnings.push(`Skipped oversized archive entry: ${name}`); continue }
    total += buffer.length; entries += 1; const decoded = decodeText(buffer)
    const text = ['.html','.htm','.xml'].includes(ext) ? stripHtml(decoded.text) : decoded.text.replace(/\r/g, '')
    chunks.push(`## ${name}\n${text.trim()}`)
  }
  return { text: chunks.join('\n\n'), coverage: { entriesParsed: entries, uncompressedBytes: total }, parser: 'zip-safe-text', warnings }
}
async function extractByKind(filePath, kind) {
  if (kind === 'pdf') return extractPdf(filePath)
  if (kind === 'doc') return extractDoc(filePath)
  if (kind === 'docx') return extractDocx(filePath)
  if (kind === 'spreadsheet') return extractSpreadsheet(filePath)
  if (kind === 'pptx') return extractPptx(filePath)
  if (kind === 'odt' || kind === 'odp') return extractXmlPackage(filePath, [/^content\.xml$/i], `${kind}-xml`)
  if (kind === 'epub') return extractXmlPackage(filePath, [/\.x?html$/i, /\.opf$/i, /\.ncx$/i], 'epub-html')
  if (kind === 'text') return extractTextFile(filePath)
  if (kind === 'image') return extractImage(filePath)
  if (kind === 'media') return extractMedia(filePath)
  if (kind === 'zip') return extractZip(filePath)
  throw new Error(`Unsupported local file type: ${path.extname(filePath).toLowerCase() || '[no extension]'}`)
}
function textChunk(text, requestedOffset, requestedMax) {
  let start = Math.min(Math.max(Number(requestedOffset) || 0, 0), text.length)
  if (start > 0 && start < text.length && /[\uDC00-\uDFFF]/.test(text[start]) && /[\uD800-\uDBFF]/.test(text[start - 1])) start -= 1
  let end = Math.min(start + Math.max(Number(requestedMax) || 1, 1), text.length)
  if (end < text.length && end > start && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end -= 1
  return { start, end, text: text.slice(start, end) }
}
async function extractLocalFile(filePath, roots, options = {}) {
  if (!isWithinAllowedRoots(filePath, roots)) throw new Error('Path is outside allowlisted local WeChat roots')
  const stat = safeStat(filePath)
  if (!stat?.isFile()) throw new Error('Local file not found')
  if (stat.size > 256 * 1024 * 1024) throw new Error('文件超过 256 MB，请先在本机拆分后读取')
  const kind = detectFileKind(filePath); const extracted = await extractByKind(filePath, kind)
  const hasher = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(filePath)) hasher.update(chunk)
  const hash = hasher.digest('hex')
  const maxChars = Math.min(Math.max(Number(options.max_chars) || DEFAULT_MAX_TEXT, 1), 1000000); const text = String(extracted.text || '')
  const chunk = textChunk(text, options.offset_chars, maxChars)
  return { sourcePath: path.resolve(filePath).replace(/\\/g, '/'), fileName: path.basename(filePath), extension: path.extname(filePath).toLowerCase(), kind,
    sha256: hash, size: stat.size, modifiedAt: stat.mtime.toISOString(), parser: extracted.parser || kind, text: chunk.text, truncated: chunk.end < text.length, originalChars: text.length, returnedChars: chunk.text.length, offsetChars: chunk.start, nextOffset: chunk.end < text.length ? chunk.end : null, originalCodePoints: Array.from(text).length, returnedCodePoints: Array.from(chunk.text).length, coverage: extracted.coverage || {}, metadata: extracted.metadata, warnings: [...(extracted.warnings || []), ...(text ? [] : ['No readable text extracted'])] }
}
async function searchLocalFiles(keyword, roots, options = {}) {
  if (!keyword) throw new Error('keyword is required')
  const { keyword: _filenameKeyword, ...fileOptions } = options
  const candidateLimit = Math.min(Number(options.scan_limit) || 500, 2000)
  const listing = walkFilesDetailed(roots, { ...fileOptions, keyword: '', limit: candidateLimit })
  const candidates = listing.files
  const results = []; const failures = []; const truncatedFiles = []; let scanned = 0; const needle = keyword.toLowerCase()
  const perFileBudget = Math.min(Math.max(Number(options.max_chars_per_file) || 1000000, 1), 1000000)
  const resultLimit = Math.min(Number(options.limit) || 50, 200)
  for (const candidate of candidates) {
    if (results.length >= resultLimit) break
    scanned += 1
    if (!['text', 'ocr', 'metadata'].includes(candidate.parseSupport)) {
      failures.push({ fileName: candidate.fileName, parseSupport: candidate.parseSupport, warning: '未搜索：对应正文解析器不可用或文件格式不支持。' })
      continue
    }
    try {
      const extracted = await extractLocalFile(candidate.sourcePath, roots, { max_chars: perFileBudget, offset_chars: 0 })
      if (extracted.truncated) truncatedFiles.push({ fileName: extracted.fileName, originalChars: extracted.originalChars, scannedChars: extracted.offsetChars + extracted.returnedChars, nextOffset: extracted.nextOffset })
      const index = extracted.text.toLowerCase().indexOf(needle)
      if (index < 0) continue
      const start = Math.max(0, index - 200)
      results.push({ fileName: extracted.fileName, sourcePath: extracted.sourcePath, kind: extracted.kind, sha256: extracted.sha256, snippet: extracted.text.slice(start, index + keyword.length + 500), matchOffset: extracted.offsetChars + index, extractionTruncated: extracted.truncated, originalChars: extracted.originalChars })
    } catch (error) { failures.push({ fileName: candidate.fileName, warning: error.message }) }
  }
  const resultLimitReached = results.length >= resultLimit && scanned < candidates.length
  const complete = scanned === candidates.length && failures.length === 0 && truncatedFiles.length === 0 && listing.coverage.complete && !resultLimitReached
  return { keyword, candidates: candidates.length, scanned, returned: results.length, results, failures, complete, partial: !complete, truncatedFiles, coverage: { files: listing.coverage, resultLimit, resultLimitReached }, boundary: '每个文件一次提取不超过100万字符，不再按20万字符分段，因此预算内的关键词不会被分块边界切开。解析器缺失或格式不支持的文件会列入failures并使结果partial；文件清单受scan_limit、目录遍历和limit约束，coverage标出未列出的文件；truncatedFiles列出已搜索但尚未扫描的尾部，用nextOffset交给extract_wechat_attachment_text继续读。' }
}
function parseMergedForwardSnippet(content) {
  const text = String(content || '').replace(/\u0008/g, '\n'); const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean); const title = lines.shift() || ''
  const messages = lines.map(line => { const split = line.indexOf(':'); return split > 0 ? { sender: line.slice(0, split).trim(), content: line.slice(split + 1).trim() } : { sender: '', content: line } })
  return { title, messages, rawText: text }
}
function getParserCapabilities() {
  const runtime = runtimeStatus()
  return { formats: ['txt','md','csv','tsv','json','jsonl','yaml','toml','ini','xml','html','rtf','srt','vtt','pdf','doc','docx','xls','xlsx','xlsm','ods','pptx','odt','odp','epub','zip','image-ocr','audio-asr','video-asr-keyframes-ocr'],
    engines: { pdftotext: commandExists('pdftotext'), antiword: commandExists('antiword'), legacyXls: legacyXlsAvailable(), highAccuracyOcr: highAccuracyOcrAvailable(), ffprobe: commandExists('ffprobe'), mediaDeepReader: mediaDeepReaderAvailable() },
    optionalRuntime: runtime,
    blockedFormats: legacyXlsAvailable() ? {} : { xls: 'Run npm run optional:local to probe an existing local xlrd runtime; no network install is performed.' },
    boundaries: ['Legacy XLS is parsed read-only with xlrd; VBA/macros are never executed and formulas are returned only as cached values.', 'Archives parse text-like entries only with entry and byte limits.', 'Audio/video uses local faster-whisper timed ASR plus full-timeline sampled keyframe OCR when the model is installed; otherwise it degrades explicitly to metadata/visual evidence.', 'Image OCR uses an isolated local RapidOCR user-provided ONNX runtime; scanned PDF OCR falls back to the same engine when installed.'] }
}
module.exports = { SUPPORTED_EXTENSIONS, resolveAccountDir, getAllowedRoots, isWithinAllowedRoots, walkFiles, walkFilesDetailed, extractLocalFile, searchLocalFiles, parseMergedForwardSnippet, parserSupport, stripXml, detectFileKind, getParserCapabilities }
