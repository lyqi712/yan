# 可选文件解析运行时

基础聊天、人物提取、多群扫描和关注列表只需要 Node.js。Python、OCR和媒体组件是可选能力，未安装时会明确降级或报告对应解析器缺失。

## 按需安装

建议使用 Python 3.11 的独立虚拟环境。以下命令会从 PyPI 下载第三方依赖，只有你明确需要相关能力时再执行。眼的基础安装脚本不会执行这些命令，也不会因为可选解析器缺失而下载依赖。若本机已经有合适的 Python 环境和模块，可先运行 `npm run optional:local`：它只探测 `ocr-runtime/.venv`、已配置的 `WXLENS_*_PYTHON`、Windows `py -3.11` 或 PATH 中的 Python，写入 `.local/optional-runtime.json` 供眼后续使用；不会运行 `pip`、联网、下载模型或改变系统 Python。探测不到的能力继续保持 `optional`，不会伪装成已安装。

Windows：

```powershell
py -3.11 -m venv ocr-runtime/.venv
ocr-runtime/.venv/Scripts/python.exe -m pip install -r ocr-runtime/requirements-ocr.txt
```

Linux/macOS：

```bash
python3.11 -m venv ocr-runtime/.venv
ocr-runtime/.venv/bin/python -m pip install -r ocr-runtime/requirements-ocr.txt
```

音视频需要额外安装 `requirements-media.txt`，并在系统 PATH 中提供 `ffmpeg` 与 `ffprobe`。旧 XLS 仅需要 xlrd；若只需该功能，可以在上述虚拟环境安装 `xlrd==2.0.2`。如果不允许联网安装，使用 `npm run optional:local` 只启用本机已存在的 xlrd、RapidOCR/PyMuPDF 或 faster-whisper；`npm run doctor` 会分别显示解析器是否可用。

这些文件锁定原项目使用的直接依赖版本，不是跨平台完整的传递依赖锁。实际安装需要对应平台有兼容wheel。当前源码验收未下载大型模型、未完成全新 Python 环境的模型质量测试；遇到版本或平台不兼容时应保留安装错误，不能以路径存在当作功能验收。

## OCR模型需手动准备

在 `ocr-runtime/models/`（或 `WXLENS_OCR_MODEL_DIR` 指定目录）准备与你选择的 RapidOCR 模型配套的文件：

```text
models/
  det.onnx
  rec.onnx
  cls.onnx
  keys.txt
```

检测、识别、方向分类与字符表必须互相匹配，文件名不代表任意模型可通用。请从相应模型作者的合法来源下载，并遵守其许可。代码在调用 RapidOCR 前检查这些文件；缺失时不自动下载模型。

PDF 优先逐页读取原生文本；没有文本的页面再做 OCR。混合 PDF 不会因为某一页有文本，就直接跳过其他扫描页。默认最多处理前200页，可通过 `WXLENS_PDF_MAX_PAGES` 调整至1–500页，输出包含总页数、已处理页数与未覆盖警告。若仅有系统 `pdftotext`，只覆盖文本层，扫描页会有能力边界说明。

## 本地语音与视频

`faster-whisper` 默认查找本地缓存的 `small` 模型。你也可以把 `WXLENS_ASR_MODEL` 指向已下载的模型目录，或用 `WXLENS_ASR_MODEL_DIR` 指定缓存位置。读取时启用 `local_files_only=True`，缺少模型时返回 ASR 不可用说明。

视频抽取全时段采样关键帧做 OCR，不代表逐帧完整解析。默认最多24帧，可用 `WXLENS_VIDEO_MAX_KEYFRAMES` 调整至3–60。缺OCR模型时保留可用的语音结果并显示视频文字未读警告；缺语音模型时可保留其他媒体证据。

## 兼容环境变量

| 变量 | 用途 |
| --- | --- |
| `WXLENS_HTTP_BASE_URL` | 本机WxLens服务地址，优先于本地配置 |
| `WXLENS_ACCOUNT_DIR` | 明确的账号目录，优先于本地配置 |
| `WXLENS_OCR_ROOT` | 可选运行时目录 |
| `WXLENS_OCR_PYTHON` / `WXLENS_XLS_PYTHON` / `WXLENS_MEDIA_PYTHON` | 指定相应Python解释器 |
| `WXLENS_OCR_MODEL_DIR` | 本地ONNX模型及字符表目录 |
| `WXLENS_ASR_MODEL` / `WXLENS_ASR_MODEL_DIR` | 语音模型名称或本地位置 |
| `WXLENS_ASR_DEVICE` / `WXLENS_ASR_COMPUTE_TYPE` | CPU/GPU及计算精度，由使用者按环境配置 |

更改运行时环境变量后需重启MCP进程。`WXLENS_DESKTOP_EXE`指定WxLens启动程序；查询时可自动后台启动，设`WXLENS_AUTO_START=false`关闭。安装器仅由setup交互确认运行，不依赖Electron的Node模式。

## 许可与资源

PyMuPDF 采用 AGPL / 商业双许可，RapidOCR、ONNX Runtime、faster-whisper、FFmpeg构建和模型各自适用其许可。请根据实际使用和分发方式核对原项目许可。源码包不包含 Python site-packages、ffmpeg、模型或虚拟环境，也不把第三方组件重新许可为MIT。

大型文件仍可能消耗较多内存或CPU。基础文件输入上限256MiB；ZIP/Office预检限制单个展开项10MiB、累计50MiB、最多2000项。媒体与OCR子进程有超时；大型任务建议单独运行并调整AI客户端的工具超时。
