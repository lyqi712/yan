const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createApiClient, launchDesktop, discoverWxlens } = require('../wxlens-runtime')
const { verifyInstaller } = require('../setup')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
const unreachable = () => Object.assign(new Error('fixture offline'), { code: 'WXLENS_UNREACHABLE' })

test('MCP并发首次查询只启动一次WxLens，之后复用现有服务', async () => {
  let ready = false, starts = 0
  const client = createApiClient({ readConfig: () => ({ autoStart: true }), discover: () => 'fixture/WxLens.exe', launch: async (_exe, background) => { assert.equal(background, true); starts++; await new Promise(r => setTimeout(r, 5)); ready = true }, request: async (api, params) => { if (!ready) throw unreachable(); return { api, params } } })
  const results = await Promise.all([client('/api/sessions', { kind: 'group' }), client('/api/messages', { session_id: 'g' })])
  assert.equal(starts, 1); assert.equal(results[0].params.kind, 'group'); assert.equal(results[1].params.session_id, 'g')
  await client('/api/sessions'); assert.equal(starts, 1)
})
test('关闭自动启动或上游业务错误时不启动程序，失败提供初始化入口', async () => {
  let starts = 0
  const common = { discover: () => 'fixture', launch: async () => { starts++ } }
  await assert.rejects(createApiClient({ ...common, readConfig: () => ({ autoStart: false }), request: async () => { throw unreachable() } })('/api/sessions'), /offline/)
  await assert.rejects(createApiClient({ ...common, readConfig: () => ({}), request: async () => { throw new Error('HTTP 503') } })('/api/sessions'), /503/)
  assert.equal(starts, 0)
  await assert.rejects(createApiClient({ readConfig: () => ({}), discover: () => '', request: async () => { throw unreachable() } })('/api/sessions'), /setup.cmd/)
  const timed = createApiClient({ ...common, startupTimeoutMs: 25, readConfig: () => ({}), request: async () => { throw unreachable() } })
  await assert.rejects(timed('/api/sessions'), /初始化/)
  await assert.rejects(timed('/api/sessions'), /首次使用/); assert.equal(starts, 1)
})
test('启动器不拼接shell命令、不继承Electron Node开关；自定义程序发现可用', async t => {
  let received
  const fakeSpawn = (...args) => { received = args; const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child }
  await launchDesktop('C:/Synthetic Folder/WxLens.exe', true, fakeSpawn)
  assert.deepEqual(received[1], ['--background']); assert.equal(received[2].shell, false); assert.equal(received[2].env.ELECTRON_RUN_AS_NODE, undefined)
  await assert.rejects(launchDesktop('missing', true, () => { const c = new EventEmitter(); queueMicrotask(() => c.emit('error', new Error('fixture'))); return c }), /启动失败/)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yan-launch-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'WxLens.exe'); fs.writeFileSync(file, 'synthetic, never executed')
  assert.equal(discoverWxlens({ wxlensExe: file }), file)
  await assert.rejects(verifyInstaller(file), /大小不匹配/)
})
test('实际MCP在上游离线时仍握手和发现工具，查询给出可读失败', { timeout: 15000 }, async t => {
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise(r => server.close(r))
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve(__dirname, '../server.js')], env: { ...process.env, WXLENS_HTTP_BASE_URL: `http://127.0.0.1:${port}`, WXLENS_AUTO_START: 'false' }, stderr: 'pipe' })
  const client = new Client({ name: 'yan-offline-fixture', version: '1.0.0' }); t.after(() => client.close())
  await client.connect(transport); assert.equal((await client.listTools()).tools.length, 26)
  const guide = await client.callTool({ name: 'yan_usage_guide', arguments: {} }); assert.notEqual(guide.isError, true)
  const result = await client.callTool({ name: 'list_sessions', arguments: { limit: 1 } }); assert.equal(result.isError, true); assert.match(result.content[0].text, /WxLens/)
})
