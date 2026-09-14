const {z}=require('zod')
const {createArticleStore,extractArticleLinks,filterArticleHistory}=require('./wechat-articles')
const {imageContent,readLocalImage,imageInfo}=require('./image-content')
const {searchTencent}=require('./tencent-search')
const {searchArticles,searchArticlesBatch}=require('./article-search')
const {fetchMessageRange}=require('./record-pipeline')
function registerArticles({register,result,failure,request,accountContext,store=createArticleStore()}) {
 const id=z.string().regex(/^[a-f0-9]{64}$/),url=z.string().max(4096),time=z.number().int().nonnegative().optional()
 const safe=fn=>async p=>{try{return await fn(p)}catch(e){return failure(e)}}
 register('search_wechat_articles','通过搜狗公开微信索引发现文章候选，可按账号名称与搜索索引时间过滤；不保证完整历史。返回搜索跳转链接，由正常浏览器打开并核对文章。',{query:z.string().min(1).max(200),page:z.number().int().min(1).max(10).optional(),account_name:z.string().min(1).max(200).optional(),start_time:time,end_time:time},safe(async p=>result(await searchArticles(p))))
 register('search_wechat_articles_batch','高强度多轮发现公众号文章：对多个查询词和分页结果去重，保留每个候选的来源次数、运行记录和失败边界；结果仍需原文核验，不保证完整历史。',{account_name:z.string().min(1).max(200).optional(),query:z.string().min(1).max(200).optional(),queries:z.array(z.string().min(1).max(200)).max(5).optional(),max_pages:z.number().int().min(1).max(10).optional(),start_time:time,end_time:time},safe(async p=>result(await searchArticlesBatch(p))))
 register('search_wechat_articles_tencent','可选腾讯云WSA官方搜索：限定微信公众号域名和最近N天，返回候选URL及配图。需本人预先启用与安全配置凭据，可能按腾讯云服务收费；不保证公众号全量历史，不会从免费搜索自动切换。',{query:z.string().min(1).max(200),days:z.number().int().min(1).max(30).optional()},safe(async p=>result(await searchTencent(p))))
 register('fetch_wechat_article','联网读取公众号文章正文、配图清单与发布时间，并保存到本机文章库。遇验证/登录停止；不能用聊天卡片代替全文。',{url},safe(async p=>result(await store.fetchArticle(p))))
 register('import_wechat_article','导入本人或AI浏览器已正常打开的文章HTML（标题、账号、时间、#js_content）；不执行脚本、不索取Cookie。标记为调用方快照。可在HTTP要求验证后使用。',{url,html:z.string().min(1).max(4*1024*1024),partial:z.boolean().optional()},safe(async p=>result(await store.importHtml(p))))
 register('get_saved_article','读取本机文章库中的一篇正文和配图清单。',{article_id:id},safe(async p=>result(store.get(p.article_id))))
 register('read_article_image','读取已存档公众号文章的一张配图，返回原生MCP image块供支持视觉的模型理解；客户端是否展示取决于客户端。每次一张，最多4MiB。',{article_id:id,image_index:z.number().int().min(1).max(100)},safe(async p=>{const r=await store.image(p.article_id,p.image_index);return {content:[...result({...r.source,...r.info}).content,imageContent(r.buffer)]}}))
 register('download_article_images','下载已存档公众号文章配图到本机output/articles独占目录；返回逐图结果、SHA256和缺失范围，默认前12张。',{article_id:id,image_indices:z.array(z.number().int().min(1).max(100)).min(1).max(20).optional()},safe(async p=>result(await store.download(p.article_id,p.image_indices))))
 register('read_wechat_image','读取明确选定的本机微信标准图片，返回原生MCP image；只能使用本地附件白名单路径。加密DAT不解密，路径不证明会话归属。',{source_path:z.string().min(1).max(4096)},safe(async p=>{const {roots}=accountContext(),b=readLocalImage(p.source_path,roots);return {content:[...result({...imageInfo(b),boundary:'文件由调用方明确选定，未验证与特定聊天消息的归属。'}).content,imageContent(b)]}}))
 register('list_shared_articles','在指定会话有界分页扫描公众号文章链接，按URL去重并保留每条聊天引用；筛选时间是分享时间，不能当成文章发布时间。',{session_ids:z.array(z.string().min(1)).min(1).max(10),scan_limit:z.number().int().min(1).max(1000).optional(),offset:z.number().int().nonnegative().optional(),start_time:time,end_time:time},safe(async p=>{
  const messages=[],sessions=[]
  for(const session_id of [...new Set(p.session_ids)]){try{const page=await fetchMessageRange(params=>request('/api/messages',params),{session_id,limit:p.scan_limit||200,scan_limit:p.scan_limit||200,offset:p.offset,start_time:p.start_time,end_time:p.end_time});messages.push(...page.messages.map(m=>({...m,sessionId:session_id})));sessions.push({sessionId:session_id,pagination:page.pagination})}catch(e){sessions.push({sessionId:session_id,error:e.message})}}
  const links=extractArticleLinks(messages)
  return result({links,sessions,scannedMessages:messages.length,partial:sessions.some(s=>s.error||s.pagination?.hasMore||s.pagination?.complete===false),boundary:'仅覆盖指定会话与本次分页窗口，可能遗漏未暴露URL的分享卡片。用返回offset继续读取；再对URL调用fetch_wechat_article，不自动联网批量抓取。'})
 }))
 register('query_article_history','按公众号biz（优先）或名称、文章发布时间筛选本机已获取文章。仅为已收集历史，不是完整公众号历史爬取；未知时间单列。',{account_biz:z.string().min(1).max(300).optional(),account_name:z.string().min(1).max(200).optional(),start_time:time,end_time:time},safe(async p=>{const local=store.list(),history=filterArticleHistory(local.articles,p);return result({...history,articles:history.articles.map(({id,url,title,account,publishedAt,coverage})=>({id,url,title,account,publishedAt,coverage})),undated:history.undated.map(({id,url,title,account})=>({id,url,title,account})),libraryTruncated:local.truncated,failures:local.failures||[]})}))
}
module.exports={registerArticles}
