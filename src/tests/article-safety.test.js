const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {readLocalImage}=require('../image-content')
const {createArticleStore,filterArticleHistory}=require('../wechat-articles')
const {parseSearch,searchArticles,searchArticlesBatch}=require('../article-search')
const {searchTencent,signedRequest,parseResponse}=require('../tencent-search')
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ZkAAAAASUVORK5CYII=','base64')
test('读取图片前核对已打开文件身份，拒绝检查后被替换的目标',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yan-race-')),inside=path.join(root,'in.png'),other=path.join(root,'other.png');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.writeFileSync(inside,png);fs.writeFileSync(other,png)
 assert.deepEqual(readLocalImage(inside,[root]),png)
 if(process.platform==='win32'){t.skip('Windows没有POSIX O_NOFOLLOW；junction边界由既有跨平台回归覆盖');return}
 const original=fs.openSync;t.mock.method(fs,'openSync',function(p,...args){return original(p===inside?other:p,...args)})
 assert.throws(()=>readLocalImage(inside,[root]),/变化/)
})
test('文章存档完整性失败不冒充保存成功；快照选择与输入顺序无关',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yan-store-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const store=createArticleStore({baseDir:root}),url='https://mp.weixin.qq.com/s/test',html='<h1 id="activity-name">测试</h1><a id="js_name">测试号</a><div id="js_content">正文</div>'
 const a=await store.importHtml({url,html}),b=await store.importHtml({url,html});assert.equal(a.savedAt,b.savedAt)
 const files=fs.readdirSync(path.join(root,'articles'));assert.equal(files.length,1);fs.writeFileSync(path.join(root,'articles',`${a.id}.json`),'{}');assert.throws(()=>store.get(a.id),/完整性/);await assert.rejects(store.importHtml({url,html}),/完整性/)
 const old={...a,publishedAt:'2026-09-13T00:00:00Z',savedAt:'2026-09-13T12:00:00Z'},fresh={...a,id:'b',publishedAt:'2026-09-14T00:00:00Z',savedAt:'2026-09-14T12:00:00Z'}
 for(const rows of [[old,fresh],[fresh,old]]){const h=filterArticleHistory(rows,{account_name:'测试号'});assert.equal(h.articles[0].id,'b');assert.equal(h.snapshots[0].publicationConflict,true)}
})
test('搜狗检索保留来源边界，过滤账号冒名候选，验证码不当空列表',async()=>{
 const html='<ul class="news-list"><li><h3><a href="/link?url=test">测试</a></h3><a class="all-time-y2">目标号</a><span class="s2"><script>timeConvert("1789370000")</script></span></li><li><h3><a href="https://evil.example/">越界</a></h3></li></ul>'
 const r=parseSearch(html,{query:'测试',account_name:'目标号'});assert.equal(r.results.length,1);assert.equal(r.coverage.completeAccountHistory,false);assert.equal(parseSearch(html,{query:'测试',account_name:'其他号'}).results.length,0)
 assert.throws(()=>parseSearch('<body>请输入验证码</body>',{query:'测试'}),/验证/)
 const batch=await searchArticlesBatch({account_name:'目标号',queries:['目标号 AI','目标号'],max_pages:2},{fetcher:async(url)=>({buffer:Buffer.from(html),contentType:'text/html'})});assert.equal(batch.results.length,1);assert.equal(batch.results[0].sources.length,2);assert.equal(batch.coverage.completeAccountHistory,false)
 await assert.rejects(searchArticles({query:'测试',start_time:2,end_time:1}),/开始时间/)
})
test('腾讯搜索默认不联网，明确启用才签名；凭据不进入结果，非微信结果剔除',async()=>{
 let called=0;await assert.rejects(searchTencent({query:'测试'},{env:{},transport:()=>{called++}}),/默认关闭/);assert.equal(called,0)
 const env={YAN_TENCENT_SEARCH_ENABLED:'true',TENCENTCLOUD_SECRET_ID:'SYNTHETIC_ID',TENCENTCLOUD_SECRET_KEY:'SYNTHETIC_KEY'}
 const r=await searchTencent({query:'示例号',days:2},{env,timestamp:1789370000,transport:async req=>{called++;assert.deepEqual(JSON.parse(req.body),{Query:'示例号',Site:'mp.weixin.qq.com',Freshness:'d2'});assert.match(req.headers.Authorization,/SignedHeaders=content-type;host, Signature=[0-9a-f]{64}$/);assert.ok(!req.body.includes('SYNTHETIC'));return {Response:{Version:'standard',Pages:[JSON.stringify({title:'测试',url:'https://mp.weixin.qq.com/s/test',pics:[{origin_url:'https://mmbiz.qpic.cn/mmbiz_png/a/640'}]}),JSON.stringify({url:'https://evil.example/'})]}}}})
 assert.equal(called,1);assert.equal(r.results.length,1);assert.equal(r.failures.length,1);assert.ok(!JSON.stringify(r).includes('SYNTHETIC'));assert.equal(r.coverage.completeAccountHistory,false)
 assert.throws(()=>parseResponse({Response:{Error:{Code:'AuthFailure',Message:'SYNTHETIC_KEY'}}}),e=>!e.message.includes('SYNTHETIC_KEY'))
 const s=signedRequest({Query:'a'},{secretId:'fake',secretKey:'fake'},1789370000);assert.equal(s.headers['X-TC-Version'],'2025-05-08')
})
