const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { parseArticle, createArticleStore, extractArticleLinks, filterArticleHistory } = require('../wechat-articles')
const { validateUrl, publicAddress, fetchPublic } = require('../public-web')
const { imageContent } = require('../image-content')
const { registerArticles } = require('../article-tools')
const url = 'https://mp.weixin.qq.com/s/example'
const html = '<h1 id="activity-name">示例文章</h1><a id="js_name">示例号</a><em id="publish_time">2026年9月14日 14:54</em><div id="js_content"><p>第一段 &amp; 证据</p><img data-src="https://mmbiz.qpic.cn/mmbiz_png/abc/640"/><p>第二段</p><script>bad()</script><img src="http://127.0.0.1/secret"/></div><script>var biz = "ABC123==";</script>'
test('公众号解析保留图文顺序、北京时间、身份和不支持图片边界，不执行网页脚本', () => {
 const a = parseArticle(html, url)
 assert.equal(a.title,'示例文章'); assert.equal(a.account.biz,'ABC123=='); assert.equal(a.identityStatus,'candidate'); assert.equal(a.publishedAt,'2026-09-14T06:54:00.000Z')
 assert.equal(a.images.length,1); assert.equal(a.coverage.skippedImages,1); assert.equal(a.coverage.partial,true)
 assert.ok(a.markdown.indexOf('第一段') < a.markdown.indexOf('![配图1]')); assert.ok(a.markdown.indexOf('![配图1]') < a.markdown.indexOf('第二段')); assert.ok(!a.markdown.includes('bad()'))
 assert.throws(()=>parseArticle('<div>环境异常 完成验证</div>',url), /验证|正文/)
})
test('公众号长正文和超过100张配图都完整保留，不按旧上限切片', () => {
 const body = `${'长文🙂'.repeat(70000)}结尾标记`
 const images = Array.from({ length: 101 }, (_, index) => `<img data-src="https://mmbiz.qpic.cn/mmbiz_png/abc/${index}"/>`).join('')
 const longHtml = `<h1 id="activity-name">长文</h1><div id="js_content"><p>${body}</p>${images}</div>`
 const article = parseArticle(longHtml, url)
 assert.ok(article.coverage.originalChars > 200000)
 assert.equal(article.coverage.textTruncated, false)
 assert.equal(article.coverage.returnedChars, article.coverage.originalChars)
 assert.equal(article.markdown.includes('结尾标记'), true)
 assert.equal(article.images.length, 101)
 assert.equal(article.coverage.imagesReturned, 101)
})
test('已保留的第101张配图序号可以通过读取和下载工具校验', () => {
 const schemas = {}
 registerArticles({ register: (name, _description, schema) => { schemas[name] = schema }, result: value => value, failure: error => error, request: async () => [], accountContext: () => ({ roots: [] }), store: {}, candidateStore: { upsert() {}, verify() {}, list() {}, update() {} } })
 assert.equal(schemas.read_article_image.image_index.safeParse(101).success, true)
 assert.equal(schemas.download_article_images.image_indices.safeParse([101]).success, true)
 assert.equal(schemas.download_article_images.image_indices.safeParse(Array.from({ length: 21 }, (_, index) => index + 1)).success, false)
})
test('公网地址与路径限制阻止SSRF、凭据、私网和非文章端点', async () => {
 for(const bad of ['https://mp.weixin.qq.com@127.0.0.1/s/a','https://mp.weixin.qq.com:444/s/a','http://mp.weixin.qq.com/s/a','https://mp.weixin.qq.com/cgi-bin/home','https://mp.weixin.qq.com/s/a?token=secret']) assert.throws(()=>validateUrl(bad,'article'))
 for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.1','::1','::ffff:127.0.0.1','fc00::1','2001:db8::1']) assert.equal(publicAddress(ip),false)
 assert.equal(publicAddress('8.8.8.8'),true)
 await assert.rejects(fetchPublic(url,'article',{lookup:async()=>[{address:'127.0.0.1',family:4}]}), /公网/)
})
test('MCP图片内容是有界原生image块，加密dat/HTML/过大像素拒绝', () => {
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ZkAAAAASUVORK5CYII=','base64')
 const image=imageContent(png); assert.equal(image.type,'image'); assert.equal(image.mimeType,'image/png'); assert.deepEqual(Buffer.from(image.data,'base64'),png)
 assert.throws(()=>imageContent(Buffer.from('<html>bad</html>')), /图片|格式/)
 assert.throws(()=>imageContent(Buffer.from([0x47,0x49,0x46,0x38,0x39,0x61,1,0,1,0,0,0,0])), /完整|格式/)
 const large=Buffer.from(png); large.writeUInt32BE(50000,16); assert.throws(()=>imageContent(large), /像素|尺寸/)
})
test('本地存档排他保存与历史范围：身份/发布时间/未知时间分开，不声称完整历史', async t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yan-articles-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
 const store=createArticleStore({baseDir:path.join(root,'output')}); const a=await store.importHtml({url,html})
 const b=await store.importHtml({url,html}); assert.equal(a.id,b.id)
 const saved=store.get(a.id); assert.equal(saved.provenance.method,'browser-snapshot'); assert.equal(saved.provenance.verifiedByServer,false)
 const history=filterArticleHistory([saved,{...saved,id:'other',account:{name:'示例号',biz:'OTHER'}},{...saved,id:'unknown',url:'https://mp.weixin.qq.com/s/unknown',publishedAt:null}],{account_biz:'ABC123==',start_time:1789228800,end_time:1789401600})
 assert.equal(history.articles.length,1); assert.equal(history.undated.length,1); assert.equal(history.coverage.completeAccountHistory,false)
 assert.throws(()=>store.get('../secret'),/ID/)
 const links=extractArticleLinks([{sessionId:'s',localId:1,content:'<url>https://mp.weixin.qq.com/s?__biz=ABC&amp;mid=123&amp;idx=1&amp;sn=xx</url>'},{sessionId:'s',localId:2,content:'https://mp.weixin.qq.com/s?__biz=ABC&mid=123&idx=1&sn=xx'}]); assert.equal(links.length,1);assert.equal(links[0].references.length,2)
})
module.exports = { html }
