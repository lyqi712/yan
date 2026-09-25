# 眼 · Yan

**把微信里的信息交给你习惯的 AI：找人、找事、找结论。**

眼是一个 **本机只读的 MCP 服务**。接入 Proma、Claude Desktop、Cursor、Codex 或其他支持本地 MCP 的 AI 客户端后，用自然语言检索和组织有来源的微信材料，让 AI 帮你提取、总结和追踪。

- **40 个工具**：按消息 ID 回查正文、跨会话提取人物发言、多群扫描、持久关注列表、公众号候选发现、文章正文与图片读取。
- **4 个工作流提示词**：聊天简报、人物提取、多群关注、议题追踪。
- **完整性可见**：保留来源、分页、覆盖范围和正文完整性，不把预览摘录当成完整内容。
- **接上就问**：本机 WxLens 服务准备好后，在 AI 软件里直接提问；眼按需连接本机服务并支持后台复用。

## 你可以直接这样问 AI

- “总结这几个工作群本周的讨论，列出决定、待办、风险和未解决问题，每项附来源。”
- “提取林晓在产品群和交付群最近一个月的发言，先确认发送者 ID，不要混入同名的人。”
- “从这五个群找与 AI Agent、自动化有关的新信息，保留链接和前后语境。”
- “给这几个群建立一个关注列表，关键词是报价、延期、验收。现在检查一次，以后由客户端定时检查。”
- “追踪这个需求从提出到最后决定的讨论，保留不同意见；没有明确决定就说明没有。”
- “读取已经下载的表格和文档，整理其中的要点，并给出对应消息和文件来源。”

## 让AI帮你接入

把仓库链接交给有本机操作能力的AI，说明：“帮我安装并接入当前客户端的MCP，保留已有配置，接好后实际验证少量会话读取。”[AI接入步骤与验收标准](docs/agent-setup.md)说明如何复用WxLens、处理客户端配置和认证、区分配置成功与实际可读。

本地回归覆盖消息读取、正文完整性、搜索回填、附件解析、文章读取、关注列表恢复和真实 MCP stdio 握手；详细验证命令见文末的开发与验证章节。

## 快速接入

### 1. 安装一次

需要 **Node.js 22+**。已有WxLens的用户可下载源码版；原整合环境的用户可使用带原WxLens安装器的整合包。源码仓库不存安装器二进制。

```bash
git clone https://github.com/lyqi712/yan.git
cd yan
npm ci --ignore-scripts
npm run setup
```

Windows解压整合包后可直接双击 `install.cmd`。脚本先安装基础Node依赖，再进入本机服务准备；已有WxLens会直接发现并提供打开入口。基础安装不需要Python、uv或模型。

### 2. 准备本机 WxLens 服务

`setup.cmd` 或 `npm run setup` 会打开 WxLens 原有界面，完成本机服务和索引准备。眼不自行索取、保存或输出敏感凭据；准备完成后，日常使用直接在 AI 软件里提问。

默认服务地址 `http://127.0.0.1:5032`。查询发现服务未运行时，眼会尝试用 `--background` 启动已发现的 WxLens；MCP 握手本身不会等待它。后台启动只负责复用已经准备好的本机服务。

自定义安装位置、服务端口或附件目录可按需配置：

```bash
node src/cli.js config --wxlens-exe "D:/Tools/WxLens/WxLens.exe"
node src/cli.js config --base-url http://127.0.0.1:5032 --account-dir "D:/WeChat/xwechat_files/your-account"
npm run doctor
```

账号目录是包含 `db_storage` 的账号文件夹，仅在读取附件时需要。多个账号须明确选择；配置保存在 `.local/config.json`。设 `WXLENS_AUTO_START=false` 可关闭自动启动。

[首次接入详细步骤](docs/first-use.md) 区分安装、本机 WxLens 服务准备和 MCP 配置，并说明常见连接问题。

### 3. 复制 MCP 配置

```bash
npm run config:mcp
```

命令会生成本机 Node.js 与眼的绝对路径，把结果合并到 AI 客户端现有 MCP 配置中，保留其他服务。例如：

```json
{
  "mcpServers": {
    "yan": {
      "command": "node",
      "args": ["D:/Tools/yan/src/server.js"]
    }
  }
}
```

- **Claude Desktop / Cursor**：使用上面的 `mcpServers` 结构，重启或重新加载 MCP。
- **Proma**：运行 `node src/cli.js mcp-config --client proma`；添加 stdio MCP，填写输出中的 `command` 和 `args`。不要把 `npm start` 当作 MCP 入口。
- **Codex**：运行 `node src/cli.js mcp-config --client codex`，将生成的 TOML 合并到 Codex 配置中。
- **其他客户端**：只需支持本地 stdio MCP。支持 tools 即可使用全部核心功能；resources/prompts 是辅助入口。

