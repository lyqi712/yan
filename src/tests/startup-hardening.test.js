const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { createApiClient } = require('../yan-runtime')
const { request } = require('../http-client')
const offline = () => Object.assign(new Error('offline'), { code:'YAN_UNREACHABLE' })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return {promise,resolve} }

test('迟到的旧离线响应复用已完成的启动，不重复启动', async () => {
  let starts = 0, a = 0, b = 0
  const release = deferred()
  const api = createApiClient({ readConfig:()=>({autoStart:true}), discover:()=> 'fixture.exe', launch:async()=>{starts++}, request:async endpoint => {
    if (endpoint === '/api/a' && ++a === 1) throw offline()
    if (endpoint === '/api/b' && ++b === 1) { await release.promise; throw offline() }
    if (endpoint === '/api/status') return {connected:true,queryReady:true}
    return []
  } })
  const first = api('/api/a'), second = api('/api/b')
  await first; release.resolve(); await second
  assert.equal(starts,1)
})

test('启动就绪后业务重试仍离线时保留冷却，避免连续启动', async () => {
  let starts = 0
  const api = createApiClient({ readConfig:()=>({autoStart:true}), discover:()=> 'fixture.exe', launch:async()=>{starts++}, request:async endpoint => {
    if (endpoint === '/api/health') return {status:'ok'}
    if (endpoint === '/api/status') return {connected:true,queryReady:true}
    throw offline()
  } })
  for (let i=0;i<3;i++) await assert.rejects(api('/api/sessions'),{code:'YAN_UNREACHABLE'})
  assert.equal(starts,1)
})

for (const endpoint of ['/api/health','/api/status']) for (const status of [401,403]) {
  test(`启动${endpoint}的HTTP ${status}保留分类并立即停止轮询`, async () => {
    let calls = 0
    const api = createApiClient({ readConfig:()=>({autoStart:true}), discover:()=> 'fixture.exe', launch:async()=>{}, startupTimeoutMs:50,pollIntervalMs:1, request:async api => {
      if (api === '/api/sessions') throw offline()
      if (api === endpoint) { calls++; throw Object.assign(new Error(`HTTP ${status}`),{code:'YAN_HTTP_ERROR',status}) }
      return {status:'ok'}
    } })
    await assert.rejects(api('/api/sessions'),{code:'YAN_HTTP_ERROR',status})
    assert.equal(calls,1)
  })
}

test('HTTP重定向不跟随、不误判离线、不触发后台启动', async t => {
  let starts=0, targetHits=0
  const server=http.createServer((req,res)=>{
    if(req.url.startsWith('/api/health')) return res.end(JSON.stringify({status:'ok'}))
    if(req.url.startsWith('/api/status')) return res.end(JSON.stringify({ok:true,data:{connected:true,queryReady:true}}))
    if(req.url.startsWith('/api/redirect-target')) {targetHits++;return res.end('{}')}
    res.writeHead(302,{Location:'/api/redirect-target'});res.end()
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>{server.closeAllConnections();server.close()})
  const api=createApiClient({readConfig:()=>({autoStart:true,baseUrl:`http://127.0.0.1:${server.address().port}`,requestTimeoutMs:1000}),request,discover:()=> 'fixture.exe',launch:async()=>{starts++}})
  await assert.rejects(api('/api/sessions'),{code:'YAN_HTTP_ERROR',status:302})
  assert.equal(starts,0)
  assert.equal(targetHits,0)
})


test('迟到请求保留该次启动认证失败，不用离线错误覆盖', async () => {
  let starts = 0
  const release = deferred()
  const auth = Object.assign(new Error('HTTP 401'), {code:'YAN_HTTP_ERROR',status:401})
  const api = createApiClient({readConfig:()=>({autoStart:true}),discover:()=> 'fixture.exe',launch:async()=>{starts++},request:async endpoint=>{
    if(endpoint === '/api/health') return {status:'ok'}
    if(endpoint === '/api/status') throw auth
    if(endpoint === '/api/b') await release.promise
    throw offline()
  }})
  const a=api('/api/a'),b=api('/api/b')
  await assert.rejects(a,{code:'YAN_HTTP_ERROR',status:401})
  release.resolve()
  await assert.rejects(b,{code:'YAN_HTTP_ERROR',status:401})
  await assert.rejects(api('/api/c'),{code:'YAN_HTTP_ERROR',status:401})
  assert.equal(starts,1)
})
