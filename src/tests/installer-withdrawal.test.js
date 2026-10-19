const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { verifyInstaller, INSTALLER } = require('../setup')
const { integrated } = require('../../scripts/package-integrated.cjs')

test('已报告失效的4.3.0安装器停止准入，改名或缺少文件也不能变成推荐安装', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yan-withdrawn-installer-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const name of [INSTALLER.name, INSTALLER.legacyName, 'renamed.exe']) {
    const file = path.join(root, name)
    fs.writeFileSync(file, 'synthetic, never executed')
    await assert.rejects(verifyInstaller(file), error => {
      assert.equal(error.code, 'YAN_INSTALLER_WITHDRAWN')
      assert.match(error.message, /4\.3\.0/)
      assert.match(error.message, /保留/)
      assert.match(error.message, /新组件|新构建/)
      return true
    })
  }
  await assert.rejects(verifyInstaller(path.join(root, 'missing.exe')), { code: 'YAN_INSTALLER_WITHDRAWN' })
})

test('整合包构建在读取或生成发行产物之前拒绝已撤回的安装器', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yan-withdrawn-build-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  await assert.rejects(integrated(root), { code: 'YAN_INSTALLER_WITHDRAWN' })
  assert.deepEqual(fs.readdirSync(root), [])
})

function setupHarness(executable) {
  const effects = { saved: [], spawned: 0, questions: [], logs: [], closed: 0 }
  const config = { yanExe: executable, autoStart: true }
  const state = { exports: {} }
  const dependencies = {
    './config': { ROOT: os.tmpdir(), readConfig: () => ({ ...config }), saveConfig: value => { effects.saved.push(value); return value }, renderMcpConfigs: () => ({ json: '{"mcpServers":{}}' }) },
    './yan-runtime': { discoverYan: () => executable, launchDesktop: async () => { effects.spawned++ } },
    'node:child_process': { spawn: () => { effects.spawned++; throw new Error('安装器不应执行') } },
    'node:readline/promises': { createInterface: () => ({ question: async text => { effects.questions.push(text); return 'n' }, close: () => { effects.closed++ } }) }
  }
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../setup.js'), 'utf8'), {
    require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name),
    module: state,
    process: { platform: 'win32', stdin: { isTTY: true }, stdout: {} },
    console: { log: text => effects.logs.push(text) }
  }, { filename: 'setup-withdrawal-fixture.js' })
  return { setup: state.exports.setup, effects }
}

test('首次设置缺少可用组件时在安装确认、执行和保存配置前停止', async () => {
  const { setup, effects } = setupHarness('')
  await assert.rejects(setup(), { code: 'YAN_INSTALLER_WITHDRAWN' })
  assert.equal(effects.spawned, 0)
  assert.equal(effects.saved.length, 0)
  assert.equal(effects.questions.length, 0)
  assert.equal(effects.closed, 1)
})

test('首次设置复用已有组件，不执行安装器或引导重复取钥', async () => {
  const executable = path.join(os.tmpdir(), 'yan-synthetic-existing-component.exe')
  const { setup, effects } = setupHarness(executable)
  await setup()
  assert.equal(effects.spawned, 0)
  assert.equal(effects.saved.length, 1)
  assert.equal(effects.saved[0].yanExe, executable)
  assert.equal(effects.questions.length, 1)
  assert.match(effects.questions[0], /检查服务状态/)
  assert.doesNotMatch(effects.questions[0], /登录|密钥|取钥/)
  assert.equal(effects.closed, 1)
})
