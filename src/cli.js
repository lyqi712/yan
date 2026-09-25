#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { ROOT, readConfig, saveConfig, renderMcpConfigs } = require('./config')
function option(args, key, fallback) { const i = args.indexOf('--' + key); if (i < 0) return fallback; if (i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error(`--${key} 缺少值`); return args[i + 1] }
async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('眼需要 Node.js 22 或更高版本，请先升级 Node.js。')
  const args = process.argv.slice(2), command = args[0] || 'help'
  if (['help', '--help', '-h'].includes(command)) { console.log(`眼 · MCP 微信信息助手\n\nnode src/cli.js setup                WxLens首次安装与初始化引导\nnode src/cli.js mcp                  MCP stdio 服务\nnode src/cli.js doctor               连接与可选能力诊断\nnode src/cli.js optional-local      只探测本机已有可选解析器，不联网安装\nnode src/cli.js config --base-url http://127.0.0.1:5032 [--account-dir 路径] [--wxlens-exe 程序路径]\nnode src/cli.js mcp-config [--client json|codex|proma]\nnode src/cli.js watch 列表ID [--interval 60] [--runs 1]\n\nwatch 默认运行一轮，--runs 0 明确持续运行；每轮结果保存到本机.local/receipts后确认批次。\n完整使用方式见 README.md 和 docs/monitoring.md。`); return }
  if (command === 'mcp-config') { const name = option(args, 'client', 'json'); const configs = renderMcpConfigs(); if (!configs[name]) throw new Error('client 只能是 json、codex、proma'); console.log(configs[name]); return }
  if (command === 'config') { const current = readConfig(); const saved = saveConfig({ ...current, baseUrl: option(args, 'base-url', current.baseUrl), accountDir: option(args, 'account-dir', current.accountDir), wxlensExe: option(args, 'wxlens-exe', current.wxlensExe) }); console.log('配置已保存到 .local/config.json。环境变量 WXLENS_* 如已设置，会优先于本地配置。'); return }
  if (command === 'optional-local') { console.log(JSON.stringify(require('./optional-runtime').localOnlyInstall(), null, 2)); return }
  if (command === 'mcp') { await require('./server').createServer({ connect: true }); return }
  if (command === 'doctor') { const report = await require('./doctor').diagnose(); console.log(JSON.stringify(report, null, 2)); process.exitCode = report.ok ? 0 : 1; return }
  if (command === 'setup') { await require('./setup').setup(); return }
  if (command === 'watch') {
    const id = args[1]; if (!id || id.startsWith('--')) throw new Error('请提供已创建的关注列表ID')
    const interval = Number(option(args, 'interval', '60')), runs = Number(option(args, 'runs', '1'))
    if (!Number.isInteger(interval) || interval < 30 || interval > 86400 || !Number.isInteger(runs) || runs < 0 || runs > 10000) throw new Error('interval为30–86400秒；runs为0–10000（0表示持续）')
    const { createWatchStore } = require('./watchlists'), { createApiClient } = require('./wxlens-runtime'); const request = createApiClient(); const store = createWatchStore()
    let stopped = false, wake
    process.on('SIGINT', () => { stopped = true; wake?.() })
    for (let i = 0; !stopped && (runs === 0 || i < runs); i += 1) {
      let batch = await store.poll({ id }, request)
      if (batch.paused) { console.log(JSON.stringify({ watchlistId: id, paused: true })); return }
      const pages = [batch]
      while (!batch.delivery.complete) { batch = await store.readBatch({ id, batch_id: batch.batchId, offset: batch.delivery.nextOffset }); pages.push(batch) }
      const dir = path.join(ROOT, '.local', 'receipts'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const receipt = path.join(dir, `${Date.now()}-${randomUUID()}.json`), fd = fs.openSync(receipt, 'wx', 0o600)
      try { fs.writeFileSync(fd, JSON.stringify({ version: 1, watchlistId: id, batchId: batch.batchId, pages })); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      await store.acknowledge({ id, batch_id: batch.batchId })
      console.log(JSON.stringify({ watchlistId: id, batchId: batch.batchId, messages: batch.delivery.total, partial: batch.partial, receipt }))
      if (!stopped && (runs === 0 || i + 1 < runs)) await new Promise(resolve => { const timer = setTimeout(resolve, interval * 1000); wake = () => { clearTimeout(timer); resolve() } })
    }
    return
  }
  throw new Error('未知命令；运行 node src/cli.js help 查看用法')
}
main().catch(error => { console.error('[眼] ' + (error.code === 'MODULE_NOT_FOUND' ? '依赖未安装。请在项目根目录执行 npm ci 后重试。' : error.message)); process.exitCode = 1 })
