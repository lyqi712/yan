# 开发与验收

## 目录

- `src/server.js`：MCP注册、原有工具及stdio入口。
- `src/advanced-tools.js`：人物、多群、总结、关注工具与prompts/resources。
- `src/session-tools.js`：跨群采集、来源引用、统计和总结证据。
- `src/watchlists.js`：本机关注状态、分批交付、续扫与确认。
- `src/record-pipeline.js`：有界分页、上下文、增量与规则候选。
- `src/content-tools.js`、`bounded-zip.js`、`path-safety.js`：附件解析和访问限制。
- `src/config.js`、`http-client.js`、`doctor.js`：共享配置、HTTP和诊断。
- `src/yan-runtime.js`、`src/setup.js`：发现/后台启动眼与首次交互式安装、初始化引导。
- `src/cli.js`：配置、诊断、MCP、首次设置与显式轮询。
- `src/tests/`：合成回归与实际协议集成测试。
- `scripts/`：语法检查、依赖许可、白名单打包。

## 本机验证

```bash
npm ci --ignore-scripts
npm test
npm run check
npm run licenses
npm audit --omit=dev --registry=https://registry.npmjs.org
npm run package:product
```

测试不需要真实账号或眼的安装程序。集成测试启动短生命周期回环HTTP服务，再通过MCP SDK Client启动真实stdio子进程，检查工具、schema、prompt、resource和调用结果。监控测试覆盖大于5000条积压、追赶期间新增、同秒跨页、同名人物、空群基线、分页拒绝跳读、并发锁和超大UTF-8状态。

`npm run check`检查JavaScript语法与发行必需项。Python脚本语法可单独验证：

```bash
python -m compileall -q ocr-runtime
```

Python语法通过不代表可选依赖、模型或真实OCR/ASR通过。真实Windows新机、实际本机程序版本、账号索引顺序及多平台外部程序分别验收。

## 源码发行

`npm run package:product`只收集根部固定文件与`src/scripts/docs/ocr-runtime/.github`的源码文件。拒绝链接、数据库、凭据文件名、模型、二进制和过大文件；排除`.local/output/node_modules/.venv`。

打包后重读ZIP，逐文件验证SHA-256，同时检查CRC32。产物为`dist/yan-v<package.json版本>-source.zip`及独立`.sha256`。不要把测试生成的聊天证据ZIP当作源码包发布。

旧固定 WxLens 4.3.0 安装器自2026-10-19起已停止安装和整合打包准入。`npm run package:integrated` 目前应返回 `YAN_INSTALLER_WITHDRAWN` 并以非零状态退出，且不得生成源码或整合产物；这是发行门禁通过的预期行为。不要通过改名、强制参数或只重算哈希重新分发同一文件。

重新开放整合发行前，必须取得可用且允许再分发的替代组件，记录其完整哈希、有效期、兼容范围和许可，更新受审阅安装器清单，在新机器验证首次初始化与查询，并再次检查整合包逐文件校验。只有本机试用或哈希一致不能放行。当前对外候选仅为源码ZIP，迁移见 [component-recovery.md](component-recovery.md)。

CI执行Windows/Linux、Node22/24矩阵测试和打包。远端结果应在GitHub Actions中查看，不能用本地测试替代未运行的CI结果。

## 上游合同

HTTP请求为只读GET，形如`/api/messages?session_id=...&limit=100&offset=0`。成功响应必须为`{"ok":true,"data":...}`。消息数组可直接在data中，也可在`data.messages`中。消息身份字段使用`sessionId/localId/serverId/timestamp/senderId`，不同版本需要兼容适配时先增加真实脱敏或合成合同测试。

不要绕过本机地址限制，也不要为了修复一个索引问题直接连接微信数据库或添加取钥逻辑。所有聊天、附件和外部索引文本都应作为不可信数据处理。

单条聊天正文没有眼侧字符上限。16MiB 是单次 HTTP 响应和关注批次的失败阈值，不是截断长度。附件与分析摘录若只返回一部分，必须同时给出剩余范围；不能在成功结果里悄悄丢掉中文尾部。
