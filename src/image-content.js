const fs=require('node:fs')
const {withinRoots,canonical}=require('./path-safety')
const MAX_IMAGE_BYTES=4*1024*1024
function imageInfo(b) {
 if(!Buffer.isBuffer(b)||b.length>MAX_IMAGE_BYTES) throw new Error('图片超过4MiB限制')
 let mimeType,width,height
 if(b.length>=33&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&b.toString('ascii',12,16)==='IHDR') {mimeType='image/png';width=b.readUInt32BE(16);height=b.readUInt32BE(20)}
 else if(b.length>=13&&/^GIF8[79]a$/.test(b.toString('ascii',0,6))) {mimeType='image/gif';width=b.readUInt16LE(6);height=b.readUInt16LE(8)}
 else if(b.length>=30&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP') {
  mimeType='image/webp';const chunk=b.toString('ascii',12,16)
  if(chunk==='VP8X') {width=1+b.readUIntLE(24,3);height=1+b.readUIntLE(27,3)}
  else if(chunk==='VP8 ' && b[23]===0x9d&&b[24]===0x01&&b[25]===0x2a) {width=b.readUInt16LE(26)&0x3fff;height=b.readUInt16LE(28)&0x3fff}
  else if(chunk==='VP8L'&&b[20]===0x2f){const bits=b.readUInt32LE(21);width=(bits&0x3fff)+1;height=((bits>>>14)&0x3fff)+1}
 }
 else if(b.length>=4&&b[0]===255&&b[1]===216) {
  mimeType='image/jpeg';let pos=2
  while(pos+4<=b.length) {
   if(b[pos]!==255) break
   while(b[pos]===255)pos++
   const marker=b[pos++];if(marker===0xd9||marker===0xda)break
   if(marker===0x01 || (marker>=0xd0&&marker<=0xd7))continue
   if(pos+2>b.length)break
   const len=b.readUInt16BE(pos);if(len<2||pos+len>b.length)break
   if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)&&len>=8){height=b.readUInt16BE(pos+3);width=b.readUInt16BE(pos+5);break}
   pos+=len
  }
 }
 if(!mimeType||!width||!height)throw new Error('不是支持的完整图片格式；加密DAT、SVG、HTML及无法识别尺寸的文件不能展示')
 if(width>16384||height>16384||width*height>24000000) throw new Error('图片尺寸或像素超过限制（单边16384、2400万像素）')
 return {mimeType,width,height,bytes:b.length,animated:mimeType==='image/gif'}
}
function imageContent(buffer) {const info=imageInfo(buffer);return {type:'image',mimeType:info.mimeType,data:buffer.toString('base64')}}
function readLocalImage(sourcePath,roots) {
 const target=canonical(sourcePath)
 if(!withinRoots(target,roots))throw new Error('图片路径不在允许的本地目录')
 const before=fs.statSync(target,{bigint:true});if(!before.isFile()||before.size>BigInt(MAX_IMAGE_BYTES))throw new Error('图片不是普通文件或超过4MiB限制')
 const fd=fs.openSync(target,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0))
 try {
  const opened=fs.fstatSync(fd,{bigint:true})
  if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||opened.size>BigInt(MAX_IMAGE_BYTES)||canonical(sourcePath)!==target||!withinRoots(target,roots))throw new Error('图片文件或路径在读取前发生变化')
  const b=Buffer.alloc(MAX_IMAGE_BYTES+1);const count=fs.readSync(fd,b,0,b.length,0);return b.subarray(0,count)
 }finally{fs.closeSync(fd)}
}
module.exports={imageInfo,imageContent,readLocalImage,MAX_IMAGE_BYTES}
