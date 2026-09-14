const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { randomUUID, createHash } = require('node:crypto')
const JSZip = require('jszip')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
const { request } = require('../http-client')
const { validateArchive } = require('../bounded-zip')
const { buildExportPackage } = require('../export-package')
const { classifyAndSynthesize } = require('../record-pipeline')
async function fixture(t, handler) {
  const server = http.createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() }); return `http://127.0.0.1:${server.address().port}`
}
test('真实stdio MCP握手、发现37工具/4提示词/资源并调用跨群提取', { timeout: 20000 }, async t => {
  const base = await fixture(t, (req, res) => {
    const url = new URL(req.url, 'http://fixture'); let data = {}
    if (url.pathname === '/api/messages') data = { messages: Number(url.searchParams.get('offset')) ? [] : [{ localId: 1, timestamp: 100, senderId: 'person-a', senderName: '虚构人物', content: '周五验收', type: 1 }] }
    if (url.pathname === '/api/sessions') data = [{ id: 'synthetic-group', name: '虚构群聊' }]
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, data }))
  })
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve(__dirname, '../server.js')], env: { ...process.env, WXLENS_HTTP_BASE_URL: base, WXLENS_ACCOUNT_DIR: '', WXLENS_AUTO_START: 'false' }, stderr: 'pipe' })
  const client = new Client({ name: 'yan-acceptance', version: '1.0.0' }); t.after(() => client.close()); await client.connect(transport)
  const tools = (await client.listTools()).tools; assert.equal(tools.length, 37)
  assert.equal(tools.find(tool => tool.name === 'configure_watchlist').annotations.readOnlyHint, false)
  assert.equal((await client.listPrompts()).prompts.length, 4); assert.equal((await client.listResources()).resources[0].uri, 'yan://guide')
  assert.match((await client.readResource({ uri: 'yan://guide' })).contents[0].text, /人物/)
  const response = await client.callTool({ name: 'extract_person_messages', arguments: { session_ids: ['synthetic-group'], sender_ids: ['person-a'] } })
  assert.equal(response.isError, undefined); const data = JSON.parse(response.content[0].text)
  assert.equal(data.totalReturned, 1); assert.equal(data.sessions[0].messages[0].sourceRef.sessionId, 'synthetic-group')
  const invalid = await client.callTool({ name: 'get_recent_messages', arguments: { session_id: 'g', limit: 0 } }); assert.equal(invalid.isError, true)
})
test('上游挂起能超时、重定向不跟随、错误不泄露上游正文', { timeout: 10000 }, async t => {
  let hits = 0
  const target = await fixture(t, (_req, res) => { hits += 1; res.end('{}') })
  const base = await fixture(t, (req, res) => {
    if (req.url === '/api/redirect') { res.writeHead(302, { Location: target }); res.end(); return }
    if (req.url === '/api/error') { res.end(JSON.stringify({ ok: false, error: 'synthetic-secret-do-not-echo' })); return }
  })
  const config = { baseUrl: base, requestTimeoutMs: 500 }
  await assert.rejects(request('/api/slow', {}, { config }), /超时/)
  await assert.rejects(request('/api/redirect', {}, { config })); assert.equal(hits, 0)
  await assert.rejects(request('/api/error', {}, { config }), error => !error.message.includes('synthetic-secret'))
})
test('压缩包展开大小在解析前被拒绝', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yan-zip-')); t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const zip = new JSZip(); zip.file('large.txt', 'a'.repeat(10 * 1024 * 1024 + 1)); const file = path.join(temp, 'input.zip'); fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  await assert.rejects(validateArchive(file), /limit|exceed|超|10|large/i)
})
test('导出保留raw/selected/noise分账，README和正文哈希真实一致，隐私声明不夸大', async t => {
  const output = path.resolve(__dirname, '../../output', 'test-' + randomUUID()); t.after(() => fs.rmSync(output, { recursive: true, force: true }))
  const rows = [{ localId: 1, sessionId: 'g', timestamp: 100, content: '决定周五测试：C:/synthetic/private.txt', senderId: 'wxid_synthetic123', type: 1 }, { localId: 2, timestamp: 101, content: '谢谢', type: 1 }]
  const result = await buildExportPackage({ outputDir: output, session: { name: '合成群' }, pagination: { complete: true }, rawMessages: rows, synthesis: classifyAndSynthesize(rows) })
  const zip = await JSZip.loadAsync(fs.readFileSync(result.zipPath), { checkCRC32: true })
  const manifest = JSON.parse(await zip.file('manifest.json').async('text')); assert.equal(manifest.privacy.redactionCoverage, 'partial'); assert.equal(manifest.privacy.requiresReviewBeforeSharing, true)
  assert.ok(manifest.files.some(f => f.path === 'README.md'))
  for (const f of manifest.files) assert.equal(createHash('sha256').update(await zip.file(f.path).async('nodebuffer')).digest('hex'), f.sha256)
  assert.equal(result.integrity.contentHashesChecked, true); assert.equal(manifest.counts.rawMessages, manifest.counts.selectedMessages + manifest.counts.noiseMessages)
})
