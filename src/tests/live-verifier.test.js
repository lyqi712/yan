const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const exec = promisify(execFile)

test('验收命令默认不读会话，显式查询只读2会话和1消息且不输出正文', async t => {
  const requests = []
  let incomplete = false
  const server = http.createServer((req,res) => {
    const url = new URL(req.url, 'http://fixture')
    requests.push(url)
    let data = {}
    if (url.pathname === '/api/status') data = { connected: true, queryReady: true }
    if (url.pathname === '/api/sessions') data = [{ sessionId:'synthetic-private-id',name:'synthetic-private-name' }]
    if (url.pathname === '/api/messages') data = {messages:[{localId:1,type:1,content:'synthetic-private-body',timestamp:100,contentTruncated:incomplete}]}
    res.setHeader('Content-Type','application/json')
    res.end(JSON.stringify({ok:true,data}))
  })
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const script = path.resolve(__dirname, '../../scripts/verify-live.cjs')
  const env = {...process.env,YAN_HTTP_BASE_URL:`http://127.0.0.1:${server.address().port}`,YAN_AUTO_START:'false',YAN_ACCOUNT_DIR:''}
  const first = await exec(process.execPath,[script],{env,timeout:15000,windowsHide:true})
  assert.equal(JSON.parse(first.stdout).ok,true)
  assert.equal(requests.some(url => ['/api/sessions','/api/messages'].includes(url.pathname)),false)
  requests.length = 0
  const second = await exec(process.execPath,[script,'--query','--messages'],{env,timeout:15000,windowsHide:true})
  const report = JSON.parse(second.stdout)
  assert.equal(report.sessionsVerified,true)
  assert.equal(report.messagesVerified,true)
  assert.equal(requests.find(url => url.pathname === '/api/sessions').searchParams.get('limit'),'2')
  assert.equal(requests.find(url => url.pathname === '/api/messages').searchParams.get('limit'),'1')
  assert.doesNotMatch(second.stdout,/synthetic-private/)
  incomplete = true
  await assert.rejects(exec(process.execPath,[script,'--query','--messages'],{env,timeout:15000,windowsHide:true}), error => {
    const failed = JSON.parse(error.stdout)
    assert.equal(failed.ok,false)
    assert.equal(failed.messagesVerified,false)
    assert.doesNotMatch(error.stdout,/synthetic-private/)
    return error.code === 1
  })
})