接入后，让 AI 调用 `yan_diagnose`，再调用 `list_sessions`。即使 WxLens 暂时离线，眼也能完成 MCP 握手并提供诊断。移动眼的目录后，需要重新生成配置。

## 功能与工具

| 场景 | 工具 | 能做什么 |
| --- | --- | --- |
| 初次接入 | `yan_diagnose`、`yan_usage_guide`、`wechat_reader_capabilities` | 诊断连接、查看流程和解析能力 |
| 定位会话和身份 | `list_sessions`、`list_contacts`、`list_session_senders` | 找群、找私聊、区分群内实际发言人 |
| 基础阅读 | `get_recent_messages`、`search_messages`、`check_new_messages` | 关键词、时间、分页和最近变化 |
| 指定人物 | `get_messages_by_sender`、`extract_person_messages` | 按发送者 ID 精确提取，支持跨会话和上下文 |
| 多群信息 | `scan_sessions` | 批量群聊、主题 any/all 匹配、时间和人物筛选、逐群续读 |
| 聊天总结 | `prepare_chat_summary`、`analyze_wechat_chat` | 8 类总结目标，统计、规则候选和可引用原文；由 AI 撰写总结 |
| 还原语境 | `get_message_by_id`、`get_message_context`、`read_merged_forward`、`read_wechat_post` | 按 ID 回查完整上游正文、前后消息、合并转发和本地文章卡片 |
| 多群关注 | `configure_watchlist`、`list_watchlists`、`poll_watchlist`、`read_watchlist_batch`、`ack_watchlist_batch` | 保存关注规则、检查新增、续扫积压、重试与确认 |
| 公众号文章与图片 | `search_wechat_articles`、`search_wechat_articles_batch`、`search_wechat_articles_tencent`、`list_article_candidates`、`update_article_candidate`、`fetch_wechat_article`、`import_wechat_article`、`read_article_image`、`download_article_images` | 多来源候选发现、可恢复账本、原文核验、配图返回；候选不是完整历史 |
| 本地附件 | `list_wechat_attachments`、`extract_wechat_attachment_text`、`search_wechat_attachment_text` | 查找文件、提取正文、按正文搜索 |
| 证据导出 | `export_wechat_package` | 原始窗口、精选、噪声分账、附件文本、审计、SHA-256 ZIP |

8 类总结目标包括：综合总结、日报、周报、人物发言、项目进展、决策与待办、争议与风险、资源整理。使用 `focus` 选择目标，工具输出来源和总结结构。关键词分类是候选线索，不代替语义判断；没有明确负责人、截止时间或结论时，AI 应留空并说明。

详细示例见 [MCP 工作流](docs/mcp-workflows.md)，多群关注机制见 [监控与恢复](docs/monitoring.md)。

## 多群关注如何运行

```text
configure_watchlist → poll_watchlist → read_watchlist_batch（如有后续页）
                                           ↓
                                AI完成整理 / 本机结果已保存
                                           ↓
                                 ack_watchlist_batch
```

首次默认建立当前基线；`include_initial=true` 可以交付初始历史扫描。未确认的批次会重复返回，已读取分页不会因为 AI 断开而自动确认。超过一轮预算的积压保存续扫位置，后续批次继续追赶。同秒消息不依赖 localId 的排列顺序。

MCP 本身按调用检查，不会在后台自动定时发送通知。你可以让 AI 客户端的自动化定时调用；也可以显式使用眼的本地 CLI：

```bash
# 检查一轮，保存结果后确认
node src/cli.js watch work-groups

# 每60秒检查，持续运行；Ctrl+C停止
node src/cli.js watch work-groups --interval 60 --runs 0
```

CLI 将结果保存在 `.local/receipts/`，不自动发微信、邮件或外部通知。调用 AI 客户端总结时，返回的聊天内容会进入该客户端及其模型的数据处理流程。

## 文件解析与可选能力

基础 Node 解析覆盖文本、HTML、DOCX、XLSX/XLSM、PPTX、ODT/ODS/ODP、EPUB、ZIP 文本项；表格公式使用缓存值，不执行宏。PDF 文本层可用系统 `pdftotext`；旧 DOC 需要 `antiword`。图片、扫描 PDF、旧 XLS 和音视频可安装可选运行时。

公众号文章与图片也可通过 MCP 读取：`search_wechat_articles` 使用公开微信索引发现候选；`search_wechat_articles_tencent` 是可选的腾讯云 WSA SearchPro，限定公众号域名和最近 N 天，需用户自行开通服务并在客户端安全配置凭据。两种搜索都只是候选发现，不承诺完整公众号历史。`fetch_wechat_article` 读取公开文章，`import_wechat_article` 接收本人或 AI 浏览器正常打开后的 HTML 快照；`read_article_image` 返回原生 MCP `image` 内容块，`download_article_images` 保存带 SHA-256 清单的配图。聊天分享链接可用 `list_shared_articles` 提取；`read_wechat_image` 只读取调用方明确选定的标准本地图片，不解密 `.dat`。

