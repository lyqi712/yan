const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { candidateSpecs, createModuleProbe, localOnlyInstall } = require('../optional-runtime')

test('换客户端后的本地探测包含已保存解释器，不依赖原终端PATH', () => {
  const saved = process.execPath
  assert.ok(candidateSpecs({ interpreters: { xls: saved } }, {}).some(spec => spec.command === saved))
})

test('探测暂时失败不擦除仍存在的已配置解释器', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yan-runtime-preserve-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const manifestPath = path.join(dir, 'runtime.json')
  fs.writeFileSync(manifestPath, JSON.stringify({ version:1,interpreters:{xls:process.execPath} }))
  const result = localOnlyInstall({ manifestPath, findInterpreter: () => '', findTool: () => '' })
  assert.equal(result.interpreters.xls, process.execPath)
  assert.equal(result.detected.xls, false)
  assert.equal(JSON.parse(fs.readFileSync(manifestPath)).interpreters.xls, process.execPath)
})

test('模块探测缓存到期后重新验证，安装或移除模块无需永久重启', () => {
  let now = 0, available = false, calls = 0
  const probe = createModuleProbe({ now: () => now, exists: () => true, spawn: () => { calls++; return {status:available ? 0 : 1} }, ttlMs:100 })
  assert.equal(probe('python', ['xlrd']), false)
  available = true
  assert.equal(probe('python', ['xlrd']), false)
  now = 101
  assert.equal(probe('python', ['xlrd']), true)
  available = false
  now = 202
  assert.equal(probe('python', ['xlrd']), false)
  assert.equal(calls, 3)
})

test('模块文件存在但导入失败时，不宣称解析器可加载', t => {
  const found = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import sys; print(sys.executable)'], {encoding:'utf8',timeout:5000,windowsHide:true})
  if (found.status !== 0) return t.skip('当前环境没有Python；其余合成探测测试仍运行')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yan-broken-module-'))
  t.after(() => fs.rmSync(dir, { recursive:true,force:true }))
  fs.writeFileSync(path.join(dir, 'yan_broken_fixture.py'), 'raise ImportError("synthetic native dependency unavailable")\n')
  const probe = createModuleProbe({spawn: (exe,args,opts) => spawnSync(exe,args,{...opts,env:{...process.env,PYTHONPATH:dir}})})
  assert.equal(probe(found.stdout.trim(), ['yan_broken_fixture']), false)
})
