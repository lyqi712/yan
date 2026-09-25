# MCP 工作流示例

## 先定位再提取

`list_sessions` 返回会话标识；`list_contacts` 查联系人；`list_session_senders` 统计已扫描窗口中的发言人。它不是完整群成员名单。后续按 `senderId` 精确匹配，不能用同名昵称替代。

以下 ID 均为占位符，须替换为本机工具实际返回的值。时间使用 Unix **秒**，不能传毫秒；开始与结束边界包含对应秒，日期请按用户所在时区换算。

## 某人的跨群发言

工具：`extract_person_messages`

```json
{
  "session_ids": ["group-a", "group-b"],
  "sender_ids": ["person-id"],
  "per_session_limit": 1000,
  "context_before": 2,
  "context_after": 2
}
```

每群先扫描 1000 条原始消息，再按人筛选。命中少并不代表此人只说过这么多。检查 `partial` 和 `nextOffsets`；后续把 `nextOffsets` 作为 `offsets` 传回，逐群续读。主 `messages` 仅包含指定人物；`context.windows` 可包含其他人的前后发言，不能一并归于该人物。

## 多群关键词筛选

工具：`scan_sessions`

```json
{
  "session_ids": ["group-a", "group-b", "group-c"],
  "keywords": ["Agent", "自动化", "MCP"],
  "match_mode": "any",
  "per_session_limit": 500,
  "context_before": 1,
  "context_after": 2
}
```

`any` 命中任意词；`all` 要求每个词都在同一条消息中。当前采用忽略大小写的字面匹配，不执行用户提供的正则。返回 `matchedKeywords`、独立的群级失败、来源和分页信息。可组合 `start_time`、`end_time`、`sender_ids`。

## 总结、决策、待办和资源

工具：`prepare_chat_summary`

```json
{
  "session_ids": ["group-a", "group-b"],
  "focus": "决策与待办",
  "time_zone": "Asia/Shanghai",
  "per_session_limit": 1000
}
```

返回消息、按人/日/消息类型的统计、链接来源、逐群规则候选及总结要求。由当前 AI 阅读证据生成总结。规则可能把否定句、转述或疑问误识别为决定，因此需要核验原文。不要把一次回答当作问题已解决，不要凭提及名字自动指派负责人。

推荐输出结构：

1. 时间、会话、读取数量和未覆盖范围。
2. 主要讨论及各方观点。
3. 已明确的决定和对应引用。
4. 待办、负责人、期限；未说明的字段留空。
5. 风险、不同意见及尚未解决的问题。
6. 文档和资源链接；说明链接正文是否真的读取。

## 关键结论回查

工具：`get_message_context`

```json
{
  "session_id": "group-a",
  "local_id": 123,
  "before": 5,
  "after": 5,
  "scan_limit": 1000
}
```

找不到时查看 `unresolvedHits` 和扫描边界，可增加预算或使用 `offset`。来源组合为 `sessionId + localId + timestamp`；不同群的 `localId=123` 不是同一条记录。

## 文件读取和证据包

先调用 `list_wechat_attachments` 定位已下载文件。返回的 `coverage` 标出目录遍历、文件返回上限和是否还有未列出的文件；若 `complete=false`，不能把当前清单当成全部附件。再将明确选定的路径传入 `extract_wechat_attachment_text`。返回的 `text` 是一个分块：`truncated=true` 时把 `nextOffset` 作为下一次的 `offset_chars`，直到 `nextOffset` 为 null。偏移量按 JavaScript 字符串的 UTF-16 码元计算，并会避开把一个 Emoji 拆成两半。`search_wechat_attachment_text` 对每个文件一次提取最多 100 万字符，不在这个预算内再切成 20 万字符；解析器缺失或不支持的文件会在 `failures` 中列出并使 `partial=true`。`partial=true` 且 `truncatedFiles`、`failures` 或 `coverage` 未完成时，尾部或文件正文尚未搜索，不能把未命中解释成文件里没有该词。证据 ZIP 的附件清单会带 `nextOffset`；导出默认最多纳入 100 万字符。

`export_wechat_package` 会在眼的 `output/` 内创建唯一证据包。`attachment_paths` 必须是你明确选定的附件。`auto_link_attachments=true` 仅生成候选表，不因文件名或时间接近而自动提取其他群文件。

导出内 `00-raw` 表示本次获取窗口的消息结构，部分账号标识会替换；不是原数据库备份或法证原件。生成后可以核验 `checksums.sha256`。不要自动把这个 ZIP 上传 GitHub。

## 客户端入口

- Resource：`yan://guide`。
- Prompts：`chat-digest`、`person-extract`、`group-watch`、`topic-trace`，参数 `request` 填用户任务。
- 不支持 resource 或 prompt 的客户端可调用 `yan_usage_guide`，全部核心能力仍可用。
- MCP 输出只写 stdout 协议；诊断日志使用 stderr。启动命令应直接指向 `src/server.js`；`start.cmd`也是stdio入口。
