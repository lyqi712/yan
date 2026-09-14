const cheerio=require('cheerio')
const {fetchPublic,validateUrl}=require('./public-web')
function searchUrl(query,page=1){const u=new URL('https://weixin.sogou.com/weixin');u.searchParams.set('type','2');u.searchParams.set('query',query);u.searchParams.set('page',String(page));return validateUrl(u.href,'search')}
function parseSearch(html,{query,page=1,account_name,start_time,end_time}={}) {
 const $=cheerio.load(html)
 if(/访问过于频繁|请输入验证码|请完成.*验证/.test($('body').text()))throw new Error('搜狗要求本人浏览器验证，已停止搜索')
 if(!$('.news-list').length&&!/没有找到|未找到/.test($('body').text()))throw new Error('无法识别搜索结果页面，未把它当成空列表')
 const hits=[]
 $('.news-list li').slice(0,20).each((_,el)=>{
  const row=$(el),a=row.find('h3 a').first(),title=a.text().trim(),account=row.find('.all-time-y2,.account').first().text().trim()
  if(!title)return
  let link;try{link=new URL(a.attr('href'),'https://weixin.sogou.com');if(link.origin!=='https://weixin.sogou.com'||link.pathname!=='/link'||link.username||link.password)return}catch{return}
  const raw=row.find('.s2 script').text().match(/timeConvert\(['"](\d{10})['"]\)/)?.[1],timestamp=raw?Number(raw):null
  if(account_name&&account!==account_name)return
  if(timestamp!==null&&((start_time!=null&&timestamp<start_time)||(end_time!=null&&timestamp>end_time)))return
  hits.push({title,accountName:account,publishedAt:timestamp?new Date(timestamp*1000).toISOString():null,publishedAtSource:timestamp?'search-index':'unknown',searchLink:link.href,excerpt:row.find('.txt-info').text().trim().slice(0,1000),identityVerified:false,action:'在正常浏览器打开searchLink，到达mp.weixin.qq.com后核对账号/日期；调用fetch_wechat_article或导入已打开的HTML。'})
 })
 return {query,page,searchUrl:searchUrl(query,page),results:hits,nextPage:$('#sogou_next').length&&page<10?page+1:null,coverage:{source:'sogou-wechat-public-search',completeAccountHistory:false,resultsBeforeFilter:$('.news-list li').length,returned:hits.length,accountFilter:account_name||null,start_time:start_time??null,end_time:end_time??null,publicationNeedsArticleVerification:true},boundary:'搜索索引不是完整公众号历史；日期/名称以文章页复核为准，未知时间保留为候选；零命中不证明该号没有发文。链接可能过期，验证页停止并由本人处理。'}
}
async function searchArticles(params,{fetcher=fetchPublic}={}) {if(params.start_time!=null&&params.end_time!=null&&params.start_time>params.end_time)throw new Error('开始时间不能晚于结束时间');const r=await fetcher(searchUrl(params.query,params.page),'search');return {...parseSearch(r.buffer.toString('utf8'),params),provenance:'public-http'}}
async function searchArticlesBatch({account_name,queries,query,days=2,max_pages=3,start_time,end_time}={}, {fetcher=fetchPublic}={}) {
 const base=[...(Array.isArray(queries)?queries:[]),query,account_name].filter(x=>typeof x==='string'&&x.trim()).map(x=>x.trim()).filter((x,i,a)=>a.indexOf(x)===i).slice(0,5)
 if(!base.length)throw new Error('请提供query、queries或account_name')
 if(!Number.isInteger(max_pages)||max_pages<1||max_pages>10)throw new Error('max_pages必须为1–10')
 const merged=new Map(),runs=[],failures=[]
 for(const q of base)for(let page=1;page<=max_pages;page++)try{const r=await searchArticles({query:q,page,account_name,start_time,end_time},{fetcher});runs.push({query:q,page,count:r.results.length,nextPage:r.nextPage});for(const hit of r.results){const key=hit.searchLink||`${hit.title}|${hit.accountName}|${hit.publishedAt}`;const prior=merged.get(key);if(prior){prior.sources=[...(prior.sources||[]),{query:q,page:page}]}else merged.set(key,{...hit,sources:[{query:q,page}]})}if(!r.nextPage)break}catch(e){failures.push({query:q,page,error:e.message})}
 const results=[...merged.values()];return {results,runs,failures,coverage:{source:'sogou-wechat-public-search-multi-query',queries:base,pagesPerQuery:max_pages,uniqueCandidates:results.length,completeAccountHistory:false,publicationNeedsArticleVerification:true,recallStrategy:'multi-query-dedup'},boundary:'多轮搜索提高候选召回，但仍受搜索收录、限流和账号身份核验影响；必须对候选原文再次核验，不把候选数量当作完整历史。',provenance:'public-http'}
}
module.exports={searchUrl,parseSearch,searchArticles,searchArticlesBatch}