[可选运行时说明](docs/optional-runtime.md) 列出 Python、模型、ffmpeg、许可及已验证边界。若本机已有可选 Python 模块，可运行 `npm run optional:local` 只做本地探测和启用，不运行 pip、不联网下载；`doctor` 会逐项显示 xlrd、OCR 和媒体解析状态。缺少模型会明确提示，不在读取时自动下载模型。压缩包在解析前检查条目数和实际展开字节。

## 覆盖与隐私

- 眼不对单条聊天正文做字符截断，但必须尊重 WxLens 自己报告的 `truncated`/`contentTruncated`/长度不一致和未解码状态；精确回查会将这类结果标为 `partial`，分页和监控结果提供内容完整性统计。基础单会话最多返回 5,000 条，扫描最多 20,000 条；批量工具每次总读取预算最多 10,000 条。条数上限用 offset 续读，不是把一条长消息切短。
- `text_only=true` 只是输出视图：非文本消息的正文会替换为 `[多媒体]`，同时标记 `contentSuppressed=true` 和原正文长度；它不表示图片、文件或音视频已经被读取。
- 单次 WxLens HTTP 响应超过 16MiB 会整次失败。关注列表每轮最多扫描 20,000 条、单群一次最多 5,000 条，批次持久化超过 16MiB 会整轮拒绝且不推进进度。降低每群条数后重试，不能靠丢正文继续。
- 关键词搜索沿用上游索引，单次最多 50 条命中。要核对某一条的完整 `content`，使用 `get_message_by_id`；当前窗口没有命中时看 `nextOffset`，不要当成整段历史不存在。搜索命中缺少发送者、类型或正文完整性标记时，眼会在同一会话有界回填；如果精确端点被截断，会优先保留可读的搜索正文并标明来源。
- 附件清单会返回 `coverage`；目录遍历、文件数量或解析器上限导致未覆盖时，结果会明确标记。附件正文默认按块返回，`offset_chars` 使用 UTF-16 码元并避开拆开 Emoji。搜索对每个文件一次提取最多 100 万字符，不在预算内再切成 20 万字符。`truncated=true` 或 `truncatedFiles` 表示尾部还没读完；解析器缺失的文件进入 `failures`，不能把未搜索解释成不存在。证据 ZIP 会记录 `nextOffset`。分析 Markdown 里的短摘录只是展示，结构化 JSON 保留原始消息正文。
- 公众号搜索结果里的标题和摘要是索引摘录。`fetch_wechat_article` / `import_wechat_article` 保存解析出的全文；HTML 超过 4MiB 或存档超过 8MiB 时整份失败。已收集文章不是该公众号的完整历史。
- offset 分页不是冻结快照；上游数据增长、删除、索引延迟或历史回填可能影响结果。眼保留重复、失败和未覆盖边界，不承诺数据库级 exactly-once。
- 合并转发只在本地索引含有嵌套文本时完整；内部图片、文件和未入索引的嵌套消息不能据此宣称完整。附件自动关联只给候选，提取到导出包必须显式指定路径。
- `.local/` 和 `output/` 可能包含私人数据。它们被 Git 和发行白名单排除，但不是加密存储。ZIP 的脱敏覆盖有限，分享前检查正文和附件。
- 眼源码、依赖安装和可选模型各自有许可。WxLens、微信客户端、模型、数据库和安装器均不随源码发行。

更多信息见 [安全与数据边界](SECURITY.md) 和 [第三方说明](THIRD-PARTY-NOTICES.md)。

## 开发与验证

```bash
npm ci --ignore-scripts
npm test
npm run check
npm run licenses
npm audit --omit=dev --registry=https://registry.npmjs.org
npm run package:product
```

测试使用合成消息与本机模拟 HTTP 服务，包括真实 MCP stdio 握手、自动启动与离线接入、多群提取、关注批次恢复、跨页同秒、长积压、超大批次、路径联接、超时/重定向、ZIP 展开限制与导出校验。CI 配置覆盖 Windows/Linux 的 Node 22/24。真实账号、物理新机器和实际 OCR/ASR 模型质量需在对应环境验收，不能以合成测试代替。

源码发行包输出到 `dist/`，采用白名单收集；打包后重读 ZIP，验证 CRC32 和逐文件 SHA-256，附独立校验文件。[变更记录](CHANGELOG.md) · [开发说明](docs/development.md)

## 许可

眼源码采用 [MIT](LICENSE)，保留原扩展作者声明。独立第三方程序、解析器与模型不因集成入口而变为 MIT。
