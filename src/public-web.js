const https = require('node:https')
const dns = require('node:dns').promises
const net = require('node:net')
const { BlockList } = require('node:net')
const denied = new BlockList()
for (const [ip, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) denied.addSubnet(ip,prefix,'ipv4')
function publicAddress(ip) {
 // Only global IPv4 is used. Refusing IPv6 also avoids mapped/private/transition ambiguity.
 return net.isIP(ip) === 4 && !denied.check(ip,'ipv4')
}
function validateUrl(value, kind) {
 let u; try { u=new URL(value) } catch { throw new Error('URL格式无效') }
 if (u.protocol!=='https:' || u.username || u.password || u.port) throw new Error('仅允许无凭据的HTTPS默认端口URL')
 if(kind==='article') {
  if(u.hostname!=='mp.weixin.qq.com' || !(/^\/s\/[\w-]+$/.test(u.pathname) || u.pathname==='/s')) throw new Error('仅允许公众号文章链接 /s 或 /s/文章ID')
  const allowed=new Set(['__biz','mid','idx','sn','chksm','scene','srcid','sharer_shareinfo','sharer_shareinfo_first','sharer_sharetime','sharer_shareid','from','isappinstalled','subscene','ascene','sessionid','clicktime','enterid','forceh5','devicetype','version','lang','nettype','fontScale','exportkey','pass_ticket','wx_header'])
  for(const key of u.searchParams.keys()) {
   if(!allowed.has(key)) throw new Error('文章链接含不支持的参数，请复制标准文章链接')
  }
  // Persist and request only public article identity; never retain share/account/session tokens.
  const canonical=new URL(u.origin+u.pathname)
  for(const key of ['__biz','mid','idx','sn']) if(u.searchParams.has(key)) canonical.searchParams.set(key,u.searchParams.get(key))
  if(u.pathname==='/s' && !['__biz','mid','idx','sn'].every(k=>canonical.searchParams.get(k))) throw new Error('长文章链接缺少__biz/mid/idx/sn')
  return canonical.href
 }
 if(kind==='search') {
  if(u.hostname!=='weixin.sogou.com'||u.pathname!=='/weixin'||u.searchParams.get('type')!=='2')throw new Error('仅允许搜狗微信文章搜索入口')
  for(const k of u.searchParams.keys())if(!['type','query','page','ie'].includes(k))throw new Error('不支持的搜索参数')
  if(!u.searchParams.get('query')||u.searchParams.get('query').length>200)throw new Error('搜索词须为1–200字符')
  const page=Number(u.searchParams.get('page')||1);if(!Number.isInteger(page)||page<1||page>10)throw new Error('搜索分页范围1–10')
  u.hash='';return u.href
 }
 if(kind!=='image' || !['mmbiz.qpic.cn','mmbiz.qlogo.cn'].includes(u.hostname)) throw new Error('仅允许微信公众号图片CDN')
 if(!/^\/(?:sz_)?mmbiz_[a-z0-9]+\//i.test(u.pathname) && !/^\/mmbiz\//.test(u.pathname)) throw new Error('不支持的公众号图片路径')
 u.hash=''; return u.href
}
async function fetchPublic(value,kind,options={}) {
 const url=validateUrl(value,kind), started=Date.now(), timeout=options.timeoutMs||15000, maxBytes=options.maxBytes||(kind==='article'?4*1024*1024:4*1024*1024)
 const lookup=options.lookup||dns.lookup.bind(dns)
 let current=url
 for(let hop=0;hop<4;hop++) {
  const u=new URL(current), remaining=timeout-(Date.now()-started)
  if(remaining<=0) throw new Error('公开资源读取超时')
  let timer
  const addresses=await Promise.race([lookup(u.hostname,{all:true,family:4}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('DNS查询超时')),remaining)})]).finally(()=>clearTimeout(timer))
  if(!addresses.length || addresses.some(x=>!publicAddress(x.address))) throw new Error('目标地址不是允许的公网地址')
  const address=addresses[0]
  const response=await new Promise((resolve,reject)=>{
   let settled=false
   const done=(err,value)=>{if(settled)return;settled=true;clearTimeout(totalTimer);err?reject(err):resolve(value)}
   const req=https.get(current,{agent:false,headers:{'User-Agent':'Yan-WeChat-MCP/4.1','Accept':kind!=='image'?'text/html':'image/png,image/jpeg,image/webp,image/gif','Accept-Encoding':'identity'},lookup:(_host,opts,cb)=>opts?.all?cb(null,[address]):cb(null,address.address,address.family)},res=>{
    const status=res.statusCode
    if(status>=300&&status<400) {res.resume();done(null,{redirect:res.headers.location});return}
    if(status!==200) {res.destroy();done(new Error(`公开资源返回HTTP ${status}；未读取正文`));return}
    if(res.headers['content-encoding'] && res.headers['content-encoding']!=='identity') {res.destroy();done(new Error('不支持压缩响应，请使用浏览器快照导入'));return}
    if(Number(res.headers['content-length'])>maxBytes) {res.destroy();done(new Error('公开资源超过大小限制'));return}
    const chunks=[];let bytes=0
    res.on('data',c=>{bytes+=c.length;if(bytes>maxBytes){res.destroy();done(new Error('公开资源超过大小限制'))}else chunks.push(c)})
    res.on('error',()=>done(new Error('公开资源读取中断')))
    res.on('end',()=>done(null,{buffer:Buffer.concat(chunks),url:current,contentType:res.headers['content-type']||''}))
   })
   const totalTimer=setTimeout(()=>{req.destroy();done(new Error('公开资源读取超时'))},Math.max(1,timeout-(Date.now()-started)))
   req.on('error',()=>done(new Error('公开资源网络连接失败')))
  })
  if(!response.redirect) return response
  let next;try{next=new URL(response.redirect,current)}catch{throw new Error('无效的重定向')}
  if(kind!=='image' && /captcha|verify|login|wappoc|antispider|websearch/.test(next.pathname)) throw new Error('微信要求浏览器验证或登录；请本人正常打开文章，完成验证后导入浏览器页面，不自动重试或绕过')
  current=validateUrl(next.href,kind)
 }
 throw new Error('公开资源重定向次数超过限制')
}
module.exports={validateUrl,publicAddress,fetchPublic}
