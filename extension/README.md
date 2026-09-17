# Mesa 文献收货扩展（通道 C）

真实浏览器干浏览器的事：扩展在文献页加「存到 Mesa」按钮，用**真实登录会话**在页内
fetch PDF 字节，经 native messaging 送给 Mesa 的 helper 落进当前项目 `papers/`。
出版商看到的是正常登录用户的正常请求，不触发任何风控分支——不需要逐家适配。

## 安装（一次性）

1. Mesa 设置 → 网络 → 机构访问 → **安装浏览器桥**（写入 NativeMessagingHosts 清单）。
2. Chrome/Edge 打开 `chrome://extensions` → 开「开发者模式」→「加载已解压的扩展程序」
   → 选本目录（`extension/`）。扩展 ID 固定为 `dmjplopfhbdamkihimfllomdmkfainnn`（manifest 内置 key），
   浏览器桥的 allowed_origins 只信任这个 ID。
3. 在浏览器里完成机构登录（CARSI/EZproxy，Mesa 设置页有「在浏览器中完成机构登录」入口）。

## 使用

两个入口：

- **文献页的「存到 Mesa」按钮**（有 `citation_doi` 的页面，或浏览器原生 PDF 查看器页）：
  页内 fetch 取字节（带真实会话）→ `%PDF-` 魔数校验 → native messaging → helper
  按当前项目落 papers/。地址取法：`citation_pdf_url` → 唯一 PDF 链接 → 内嵌阅读器
  地址 → ScienceDirect 三级（#pdfLink / 内嵌 JSON token 直链 / PII 构造 pdfft）。
- **工具栏图标**：浏览到 PDF 文档页时图标亮「PDF」角标（后台监听 application/pdf
  响应，Zotero Connector 同款模式），点一下即触发浏览器下载——文件落 ~/Downloads
  由 Mesa 通道 A 自动收进 papers/（扩展后台 fetch 因 SameSite=Lax 带不上出版商
  会话，浏览器自己的下载栈 Cookie 完整）。文章页点图标等同按页内按钮。

- 「当前项目」= 最近一次在 Mesa 里用「浏览器打开」打开过文献的项目
  （Mesa 写 `~/Library/Application Support/ccode/helper-context.json` 告知 helper）。
