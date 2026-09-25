const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const OCR_ROOT = path.join(ROOT, 'ocr-runtime')
const MANIFEST = path.join(ROOT, '.local', 'optional-runtime.json')
const DEFAULT_VENV = path.join(OCR_ROOT, '.venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']))
const MODULES = { xls: ['xlrd'], ocr: ['rapidocr', 'pymupdf'], media: ['faster_whisper'] }
const ENV_KEYS = { xls: 'WXLENS_XLS_PYTHON', ocr: 'WXLENS_OCR_PYTHON', media: 'WXLENS_MEDIA_PYTHON' }
const probeCache = new Map()

function readManifest() {
  try {
    const value = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
    return value && typeof value === 'object' ? value : {}
  } catch { return {} }
}
function runtimePath(kind, fallback = DEFAULT_VENV) {
  const env = process.env[ENV_KEYS[kind]]
  return env || readManifest().interpreters?.[kind] || fallback
}
function pythonModuleAvailable(python, modules) {
  const list = Array.isArray(modules) ? modules : [modules]
  const key = `${python}\0${list.join(',')}`
  if (probeCache.has(key)) return probeCache.get(key)
  if (!python || !fs.existsSync(python)) { probeCache.set(key, false); return false }
  const code = "import importlib.util, sys; missing = [name for name in sys.argv[1:] if importlib.util.find_spec(name) is None]; raise SystemExit(1 if missing else 0)"
  const result = spawnSync(python, ['-c', code, ...list], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
  const available = result.status === 0
  probeCache.set(key, available)
  return available
}
function pythonProbe(spec, modules = []) {
  const code = "import importlib.util, sys; missing = [name for name in sys.argv[1:] if importlib.util.find_spec(name) is None]; print(sys.executable); raise SystemExit(1 if missing else 0)"
  const result = spawnSync(spec.command, [...(spec.args || []), '-c', code, ...modules], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
  const executable = String(result.stdout || '').trim().split(/\r?\n/).at(-1) || ''
  return { ok: result.status === 0, executable, error: String(result.stderr || '').trim().slice(0, 300) }
}
function candidateSpecs() {
  const specs = []
  for (const kind of ['xls', 'ocr', 'media']) {
    const configured = process.env[ENV_KEYS[kind]]
    if (configured) specs.push({ command: configured, args: [] })
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
function findLocalInterpreter(modules) {
  for (const spec of candidateSpecs()) {
    const result = pythonProbe(spec, modules)
    if (result.ok && result.executable) return result.executable
  }
  return ''
}
function localOnlyInstall() {
  const interpreters = {}
  const detected = {}
  for (const [kind, modules] of Object.entries(MODULES)) {
    const executable = findLocalInterpreter(modules)
    interpreters[kind] = executable || null
    detected[kind] = Boolean(executable)
  }
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true, mode: 0o700 })
  const manifest = { version: 1, mode: 'local-only', generatedAt: new Date().toISOString(), interpreters, detected, networkAccess: false }
  const temporary = `${MANIFEST}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temporary, MANIFEST)
  probeCache.clear()
  return { manifestPath: MANIFEST, ...manifest, note: '仅探测并启用本机已有解释器和模块；未运行pip、未下载模型或其他网络资源。' }
}
function runtimeStatus() {
  const manifest = readManifest()
  return {
    mode: manifest.mode || 'default',
    manifestPresent: fs.existsSync(MANIFEST),
    manifestPath: MANIFEST,
    interpreters: Object.fromEntries(Object.entries(MODULES).map(([kind, modules]) => {
      const python = runtimePath(kind)
      return [kind, { configured: Boolean(process.env[ENV_KEYS[kind]] || manifest.interpreters?.[kind]), exists: fs.existsSync(python), modules: pythonModuleAvailable(python, modules) }]
    })),
  }
}

module.exports = { MANIFEST, MODULES, runtimePath, pythonModuleAvailable, localOnlyInstall, runtimeStatus }
