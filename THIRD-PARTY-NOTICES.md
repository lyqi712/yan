# 第三方组件与来源说明

## 眼源码

本项目基于用户提供的 WxLens Reader Extension 3.0.0 源码改进，原源码包含MIT许可声明。眼4.0.0保留原作者版权行，并补齐标准MIT文本。新增实现按同一源码许可提供。

## WxLens与微信

WxLens是独立的本机聊天索引服务。眼使用原整合包4.3.0的HTTP接口合同。源码版不包含其安装器；Windows整合包在源码外保留原有WxLens 4.3.0安装器，供首次安装引导使用。所有发行均排除微信客户端、数据库、账号资料和密钥。

原整合包包含安装器及其再分发授权自述；这不作为将第三方安装器在本公开仓库重新许可为MIT的依据。源码版采用白名单，明确不包含二进制。整合包只接受原包安装器的固定SHA-256：`75fffb0b8226b68a5a3e3c17ad9b01d28945eb53ae59f647c49bb82fdd11567e`，大小263,378,074字节。它保留原组件性质及适用条款，不能从眼的MIT许可推断WxLens也采用MIT。原安装器记录为未签名，setup每次执行前复核完整哈希并要求本机交互确认。

## Node依赖

[Node依赖清单](docs/node-dependencies.md) 记录当前锁文件的全部依赖名称、版本、许可与来源。通过 `npm run licenses` 重新生成。源码发行包不捆绑 `node_modules`；通过npm安装时各包包含自身许可证与版权声明。

主要直接依赖包括 Model Context Protocol TypeScript SDK、Zod、JSZip、yauzl、Mammoth、Cheerio、Acorn、iconv-lite、chardet。Acorn 仅用于静态解析页面脚本中的字面量，不执行脚本。许可证以各包所附文本为准，不能仅把本仓库的MIT视为全部依赖的许可。

## 可选Python与系统组件

| 组件 | 用途 | 许可注意事项 |
| --- | --- | --- |
| RapidOCR | 本地图片文字识别 | 原项目通常采用Apache-2.0，模型许可另行核对 |
| ONNX Runtime | ONNX推理 | MIT；GPU运行环境另有组件条款 |
| PyMuPDF | PDF文本与渲染 | AGPL或商业许可，按实际用途核对义务 |
| xlrd | 旧XLS只读解析 | BSD许可，以安装版本为准 |
| faster-whisper / CTranslate2 | 本地语音转写 | 原项目MIT；语音模型按其各自许可 |
| FFmpeg / ffprobe | 媒体探测与关键帧 | 构建选项决定LGPL/GPL等适用要求 |
| pdftotext / antiword | 系统PDF文本层和旧DOC解析 | 独立外部程序，各自适用其原许可 |

Python直接依赖版本来自原项目环境，已按实际入口拆分为OCR和媒体可选要求；没有分发原Python环境或其传递依赖。本轮未进行完整Python许可证或漏洞审计，不将Node审计结果推广到Python、WxLens或模型。

## 不随源码分发的内容

WxLens安装器、微信安装器、聊天数据、配置实值、数据库、导出证据包、模型、虚拟环境、Python包、FFmpeg、Node.js二进制均不在源码发行包中。自动测试消息全部为虚构样例。
