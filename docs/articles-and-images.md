# 公众号文章与图片

眼的主入口仍是 MCP。AI 客户端可以先调用 `search_wechat_articles`，用公开微信索引寻找候选文章；如果用户已经自行开通腾讯云 WSA SearchPro，也可以调用 `search_wechat_articles_tencent`，按 `mp.weixin.qq.com` 和最近 N 天检索。腾讯入口默认关闭，凭据只能由用户在客户端安全配置，搜索服务可能收费。两种入口都返回候选，不能证明公众号历史完整，也不能把零结果解释为没有发文。

对候选链接，先调用 `fetch_wechat_article`。如果微信要求验证、登录或验证码，眼会停止网络请求。此时由用户或 AI 客户端在正常浏览器中打开文章，再把已经打开页面的 HTML 作为 `import_wechat_article` 的 `html` 传入；眼不会要求 Cookie、密码或密钥，也不会执行页面脚本。导入后可以用 `get_saved_article` 查看正文和配图清单，用 `read_article_image` 返回单张原生 MCP `image` 内容块，或用 `download_article_images` 下载配图并取得每张图片的 SHA-256。

从聊天中读取分享文章时，先用 `list_shared_articles` 指定会话并按分页读取。该工具只能提取 WxLens 暴露出来的文章 URL；多媒体占位消息没有 URL 时会明确保留未覆盖边界。随后对选出的 URL 调用文章工具。`read_wechat_image` 需要调用方明确提供白名单内的本地标准图片路径；`.dat` 文件不会被猜测、解密或当作图片返回。

## 结果边界

- 文章的账号、发布时间和图片需要以文章页面核对；搜索索引中的名称可能同名，发布时间可能未知或只是索引时间。
- `query_article_history` 只查询本地已获取的文章，不是公众号完整历史。
- 图片受 MIME、magic bytes、尺寸、像素和大小限制；客户端是否展示 MCP 图片取决于客户端本身。
- 普通微信没有经过验证的公众号全量历史 API。腾讯 WSA 是目前发现的可编程自动候选渠道，但需要独立开通和凭据，且仍是搜索发现，不是后台文章列表。
