const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {createCandidateStore,decideVerification}=require('../article-candidates')
const {searchArticlesBatch}=require('../article-search')
test('候选账本去重、不降级已核验，账号不一致标为冲突',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yan-cand-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
 const store=createCandidateStore({baseDir:root})
 const hit={title:'测试','accountName':'目标号',searchLink:'https://weixin.sogou.com/link?url=dn9a',sources:[{query:'目标号',page:1}]}
 const first=store.upsert([hit],{run:{queries:['目标号'],remaining:[{query:'目标号',page:2,reason:'page_limit'}],partial:true,stopReason:'page_limit'}})
 const second=store.upsert([hit,{...hit,sources:[{query:'目标号 AI',page:1}]}])
 assert.equal(first.saved,1);assert.equal(second.saved,1);assert.equal(store.list().total,1)
 const id=first.candidateIds[0]
 store.update(id,{status:'verified',articleUrl:'https://mp.weixin.qq.com/s/example'})
 store.upsert([hit])
 assert.equal(store.list({status:'verified'}).total,1)
 const conflict=store.verify(id,{url:'https://mp.weixin.qq.com/s/example',account:{name:'其他号'},publishedAt:'2026-09-14T00:00:00.000Z',id:'a'.repeat(64)})
 assert.equal(conflict.status,'conflicting');assert.equal(conflict.accountName,'目标号')
 const again=store.verify(id,{url:'https://mp.weixin.qq.com/s/example',account:{name:'其他号'},id:'a'.repeat(64)})
 assert.equal(again.status,'conflicting')
 assert.equal(decideVerification({accountName:'目标号'},{account:{name:'目标号'}}).status,'verified')
 assert.equal(store.list().latestRun.remaining[0].page,2)
})
test('批量搜索结果可写入账本，验证码后仍保留已发现候选',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yan-batch-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
 const store=createCandidateStore({baseDir:root})
 const page=(title,next=true)=>`<ul class="news-list"><li><h3><a href="/link?url=${title}">${title}</a></h3><a class="all-time-y2">目标号</a></li></ul>${next?'<a id="sogou_next">下一页</a>':''}`
 let calls=0
 const r=await searchArticlesBatch({queries:['目标号 A','目标号 B'],max_pages:3},{sleep:async()=>{},fetcher:async()=>({buffer:Buffer.from(++calls===1?page('一'):'<body>请输入验证码</body>')})})
 const saved=store.upsert(r.results,{run:{queries:r.coverage.queries,stopReason:r.stopReason,partial:r.partial,remaining:r.remaining}})
 assert.equal(r.stopReason,'verification_required');assert.equal(saved.saved,1);assert.equal(store.list({status:'candidate'}).total,1)
})
