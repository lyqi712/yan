const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const OCR_ROOT = path.join(ROOT, 'ocr-runtime')
const MANIFEST = path.join(ROOT, '.local', 'optional-runtime.json')
const DEFAULT_VENV = path.join(OCR_ROOT, '.venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']))
const MODULES = { xls: ['xlrd'], ocr: ['rapidocr', 'pymupdf'], media: ['faster_whisper'] }
const { preferEnv } = require('./config')
const ENV_SUFFIX = { xls: 'XLS_PYTHON', ocr: 'OCR_PYTHON', media: 'MEDIA_PYTHON' }
function configuredPython(kind) { return preferEnv(process.env, ENV_SUFFIX[kind]) }
function readManifest(file = MANIFEST) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return value && typeof value === 'object' ? value : {}
  } catch { return {} }
}
function runtimePath(kind, fallback = DEFAULT_VENV) {
  const env = configuredPython(kind)
  return env || readManifest().interpreters?.[kind] || fallback
}
function createModuleProbe(options = {}) {
  const cache = new Map()
  const now = options.now || Date.now
  const exists = options.exists || fs.existsSync
  const run = options.spawn || spawnSync
  const probe = (python, modules) => {
    const list = Array.isArray(modules) ? modules : [modules]
    const key = `${python}\0${list.join(',')}`
    if (!python || !exists(python)) { cache.delete(key); return false }
    const cached = cache.get(key)
    if (cached && cached.expiresAt > now()) return cached.available
    const code = "import importlib, sys; [importlib.import_module(name) for name in sys.argv[1:]]"
    const result = run(python, ['-c', code, ...list], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    const available = result.status === 0
    cache.set(key, { available, expiresAt: now() + (options.ttlMs ?? 30000) })
    return available
  }
  probe.clear = () => cache.clear()
  return probe
}
const pythonModuleAvailable = createModuleProbe()
function pythonProbe(spec, modules = []) {
  const code = "import importlib, sys; [importlib.import_module(name) for name in sys.argv[1:]]; print(sys.executable)"
  const result = spawnSync(spec.command, [...(spec.args || []), '-c', code, ...modules], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
  const executable = String(result.stdout || '').trim().split(/\r?\n/).at(-1) || ''
  return { ok: result.status === 0, executable, error: String(result.stderr || '').trim().slice(0, 300) }
}
function candidateSpecs(manifest = readManifest(), env = process.env) {
  const specs = []
  for (const kind of ['xls', 'ocr', 'media']) {
    const configured = preferEnv(env, ENV_SUFFIX[kind])
    if (configured) specs.push({ command: configured, args: [] })
    const saved = manifest.interpreters?.[kind]
    if (typeof saved === 'string' && path.isAbsolute(saved)) specs.push({ command: saved, args: [] })
  }
  specs.push({ command: DEFAULT_VENV, args: [] })
  if (process.platform === 'win32') specs.push({ command: 'py', args: ['-3.11'] })
  specs.push({ command: process.platform === 'win32' ? 'python' : 'python3', args: [] })
  specs.push({ command: 'python', args: [] })
  const seen = new Set()
  return specs.filter(spec => {
    const key = `${spec.command}\0${(spec.args || []).join('\0')}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
function findLocalInterpreter(modules, candidates = candidateSpecs()) {
  for (const spec of candidates) {
    const result = pythonProbe(spec, modules)
    if (result.ok && result.executable) return result.executable
  }
  return ''
}
const LOCAL_TOOLS = ['pdftotext', 'antiword', 'ffprobe']
function findToolOnPath(command) {
  const probe = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { encoding: 'utf8', windowsHide: true, timeout: 3000 })
  if (probe.status !== 0) return ''
  return String(probe.stdout || '').split(/\r?\n/).map(value => value.trim()).find(value => path.isAbsolute(value) && isToolFile(value)) || ''
}
function isToolFile(value) {
  try { return fs.statSync(value).isFile() } catch { return false }
}
function resolveLocalTool(command, manifest = readManifest(), find = findToolOnPath) {
  if (!LOCAL_TOOLS.includes(command)) return ''
  const saved = manifest.tools?.[command]
  if (typeof saved === 'string' && path.isAbsolute(saved) && isToolFile(saved)) return saved
  return find(command)
}
function localOnlyInstall(options = {}) {
  const manifestPath = options.manifestPath || MANIFEST
  const previous = readManifest(manifestPath)
  const interpreters = {}
  const detected = {}
  for (const [kind, modules] of Object.entries(MODULES)) {
    const executable = (options.findInterpreter || findLocalInterpreter)(modules, candidateSpecs(previous))
    const saved = previous.interpreters?.[kind]
    const retained = typeof saved === 'string' && path.isAbsolute(saved) && isToolFile(saved) ? saved : null
    interpreters[kind] = executable || retained
    detected[kind] = Boolean(executable)
  }
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true, mode: 0o700 })
  const tools = Object.fromEntries(LOCAL_TOOLS.map(command => [command, (options.findTool || resolveLocalTool)(command, previous) || null]))
  const manifest = { version: 1, mode: 'local-only', generatedAt: new Date().toISOString(), interpreters, tools, detected, networkAccess: false }
  const temporary = `${manifestPath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temporary, manifestPath)
  pythonModuleAvailable.clear()
  return { manifestPath, ...manifest, note: '仅探测并启用本机已有解释器和模块；未运行pip、未下载模型或其他网络资源。探测暂时失败时保留仍存在的已配置解释器，detected仍如实报告本轮结果。' }
}
function runtimeStatus() {
  const manifest = readManifest()
  return {
    mode: manifest.mode || 'default',
    manifestPresent: fs.existsSync(MANIFEST),
    manifestPath: MANIFEST,
    interpreters: Object.fromEntries(Object.entries(MODULES).map(([kind, modules]) => {
      const python = runtimePath(kind)
      return [kind, { configured: Boolean(configuredPython(kind) || manifest.interpreters?.[kind]), exists: fs.existsSync(python), modules: pythonModuleAvailable(python, modules) }]
    })),
  }
}

module.exports = { MANIFEST, MODULES, runtimePath, pythonModuleAvailable, localOnlyInstall, runtimeStatus, resolveLocalTool, candidateSpecs, createModuleProbe }
