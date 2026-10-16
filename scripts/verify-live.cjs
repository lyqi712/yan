const path = require('node:path')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')

// Opt-in live checks. Output only counts and diagnostic metadata, never chat content.
async function verifyLive({ query = false, messages = false } = {}) {
  if (messages && !query) throw new Error('--messages 需要同时指定 --query')
  const client = new Client({ name: 'yan-live-verifier', version: require('../package.json').version })
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve(__dirname, '../src/server.js')], env: process.env, stderr: 'pipe' })
  const report = { version: require('../package.json').version, handshake: false, sessionsVerified: false, messagesVerified: false, rawChatSaved: false }
  try {
    await client.connect(transport)
    report.handshake = true
    report.toolCount = (await client.listTools()).tools.length
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args })
      if (result.isError) throw new Error(`${name} 调用失败；请使用 doctor 查看诊断，本验收不输出上游正文`)
      try { return JSON.parse(result.content[0].text) } catch { throw new Error(`${name} 返回格式无效`) }
    }
    if (query) {
      const sessions = await call('list_sessions', { kind: 'all', limit: 2 })
      if (!Array.isArray(sessions) || sessions.length > 2) throw new Error('会话结果不符合小量查询契约')
      report.sessionsVerified = true
      report.sessionsReturned = sessions.length
      if (messages) {
        const sessionId = sessions[0]?.sessionId || sessions[0]?.username || sessions[0]?.id
        if (!sessionId) throw new Error('没有会话样本；无法完成消息读取验收')
        const data = await call('get_recent_messages', { session_id: sessionId, limit: 1, page_size: 1 })
        if (data.returned !== 1 || data.messages?.length !== 1) throw new Error('当前会话没有消息样本；消息读取验收未完成')
        report.messagesReturned = data.returned
        report.messageContentComplete = data.contentIntegrity?.complete === true
        report.messagesVerified = report.messageContentComplete
        if (!report.messagesVerified) report.messageVerificationFailure = '正文不完整、未解码或缺少完整性证据；本次消息验收未通过'
      }
    }
    const diagnosis = await call('yan_diagnose')
    report.runtime = diagnosis.runtime
    report.readiness = diagnosis.readiness
    report.engines = diagnosis.capabilities?.engines
    report.diagnosticPassed = diagnosis.ok === true
    report.ok = report.handshake && report.diagnosticPassed && (!query || report.sessionsVerified) && (!messages || report.messagesVerified)
    return report
  } finally { await client.close() }
}

if (require.main === module) {
  const args = process.argv.slice(2)
  if (args.some(arg => !['--query', '--messages'].includes(arg))) {
    console.error('用法：npm run verify:live -- [--query] [--messages]；--query读取至多2个会话，--messages另读取首个会话1条消息；输出不含会话名和正文。')
    process.exitCode = 1
  } else verifyLive({ query: args.includes('--query'), messages: args.includes('--messages') }).then(report => {
    console.log(JSON.stringify(report, null, 2)); process.exitCode = report.ok ? 0 : 1
  }).catch(error => { console.error(error.message); process.exitCode = 1 })
}
module.exports = { verifyLive }
