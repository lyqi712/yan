const crypto=require('node:crypto')
const https=require('node:https')
const {validateUrl}=require('./public-web')
const HOST='wsa.tencentcloudapi.com'
const sha=s=>crypto.createHash('sha256').update(s).digest('hex')
const mac=(key,s)=>crypto.createHmac('sha256',key).update(s).digest()
function signedRequest(payload,{secretId,secretKey,token},timestamp=Math.floor(Date.now()/1000)) {
 const body=JSON.stringify(payload),date=new Date(timestamp*1000).toISOString().slice(0,10),scope=`${date}/wsa/tc3_request`
 const canonical=`POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:${HOST}\n\ncontent-type;host\n${sha(body)}`
 const sign=mac(mac(mac(mac(`TC3${secretKey}`,date),'wsa'),'tc3_request'),`TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${sha(canonical)}`).toString('hex')
 const headers={'Content-Type':'application/json; charset=utf-8','Host':HOST,'X-TC-Action':'SearchPro','X-TC-Version':'2025-05-08','X-TC-Timestamp':String(timestamp),'Authorization':`TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=content-type;host, Signature=${sign}`,'Content-Length':Buffer.byteLength(body)}
 if(token)headers['X-TC-Token']=token
 return {body,headers}
}
function send(request){return new Promise((resolve,reject)=>{
 const req=https.request({hostname:HOST,path:'/',method:'POST',headers:request.headers},res=>{let total=0;const chunks=[];res.on('data',b=>{total+=b.length;if(total>4*1024*1024){req.destroy(new Error('腾讯搜索响应超过4MiB'));return}chunks.push(b)});res.on('error',reject);res.on('end',()=>{if(res.statusCode!==200)return reject(new Error(`腾讯搜索HTTP ${res.statusCode}；未跟随重定向`));try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))}catch{reject(new Error('腾讯搜索返回非JSON响应'))}})})
 const timer=setTimeout(()=>req.destroy(new Error('腾讯搜索请求超时')),15000);req.on('close',()=>clearTimeout(timer));req.on('error',()=>reject(new Error('腾讯搜索请求失败或超时；请检查网络与服务开通状态')));req.end(request.body)
})}
function parseResponse(raw){const r=raw?.Response;if(!r)throw new Error('腾讯搜索响应结构无效');if(r.Error)throw new Error(`腾讯搜索未成功：${String(r.Error.Code||'Unknown').replace(/[^A-Za-z0-9_.]/g,'').slice(0,120)}；请在腾讯云控制台检查权限、额度与服务版本`)
 const results=[],failures=[];for(const [i,page] of (Array.isArray(r.Pages)?r.Pages:[]).slice(0,50).entries()){try{const p=typeof page==='string'?JSON.parse(page):page;const url=validateUrl(p.url,'article');const images=[];for(const image of (Array.isArray(p.pics)?p.pics:[]).slice(0,10)){try{images.push({url:validateUrl(image.origin_url,'image'),caption:String(image.caption||'').slice(0,500)})}catch{}}
 results.push({url,title:String(p.title||'').slice(0,1000),publishedAtCandidate:String(p.date||'').slice(0,100),excerpt:String(p.passage||'').slice(0,4000),images,identityVerified:false})}catch{failures.push({index:i,reason:'无法解析结果或不是允许的公众号文章URL'})}}
 return {results,failures,version:r.Version||null,requestId:r.RequestId||null,coverage:{source:'tencent-wsa-searchpro',completeAccountHistory:false,publicationNeedsArticleVerification:true,siteAndFreshnessSupported:['standard','premium','flagship'].includes(r.Version)},boundary:'这是搜索发现的候选，账号身份、发布时间和配图完整性须通过原文核对；搜索零结果不代表没有发文。图片最多10张，不代表全部原文配图。'}
}
async function searchTencent({query,days=2},{env=process.env,transport=send,timestamp}={}){
 if(env.YAN_TENCENT_SEARCH_ENABLED!=='true')throw new Error('腾讯搜索默认关闭。本人确认服务费用后，在客户端安全配置中启用YAN_TENCENT_SEARCH_ENABLED并配置腾讯云凭据；不得把凭据发给模型。')
 if(typeof query!=='string'||!query.trim()||query.length>200||!Number.isInteger(days)||days<1||days>30)throw new Error('搜索词1–200字符，days为1–30整数')
 if(!env.TENCENTCLOUD_SECRET_ID||!env.TENCENTCLOUD_SECRET_KEY)throw new Error('缺少腾讯云安全凭据配置；请本人在客户端配置，勿在聊天或工具参数中填写')
 const request=signedRequest({Query:query,Site:'mp.weixin.qq.com',Freshness:`d${days}`},{secretId:env.TENCENTCLOUD_SECRET_ID,secretKey:env.TENCENTCLOUD_SECRET_KEY,token:env.TENCENTCLOUD_SESSION_TOKEN},timestamp)
 return {...parseResponse(await transport(request)),query,requestedDays:days}
}
module.exports={signedRequest,parseResponse,searchTencent}
