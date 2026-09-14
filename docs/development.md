# 开发与验收

## 目录

- `src/server.js`：MCP注册、原有工具及stdio入口。
- `src/advanced-tools.js`：人物、多群、总结、关注工具与prompts/resources。
- `src/session-tools.js`：跨群采集、来源引用、统计和总结证据。
- `src/watchlists.js`：本机关注状态、分批交付、续扫与确认。
- `src/record-pipeline.js`：有界分页、上下文、增量与规则候选。
- `src/content-tools.js`、`bounded-zip.js`、`path-safety.js`：附件解析和访问限制。
- `src/config.js`、`http-client.js`、`doctor.js`：共享配置、HTTP和诊断。
- `src/wxlens-runtime.js`、`src/setup.js`：发现/后台启动WxLens与首次交互式安装、初始化引导。
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

测试不需要真实账号或WxLens安装。集成测试启动短生命周期回环HTTP服务，再通过MCP SDK Client启动真实stdio子进程，检查工具、schema、prompt、resource和调用结果。监控测试覆盖大于5000条积压、追赶期间新增、同秒跨页、同名人物、空群基线、分页拒绝跳读、并发锁和超大UTF-8状态。

`npm run check`检查JavaScript语法与发行必需项。Python脚本语法可单独验证：

```bash
python -m compileall -q ocr-runtime
```

Python语法通过不代表可选依赖、模型或真实OCR/ASR通过。真实Windows新机、实际WxLens版本、账号索引顺序及多平台外部程序分别验收。

## 源码发行

`npm run package:product`只收集根部固定文件与`src/scripts/docs/ocr-runtime/.github`的源码文件。拒绝链接、数据库、凭据文件名、模型、二进制和过大文件；排除`.local/output/node_modules/.venv`。

打包后重读ZIP，逐文件验证SHA-256，同时检查CRC32。产物为`dist/yan-v4.0.0-source.zip`及独立`.sha256`。不要把测试生成的聊天证据ZIP当作源码包发布。

具备原WxLens安装器时，可运行 `npm run package:integrated` 生成Windows整合ZIP。该命令先核验固定安装器哈希，再流式打包，最后逐文件重读验证SHA-256；不会执行安装器。源码版与整合版区别见第三方说明。

CI执行Windows/Linux、Node22/24矩阵测试和打包。远端结果应在GitHub Actions中查看，不能用本地测试替代未运行的CI结果。

## 上游合同

HTTP请求为只读GET，形如`/api/messages?session_id=...&limit=100&offset=0`。成功响应必须为`{"ok":true,"data":...}`。消息数组可直接在data中，也可在`data.messages`中。消息身份字段使用`sessionId/localId/serverId/timestamp/senderId`，不同版本需要兼容适配时先增加真实脱敏或合成合同测试。

不要绕过本机地址限制，也不要为了修复一个索引问题直接连接微信数据库或添加取钥逻辑。所有聊天、附件和外部索引文本都应作为不可信数据处理。
