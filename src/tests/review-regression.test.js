const test=require('node:test')
const assert=require('node:assert/strict')
const {parseArticle,publicationTime}=require('../wechat-articles')
const {searchArticlesBatch}=require('../article-search')
const base='<h1 id="activity-name">合成文章</h1><div id="js_content">合成正文</div>'
test('F1: 脚本元数据只接受目标变量，不接受相似名字、对象属性、注释或文本',()=>{
 for(const script of ['var sct="1111111111"','var act="1111111111"','obj.ct="2222222222"','expect="3333333333"','var sbiz="FAKEBIZ"','// ct="1111111111"','/* ct="1111111111" */','var text=\'ct="1111111111"\'','const data={ct:"1111111111"}']){
  const a=parseArticle(base+`<script>${script}</script>`,'https://mp.weixin.qq.com/s/example');assert.equal(a.publishedAt,null,script);assert.equal(a.account.biz,null,script)
 }
 assert.equal(parseArticle(base+'<p>ct="1111111111"</p>','https://mp.weixin.qq.com/s/example').publishedAt,null)
 for(const script of ['var ct="1789370000"; var biz="ABC123==";','let ct="1789370000"; const biz="ABC123==";','ct="1789370000";biz="ABC123==";']){
  const a=parseArticle(base+`<script>${script}</script>`,'https://mp.weixin.qq.com/s/example');assert.equal(a.publishedAt,'2026-09-14T07:13:20.000Z');assert.equal(a.account.biz,'ABC123==');assert.ok(a.warnings.some(w=>w.includes('脚本字面量')))
 }
 assert.equal(parseArticle(base+'<script>var biz="fake"; var ct="1111111111"</script>','https://mp.weixin.qq.com/s/example').account.biz,null)
})
test('日期不允许被JavaScript自动归一化为另一天',()=>{
 assert.equal(publicationTime('2026年2月31日 12:00'),null)
 assert.equal(publicationTime('2026-09-14T24:00:00+08:00'),null)
 assert.equal(publicationTime('2024年2月29日 12:00'),'2024-02-29T04:00:00.000Z')
})
const page=(title='标题',next=true)=>`<ul class="news-list"><li><h3><a href="/link?url=${title}">${title}</a></h3><a class="all-time-y2">合成号</a></li></ul>${next?'<a id="sogou_next">下一页</a>':''}`
test('F2: days不是搜狗过滤参数，必须在任何请求前拒绝',async()=>{
 let calls=0;await assert.rejects(searchArticlesBatch({query:'合成号',days:7},{fetcher:async()=>{calls++;return {buffer:Buffer.from(page())}}}),/days/);assert.equal(calls,0)
})
test('F3: 验证码终止整个批次，已获取候选保留且未完成范围可见',async()=>{
 let calls=0;const delays=[];const r=await searchArticlesBatch({queries:['合成号 A','合成号 B'],max_pages:3},{sleep:async ms=>delays.push(ms),fetcher:async()=>({buffer:Buffer.from(++calls===1?page():'<body>请输入验证码</body>')})})
 assert.equal(calls,2);assert.equal(r.results.length,1);assert.equal(r.partial,true);assert.equal(r.stopReason,'verification_required');assert.ok(r.remaining.length>0);assert.equal(delays.length,1);assert.ok(delays[0]>=1000)
})
test('F3: HTTP429立即停止，普通网络失败跳过该查询剩余页',async()=>{
 let calls=0;const r=await searchArticlesBatch({queries:['A','B'],max_pages:10},{sleep:async()=>{},fetcher:async()=>{calls++;throw Object.assign(new Error('limited'),{code:'RATE_LIMITED',status:429})}})
 assert.equal(calls,1);assert.equal(r.stopReason,'rate_limited')
 calls=0;const s=await searchArticlesBatch({queries:['A','B'],max_pages:3},{sleep:async()=>{},fetcher:async()=>{if(++calls===1)throw new Error('network');return {buffer:Buffer.from(page('b',false))}}})
 assert.equal(calls,2);assert.equal(s.failures.length,1);assert.equal(s.partial,true)
})
