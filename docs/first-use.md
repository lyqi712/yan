# 第一次接入：安装 → WxLens初始化 → 在AI里直接问

眼的日常入口是Codex、Claude Desktop、Cursor、Proma等AI软件中的MCP。只在第一次安装、微信账号初始化或故障恢复时，需要打开WxLens自己的界面。

```text
你在AI软件提问
      ↓
AI调用眼的MCP工具
      ↓
眼连接本机WxLens（需要时后台启动）
      ↓
读取指定群/人物/时间的索引和已下载附件
      ↓
带来源与覆盖边界返回给AI，AI完成总结
```

## 已经在使用原项目

1. 解压眼到单独文件夹，保留原WxLens安装和数据。
2. 安装Node.js 22+，双击`install.cmd`安装Node依赖。
3. 首次设置会检查常见WxLens安装位置。若已完成登录和索引，可跳过重新初始化；自定义位置用`node src/cli.js config --wxlens-exe "完整路径/WxLens.exe"`指定。
4. 生成新MCP配置并替换AI客户端中的旧扩展入口。多个扩展同时提供相同微信工具时，建议在客户端停用不再使用的旧入口，避免AI混选；眼不会替你改客户端配置。
5. 在AI里说：“列出最近活跃的群聊，帮我总结其中××群今天的讨论。”

## 一台尚未安装的Windows电脑

1. 安装Node.js 22+。
2. 解压整合包，双击`install.cmd`。安装基础依赖后，脚本进入`setup`。
3. 若没有发现WxLens，setup会核对`vendor/WxLens-4.3.0-Setup.exe`的大小与SHA-256。输入y才运行交互式安装器，取消不会后台强制安装。
4. 打开WxLens，在其原界面完成微信登录，以及界面要求的扫码、一次性密钥获取和本地初始化。
5. 等待其本地索引可查询，确认HTTP服务默认端口5032可用。
6. 把生成的MCP配置放进AI软件，重新加载MCP，再用自然语言提问。

源码ZIP不包含WxLens安装器；已有WxLens可直接使用源码版。缺少安装器时请使用项目提供的整合包或自己已获授权的WxLens来源，不要从不明镜像随意下载。原来源记录中的安装器未签名；SHA-256仅确认文件与原整合包一致，不等于代码签名或程序行为审查。眼没有执行该安装器、实际扫码或密钥流程来做源码验收；界面名称和步骤以原程序为准。

## Codex配置示例

在眼目录执行：

```bash
node src/cli.js mcp-config --client codex
```

输出类似以下TOML，使用命令实际生成的本机路径合并进Codex MCP配置：

```toml
[mcp_servers.yan]
command = "C:/Program Files/nodejs/node.exe"
args = ["D:/Tools/yan/src/server.js"]
startup_timeout_sec = 30
```

MCP的command是`node`，args指向`src/server.js`。不需要网页URL，不需要额外后台控制台，也不要把`setup`当作MCP命令。`setup`需要本人操作；`server.js`只处理stdio协议。

## 常见情况

| 现象 | 处理 |
|---|---|
| AI能看到工具，查询提示服务未就绪 | 运行setup打开WxLens，完成首次登录、密钥获取及索引；MCP握手成功不代表索引已就绪 |
| 默认位置找不到WxLens | 用`config --wxlens-exe`指定实际程序路径 |
| 已在使用其他端口 | 用`config --base-url http://127.0.0.1:端口`；只允许回环IP |
| 不想自动启动WxLens | 在MCP启动环境设`WXLENS_AUTO_START=false`；之后自行打开服务 |
| 群聊可读、附件找不到 | 明确配置包含`db_storage`的账号目录，确保文件已在微信中下载；多个账号不得自动混选 |
| 登录后仍没有记录 | 等待WxLens索引完成，核对所选账号、日期和本地留存情况；扫码本身不能证明所有历史都已获取 |
| 工具超时 | 初次后台启动最多额外等待约15秒。大型批量/OCR任务需调高AI客户端工具超时或缩小本轮范围 |
| 路径移动后MCP启动失败 | 在新位置重新运行`mcp-config`并替换客户端路径 |

所有密钥处理均在WxLens原本流程中进行；不要把密钥粘贴到聊天、MCP参数、GitHub Issue或导出包。眼的设置只需要程序路径、服务地址及可选附件目录。
