const fs=require('node:fs')
const path=require('node:path')
const {createHash,randomUUID}=require('node:crypto')
const {ownedOutput}=require('./path-safety')
const hash=value=>createHash('sha256').update(value).digest('hex')
const STATES=new Set(['candidate','verified','conflicting','unknown'])
function mergeSources(oldSources, incoming) {
 const rows=[...(oldSources||[]),...(incoming||[])]
 const seen=new Set(),out=[]
 for(const item of rows){const key=JSON.stringify(item||{});if(seen.has(key))continue;seen.add(key);out.push(item);if(out.length>=20)break}
 return out
}
function decideVerification(candidate,article) {
 const expected=String(candidate.accountName||'').trim()
 const actual=String(article.account?.name||'').trim()
 if(!actual)return {status:'unknown',reason:'文章缺少可核验公众号名称'}
 if(expected&&actual!==expected)return {status:'conflicting',reason:`候选账号「${expected}」与文章账号「${actual}」不一致`}
 return {status:'verified',reason:''}
}
function createCandidateStore({baseDir=path.resolve(__dirname,'..','output')}={}) {
 function root(){const r=ownedOutput(path.join(baseDir,'candidates'),baseDir);if(!r)throw new Error('候选账本目录被重定向');fs.mkdirSync(r,{recursive:true,mode:0o700});return r}
 function file(){return path.join(root(),'ledger.json')}
 function empty(){return {schemaVersion:1,updatedAt:null,candidates:[],runs:[]}}
 function read(){const p=file();if(!fs.existsSync(p))return empty();if(fs.statSync(p).size>8*1024*1024)throw new Error('候选账本超过8MiB限制');const data=JSON.parse(fs.readFileSync(p,'utf8'));if(data.schemaVersion!==1||!Array.isArray(data.candidates)||!Array.isArray(data.runs))throw new Error('候选账本格式无效');return data}
 function write(data){
  while(data.candidates.length>2000){const i=data.candidates.findIndex(x=>x.status==='candidate');data.candidates.splice(i>=0?i:0,1)}
  data.updatedAt=new Date().toISOString()
  const p=file(),tmp=path.join(root(),`.pending-${randomUUID()}`),fd=fs.openSync(tmp,'wx',0o600)
  try{const body=JSON.stringify(data,null,2);if(Buffer.byteLength(body)>8*1024*1024)throw new Error('候选账本超过8MiB限制');fs.writeFileSync(fd,body);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
  try{fs.renameSync(tmp,p)}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp)}
 }
 function key(hit){return hash([hit.articleUrl||hit.url||'',hit.searchLink||'',hit.title||'',hit.accountName||''].join('\n'))}
 function upsert(hits,{run}={}){
  const data=read(),now=new Date().toISOString(),ids=[]
  for(const hit of hits||[]){
   const id=key(hit),old=data.candidates.find(x=>x.id===id)
   if(old){
    old.lastSeenAt=now
    old.sources=mergeSources(old.sources,hit.sources)
    if(hit.articleUrl&&!old.articleUrl)old.articleUrl=hit.articleUrl
    if(hit.url&&!old.articleUrl)old.articleUrl=hit.url
    if(!old.searchLink&&hit.searchLink)old.searchLink=hit.searchLink
   }else{
    data.candidates.push({id,status:'candidate',createdAt:now,lastSeenAt:now,title:String(hit.title||'').slice(0,1000),accountName:String(hit.accountName||'').slice(0,200),publishedAtCandidate:hit.publishedAt||hit.publishedAtCandidate||null,searchLink:hit.searchLink||null,articleUrl:hit.articleUrl||hit.url||null,excerpt:String(hit.excerpt||'').slice(0,2000),sources:mergeSources([],hit.sources),verificationAttempts:0,lastError:null,articleId:null})
   }
   ids.push(id)
  }
  if(run){
   data.runs.push({runId:run.runId||randomUUID(),savedAt:now,queries:run.queries||null,requests:run.requests??null,stopReason:run.stopReason||null,partial:Boolean(run.partial),remaining:Array.isArray(run.remaining)?run.remaining.slice(0,50):[],candidateIds:ids})
   if(data.runs.length>100)data.runs=data.runs.slice(-100)
  }
  write(data)
  const unique=[...new Set(ids)]
  return {candidateIds:unique,saved:unique.length}
 }
 function list({status,limit=100}={}){
  if(status&&!STATES.has(status))throw new Error('候选状态无效')
  const data=read(),cap=Math.min(Math.max(Number(limit)||100,1),500)
  const rows=data.candidates.filter(x=>!status||x.status===status).sort((a,b)=>String(b.lastSeenAt||'').localeCompare(String(a.lastSeenAt||'')))
  return {candidates:rows.slice(0,cap),total:rows.length,truncated:rows.length>cap,counts:Object.fromEntries([...STATES].map(s=>[s,data.candidates.filter(x=>x.status===s).length])),latestRun:data.runs.at(-1)||null,boundary:'候选来自搜索或调用方导入；candidate不是原文核验，verified只表示本地核验流程已通过，不代表公众号完整历史。'}
 }
 function update(id,patch={}){
  const data=read(),item=data.candidates.find(x=>x.id===id)
  if(!item)throw new Error('候选不存在')
  if(patch.status&&!STATES.has(patch.status))throw new Error('候选状态无效')
  if(patch.status)item.status=patch.status
  if(patch.articleUrl)item.articleUrl=String(patch.articleUrl).slice(0,4096)
  if(patch.accountName)item.accountName=String(patch.accountName).slice(0,200)
  if(patch.publishedAt)item.publishedAt=patch.publishedAt
  if(patch.articleId)item.articleId=patch.articleId
  item.verificationAttempts=(item.verificationAttempts||0)+1
  item.lastError=patch.reason?String(patch.reason).slice(0,500):null
  if(item.status==='verified')item.lastVerifiedAt=new Date().toISOString()
  write(data)
  return item
 }
 function verify(id,article){
  const data=read(),item=data.candidates.find(x=>x.id===id)
  if(!item)throw new Error('候选不存在')
  const decision=decideVerification(item,article)
  return update(id,{status:decision.status,articleUrl:article.url,accountName:article.account?.name,publishedAt:article.publishedAt,articleId:article.id,reason:decision.reason})
 }
 return {upsert,list,update,verify}
}
module.exports={createCandidateStore,decideVerification,STATES}
