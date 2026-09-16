const cheerio=require('cheerio')
const {fetchPublic,validateUrl}=require('./public-web')
function searchUrl(query,page=1){const u=new URL('https://weixin.sogou.com/weixin');u.searchParams.set('type','2');u.searchParams.set('query',query);u.searchParams.set('page',String(page));return validateUrl(u.href,'search')}
function parseSearch(html,{query,page=1,account_name,start_time,end_time}={}) {
 const $=cheerio.load(html)
 if(/访问过于频繁|请输入验证码|请完成.*验证/.test($('body').text()))throw Object.assign(new Error('搜狗要求本人浏览器验证，已停止搜索'),{code:'VERIFICATION_REQUIRED'})
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

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function searchArticlesBatch(params = {}, {fetcher=fetchPublic, sleep=wait, now=Date.now}={}) {
 if (Object.hasOwn(params, 'days')) throw new Error('搜狗批量搜索不支持days；请传start_time/end_time（Unix秒）过滤索引结果，或使用腾讯搜索days入口')
 const {account_name, queries, query, max_pages=3, start_time, end_time} = params
 if (start_time != null && end_time != null && start_time > end_time) throw new Error('开始时间不能晚于结束时间')
 if (queries != null && (!Array.isArray(queries) || queries.length > 5)) throw new Error('queries最多5个查询词')
 const input=[...(queries || []), query, account_name].filter(x=>x!=null)
 if (input.some(x=>typeof x!=='string'||!x.trim()||x.trim().length>200)) throw new Error('查询词须为1–200字符')
 const base=[...new Set(input.map(x=>x.trim()))]
 if(!base.length)throw new Error('请提供query、queries或account_name')
 if(base.length>5)throw new Error('合并后的不同查询词最多5个')
 if(!Number.isInteger(max_pages)||max_pages<1||max_pages>10)throw new Error('max_pages必须为1–10')
 const merged=new Map(),runs=[],failures=[],remaining=[]
 const started=now(), maxRequests=12, maxDurationMs=45000, intervalMs=1200
 let requests=0, stopReason=null
 for (let qi=0;qi<base.length;qi++) {
  const q=base[qi]
  for (let page=1;page<=max_pages;page++) {
   if(requests>=maxRequests)stopReason='request_budget'
   if(now()-started>=maxDurationMs-intervalMs)stopReason='time_budget'
   if(!stopReason && requests)await sleep(intervalMs)
   if(now()-started>=maxDurationMs)stopReason='time_budget'
   if(stopReason){remaining.push({query:q,page,maxPage:max_pages,reason:stopReason});break}
   requests++
   try {
    const r=await searchArticles({query:q,page,account_name,start_time,end_time},{fetcher:(url,kind)=>fetcher(url,kind,{timeoutMs:Math.max(1,Math.min(15000,maxDurationMs-(now()-started)))})})
    runs.push({query:q,page,count:r.results.length,nextPage:r.nextPage})
    for(const hit of r.results){const key=hit.searchLink;const prior=merged.get(key);if(prior)prior.sources.push({query:q,page});else merged.set(key,{...hit,sources:[{query:q,page}]})}
    if(!r.nextPage)break
    if(page===max_pages)remaining.push({query:q,page:r.nextPage,maxPage:10,reason:'page_limit'})
   } catch(e) {
    if(e.code==='VERIFICATION_REQUIRED')stopReason='verification_required'
    else if(e.code==='RATE_LIMITED'||e.status===429)stopReason='rate_limited'
    else if(e.code==='ACCESS_DENIED'||e.status===403)stopReason='access_denied'
    failures.push({query:q,page,code:e.code||'FETCH_FAILED',error:e.message})
    remaining.push({query:q,page,maxPage:max_pages,reason:stopReason||'query_failed'})
    break // No automatic retry or further pages of a failed query.
   }
  }
  if(stopReason){for(const pending of base.slice(qi+1))remaining.push({query:pending,page:1,maxPage:max_pages,reason:'not_started'});break}
 }
 const results=[...merged.values()]
 return {results,runs,failures,remaining,partial:failures.length>0||remaining.length>0,stopReason,coverage:{source:'sogou-wechat-public-search-multi-query',queries:base,pagesPerQuery:max_pages,uniqueCandidates:results.length,requests,maxRequests,maxDurationMs,intervalMs,elapsedMs:now()-started,completeAccountHistory:false,publicationNeedsArticleVerification:true,start_time:start_time??null,end_time:end_time??null,recallStrategy:'multi-query-dedup'},boundary:'多轮搜索提高候选召回，不保证完整历史；时间参数只过滤索引结果，不会令搜索引擎按日期召回。验证/429/403立即停止，勿自动续跑；本人处理后可按remaining通过单页工具继续。缺少全量基准，不能计算召回率。',provenance:'public-http'}
}
module.exports={searchUrl,parseSearch,searchArticles,searchArticlesBatch}
