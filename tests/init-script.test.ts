import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

/**
 * 机构登录窗注入脚本（LOGIN_INIT_SCRIPT / LOGIN_PLACEHOLDER_PAINT）的语法回归。
 * 脚本藏在 Rust 源里，Rust 测试看不见 JS 语法——历史上占位符全量替换两次把脚本
 * 替出非法语法（`window.49238 = 49238`），整段解析失败、窗口内所有注入功能无声
 * 消失（2026-09-16 两次踩坑；现已连占位符机制一起删除，本测试守住不再回归，
 * 并断言下载漏斗的关键件齐全——常驻胶囊、周期重检、fetch→blob 双层抓取）
 */
function extract(constName: string): string {
  const src = readFileSync(
    new URL("../src-tauri/src/inst_access.rs", import.meta.url),
    "utf-8",
  );
  const m = new RegExp(
    `const ${constName}: &str = r#"\\n([\\s\\S]*?)\\n"#;`,
  ).exec(src);
  assert.ok(m, `${constName} 没找到（常量名或 raw string 形式变了？）`);
  return m[1];
}

test("LOGIN_INIT_SCRIPT 是合法 JS，且下载漏斗关键件齐全", () => {
  const js = extract("LOGIN_INIT_SCRIPT");
  new Function(js); // 语法错误会在这里抛
  assert.ok(js.includes("__mesaGrab"), "抓取入口");
  assert.ok(js.includes("__mesaStatusSaved") && js.includes("__mesaStatusFailed"), "终态回写");
  assert.ok(js.includes("__mesaDownloading"), "下载中进度回写（on_download Requested eval）");
  assert.ok(js.includes("60000") && !js.includes("}, 20000)"), "下载看门狗 60s——20s 会把进行中的大文件下载误报成失败（22:56 实测）");
  assert.ok(
    !js.includes("mesaBlobDownload(b,"),
    "禁止 blob 下载（macOS Finished 会挂起，卡在下载中）",
  );
  assert.ok(js.includes("__mesaSaving"), "导航拦截后的保存中状态（跨域 CDN 由 Rust 拉）");
  assert.ok(js.includes("__mesaOpenViewer") && js.includes("mesaViewerUrl"), "存不成时打开 Wiley/ACS 阅读页");
  assert.ok(js.includes("mesaIsEpdf"), "epdf 阅读页必须放行，不得 preventDefault");
  assert.ok(js.includes("citation_doi"), "取 PDF 链接必须用本篇 DOI，不得扫到相关文献");
  assert.ok(js.includes("mesaIsImageUrl"), "不得把文章页导航成图形摘要图片");
  assert.ok(js.includes("view pdf"), "ScienceDirect View PDF 必须改抓取而不是弹图");
  assert.ok(js.includes("setInterval(mesaEnsurePill"), "常驻胶囊必须周期重检，不得一次判定");
  assert.ok(js.includes("credentials: 'include'"), "抓取必须带会话 Cookie");
  assert.ok(js.includes("mesaVerifiedGrab") === false && js.includes("mesaFetchPdfRelay"), "分片回传式抓取（fetch 取字节，不再对同 URL 二次下载）");
  assert.ok(js.includes("mesaChunkRelay"), "字节经 mesa-chunk:// 分片导航回传（blob 下载 macOS 挂死）");
  assert.ok(js.includes("mesa-chunk://c/"), "分片 URL 形态与 Rust parse_chunk_nav 同口径");
  // 分片对齐（2026-09-17 审计）：CHUNK 必须是 3 的倍数——65536%3==1 时非末块
  // btoa 自带 == 填充，Rust 拼接整体解码必挂（>64KB PDF 全部静默丢失）
  assert.ok(js.includes("var CHUNK = 61440"), "分片块长必须是 3 的倍数（61440）");
  // begin 握手：先 mesa-chunk://b/{total} 声明，Rust 只收握手后 60s 内、块数
  // 吻合的分片（窗内任意页面裸塞 mesa-chunk:// 不再被无条件接收）
  assert.ok(js.includes("mesa-chunk://b/"), "分片回传前必须发 begin 握手");
  assert.ok(js.includes("mesaUnescape"), "属性值反转义助手（中间页 &amp; 修正）");
  assert.ok(js.includes("Mesa · 未检出直链"), "未检出直链时胶囊置灰常驻给指引");
  assert.ok(js.includes("__mesaReplay"), "终态跨页重放钩子（页面跳转后补播）");
  assert.ok(js.includes("mesaFallbackDownload(u)"), "合成 a[download] 走 WKDownload");
  assert.ok(js.includes("mesaTryPageButton"), "先借页面自己的下载控件（出版商 token 通道）");
  assert.ok(js.includes("__mesaGrabBusy"), "忙档防递归守卫");
  // ScienceDirect 形态（2026-09-16 用户实测）：不放 citation_pdf_url、PDF 链接不含
  // DOI（PII 路径）、View PDF 是 JS 弹层按钮——通用探测必落空
  assert.ok(js.includes("mesaSdPdfUrl"), "SD 直链兜底必须存在");
  assert.ok(js.includes("/pdfft?download=true"), "SD 按 PII 构造 pdfft 直链（Zotero 同款）");
  assert.ok(js.includes("pdfDownload"), "SD 内嵌 JSON urlMetadata 优先于构造");
  assert.ok(js.includes("getElementById('pdfLink')"), "SD 页面自己的 #pdfLink 最优先");
  assert.ok(js.includes("mesaVerifiedGrab") === false && js.includes("mesaFetchPdfRelay"), "SD 走 fetch 取字节 + 分片回传（下载式请求被回 HTML、导航被 wry 内联白屏——三形态全实测）");
  assert.ok(!js.includes("mesaBlobDownload"), "blob→a[download] 落盘禁令（macOS Finished 挂死，20:33 实测）");
  assert.ok(js.includes("首发下载必须对该 URL 零请求"), "grab 通用路径不得做 fetch 预检，直接单次 a[download]");
  assert.ok(js.includes("setTimeout(r2, 2000)"), "回救必须先歇 2s 过站点连击限速窗");
  assert.ok(js.includes("60000"), "合成下载的 <a> 必须延迟移除（过早 remove 可能取消在途下载）");
  assert.ok(js.includes("下载仍在等待结果"), "「下载中」必须有看门狗（60s，文案不得把进行中的下载断言为失败）");
  assert.ok(js.includes("mesaIntermediaryNext"), "中间页 meta refresh/redirect/iframe 解析");
  assert.ok(js.includes("mesaIsSdPdfLink"), "SD pdfft 分型判定（路由到 fetch+分片回传）");
  assert.ok(js.includes("mesaIsSdPage"), "SD 页面不拦 View PDF——进站方阅读器再取（用户拍板）");
  assert.ok(js.includes("!mesaIsSdPage() && await mesaTryPageButton()"), "SD 页面不得点站方下载控件（下载式请求被挂起/回 HTML）");
  assert.ok(js.includes("mesaIsMdpiLink"), "MDPI 跨域 CDN 型路由到 Rust 会话直拉（导航拦截触发）");
  assert.ok(js.includes("iframe[src], object[data], embed[src]"), "站方阅读器内嵌 PDF 地址识别（View PDF 弹层）");
  assert.ok(js.includes("__mesaGrabVerified"), "got-html 回救钩子（Rust 拿到网页时页侧解析重试）");
  assert.ok(js.includes("第二遍"), "链接不含 DOI 前缀的出版商（RSC/SD/IEEE）第二遍单链采用");
  assert.ok(js.includes("closest('a[href]')"), "View PDF 命中后必须沿祖先找 <a> 的 href");
  assert.ok(js.includes("创建即上文案"), "胶囊创建即上文案——空胶囊就是黑圈，用户以为坏了");
  assert.ok(js.includes("location.protocol === 'about:'"), "about:blank 必须自己刷浅底，不能等 eval");
  assert.ok(js.includes("打开超时"), "占位页超时必须给下一步，不能一直转");
  assert.ok(js.includes("colorScheme = 'light'"), "深色系统下 about:blank 默认黑屏");
  assert.ok(js.includes("preventDefault()"), "点 PDF 链接必须拦住导航");
  assert.ok(js.includes("mesaLooksLikePdf"), "fetch 结果必须验 %PDF 魔数");
  assert.ok(js.includes("image/"), "图片 Content-Type 不得当 PDF 存");
  assert.ok(
    !js.includes("if (selfheal) { location.href"),
    "selfheal 不得 location.href 打开放 PDF（会内联成图片）",
  );
  // 占位符机制已删——再出现说明有人把页→本机回传的旧方案带回来了
  assert.ok(!js.includes("__MESA_RELAY_PORT"), "不得再有页→127.0.0.1 回传变量");
});

test("LOGIN_PLACEHOLDER_PAINT 是合法 JS", () => {
  new Function(extract("LOGIN_PLACEHOLDER_PAINT"));
});

/** 从注入脚本里切出 mesaSdPdfUrl，配 stub 的 location/document 在 vm 里跑 */
function runSdPdfUrl(pathname: string, origin: string, scripts: string[], pdfLink?: string): unknown {
  const js = extract("LOGIN_INIT_SCRIPT");
  const start = js.indexOf("function mesaSdPdfUrl");
  const end = js.indexOf("function mesaIntermediaryNext");
  assert.ok(start > 0 && end > start, "mesaSdPdfUrl 函数边界没找到（改了函数顺序？）");
  const fn = js.slice(start, end);
  const reLine = js.match(/var mesaPdfRe = [^\n]+;/);
  assert.ok(reLine, "mesaPdfRe 声明没找到");
  const sandbox = {
    location: { pathname, origin, href: origin + pathname },
    document: {
      querySelectorAll: () => scripts.map((t) => ({ textContent: t })),
      getElementById: (id: string) =>
        id === "pdfLink" && pdfLink ? { href: pdfLink } : null,
    },
    JSON,
    encodeURIComponent,
  };
  return vm.runInNewContext(`${reLine[0]}\n${fn}\nmesaSdPdfUrl()`, sandbox);
}

test("mesaSdPdfUrl：pdfLink/JSON/PII 三级优先、期刊页不构造", () => {
  const PII = "S092583882604209X";
  const constructed = `https://www.sciencedirect.com/science/article/pii/${PII}/pdfft?download=true`;
  // 文章页（含 abs 变体）：按 PII 构造，无内嵌 JSON 时也够用（Zotero 同款兜底）
  assert.equal(
    runSdPdfUrl(`/science/article/pii/${PII}`, "https://www.sciencedirect.com", []),
    constructed,
  );
  assert.equal(
    runSdPdfUrl(`/science/article/abs/pii/${PII}`, "https://www.sciencedirect.com", []),
    constructed,
  );
  // 页面自己的 #pdfLink（href 是站方链接，可能带 isDTMRedir 等参数）优先于构造
  assert.equal(
    runSdPdfUrl(
      `/science/article/pii/${PII}`,
      "https://www.sciencedirect.com",
      [],
      `https://www.sciencedirect.com/science/article/pii/${PII}/pdfft?isDTMRedir=true&download=true`,
    ),
    `https://www.sciencedirect.com/science/article/pii/${PII}/pdfft?isDTMRedir=true&download=true`,
  );
  // pdfLink 是「#」占位（无权限形态）不得当直链
  assert.equal(
    runSdPdfUrl(`/science/article/pii/${PII}`, "https://www.sciencedirect.com", [], "#"),
    constructed,
  );
  // EZproxy 改写域：构造必须走代理 origin（同源下载才带代理会话）
  assert.equal(
    runSdPdfUrl(
      `/science/article/pii/${PII}`,
      "https://www-sciencedirect-com.ezproxy.uni.edu.cn",
      [],
    ),
    `https://www-sciencedirect-com.ezproxy.uni.edu.cn/science/article/pii/${PII}/pdfft?download=true`,
  );
  // 内嵌 JSON（机构网络预加载数据）优先于构造
  const json = JSON.stringify({
    article: {
      pdfDownload: {
        urlMetadata: {
          path: "science/article/pii",
          pii: PII,
          pdfExtension: "/pdfft",
          queryParams: { md5: "a1b2c3", pid: "1-s2.0-S092583882604209X-main.pdf" },
        },
      },
    },
  });
  assert.equal(
    runSdPdfUrl(`/science/article/pii/${PII}`, "https://www.sciencedirect.com", [json]),
    `https://www.sciencedirect.com/science/article/pii/${PII}/pdfft?md5=a1b2c3&pid=${encodeURIComponent(
      "1-s2.0-S092583882604209X-main.pdf",
    )}`,
  );
  // 无关 JSON（不含 pdfDownload）不得影响兜底构造
  assert.equal(
    runSdPdfUrl(`/science/article/pii/${PII}`, "https://www.sciencedirect.com", ["{}"]),
    constructed,
  );
  // 期刊页/首页没有单篇 PII：不得构造（构造必错）
  assert.equal(
    runSdPdfUrl("/journal/jallcom", "https://www.sciencedirect.com", []),
    null,
  );
  assert.equal(runSdPdfUrl("/", "https://www.sciencedirect.com", []), null);
  // 其他站路径形态不构造
  assert.equal(
    runSdPdfUrl("/doi/10.1016/j.jallcom.2026.190140", "https://onlinelibrary.wiley.com", []),
    null,
  );
});

/** 从注入脚本里切出 mesaUnescape + mesaIntermediaryNext（中间页跳转解析纯函数）在 vm 里跑 */
function runIntermediary(html: string): unknown {
  const js = extract("LOGIN_INIT_SCRIPT");
  const start = js.indexOf("function mesaUnescape");
  const end = js.indexOf("function mesaB64Chunk");
  assert.ok(start > 0 && end > start, "mesaUnescape/mesaIntermediaryNext 函数边界没找到");
  const reLine = js.match(/var mesaPdfRe = [^\n]+;/);
  assert.ok(reLine, "mesaPdfRe 声明没找到");
  return vm.runInNewContext(
    `${reLine[0]}\n${js.slice(start, end)}\nmesaIntermediaryNext(${JSON.stringify(html)})`,
    {},
  );
}

test("mesaIntermediaryNext：meta refresh / redirect / iframe 内嵌三种中间页都认", () => {
  assert.equal(
    runIntermediary(
      `<head><meta HTTP-EQUIV="Refresh" CONTENT="0;URL=https://www.sciencedirect.com/science/article/pii/S1/pdfft?md5=x"></head>`,
    ),
    "https://www.sciencedirect.com/science/article/pii/S1/pdfft?md5=x",
  );
  // 相对地址 / 小写 / content 在前都认
  assert.equal(
    runIntermediary(
      `<meta content='2; url=/science/article/pii/S2/pdfft' http-equiv="refresh">`,
    ),
    "/science/article/pii/S2/pdfft",
  );
  assert.equal(
    runIntermediary(
      `<div id="redirect-message"><p>Redirecting</p><a href="https://pdf.example.com/paper.pdf">here</a></div>`,
    ),
    "https://pdf.example.com/paper.pdf",
  );
  // IEEE stamp.jsp 形态：iframe 内嵌 ielx 直链
  assert.equal(
    runIntermediary(
      `<html><body><iframe src="/ielx7/80/2655/09876543.pdf?tp=&arnumber=9876543&isnumber=2655" width="100%"></iframe></body></html>`,
    ),
    "/ielx7/80/2655/09876543.pdf?tp=&arnumber=9876543&isnumber=2655",
  );
  // SD PdfEmbed 形态：object data
  assert.equal(
    runIntermediary(
      `<object data="/science/article/pii/S3/pdfft?md5=y" type="application/pdf"></object>`,
    ),
    "/science/article/pii/S3/pdfft?md5=y",
  );
  // 非 pdfish 的 iframe（广告/统计）不得误认
  assert.equal(
    runIntermediary(`<iframe src="https://cdn.example.com/widget.js"></iframe>`),
    null,
  );
  // 普通文章页不是中间页
  assert.equal(
    runIntermediary(`<html><body><h1>Article</h1><p>full text</p></body></html>`),
    null,
  );
});

test("mesaIntermediaryNext：属性值里的 &amp; 必须反转义（2026-09-17 审计）", () => {
  // SD pdfft 跳转页形态：meta refresh 的 content 里 & 序列化成 &amp;——
  // 不反转义会把 amp;pid 当独立参数，服务端校验 md5+pid 时 pid 缺失回错误页
  assert.equal(
    runIntermediary(
      `<meta http-equiv="Refresh" CONTENT="0;URL=https://pdf.sciencedirect.com/x/paper.pdf?md5=a1b2&amp;pid=1-s2.0-main.pdf">`,
    ),
    "https://pdf.sciencedirect.com/x/paper.pdf?md5=a1b2&pid=1-s2.0-main.pdf",
  );
  // redirect-message 与 iframe src 同款处理
  assert.equal(
    runIntermediary(
      `<div id="redirect-message"><a href="https://a.edu/p.pdf?x=1&amp;y=2">here</a></div>`,
    ),
    "https://a.edu/p.pdf?x=1&y=2",
  );
  assert.equal(
    runIntermediary(`<iframe src="/ielx/1/2/p.pdf?tp=&amp;arnumber=9"></iframe>`),
    "/ielx/1/2/p.pdf?tp=&arnumber=9",
  );
});

/** 从注入脚本切出 mesaPdfUrl 所在纯函数块，验证第二遍单链采用口径 */
function runPdfUrl(opts: {
  pathname: string;
  origin?: string;
  metaPdf?: string | null;
  metaDoi?: string | null;
  hrefs?: string[];
  embeds?: string[];
}): unknown {
  const js = extract("LOGIN_INIT_SCRIPT");
  const start = js.indexOf("var mesaPdfRe");
  const end = js.indexOf("function mesaLooksLikePdf");
  assert.ok(start > 0 && end > start, "mesaPdfUrl 解析块边界没找到");
  const origin = opts.origin ?? "https://pubs.rsc.org";
  const sandbox = {
    location: { pathname: opts.pathname, origin, href: origin + opts.pathname },
    document: {
      querySelector: (sel: string) => {
        if (sel.includes("citation_pdf_url") && opts.metaPdf != null) return { content: opts.metaPdf };
        if (sel.includes("citation_doi") && opts.metaDoi != null) return { content: opts.metaDoi };
        return null;
      },
      querySelectorAll: (sel: string) =>
        sel.startsWith("a[href]")
          ? (opts.hrefs ?? []).map((h) => ({ href: new URL(h, origin).href }))
          : (opts.embeds ?? []).map((s) => ({ src: new URL(s, origin).href })),
      getElementById: () => null,
    },
    JSON,
    encodeURIComponent,
  };
  return vm.runInNewContext(`${js.slice(start, end)}\nmesaPdfUrl()`, sandbox);
}

test("mesaPdfUrl：citation_pdf_url 优先、DOI 命中优先、单链第二遍采用、多链不猜", () => {
  // RSC 形态：无 citation_pdf_url、链接只有 DOI 后缀（articlepdf/2024/ee/d3ee01234a
  // 不含 10.1039/ 前缀）——文章页只有一条 PDF 链接，第二遍采用
  assert.equal(
    runPdfUrl({
      pathname: "/en/content/articlehtml/2024/ee/d3ee01234a",
      metaDoi: "10.1039/d3ee01234a",
      hrefs: ["/en/content/articlepdf/2024/ee/d3ee01234a"],
    }),
    "https://pubs.rsc.org/en/content/articlepdf/2024/ee/d3ee01234a",
  );
  // 列表/检索页保护：多条不同 PDF 链接且都不含本篇 DOI → 不猜
  assert.equal(
    runPdfUrl({
      pathname: "/en/journals/issues",
      metaDoi: "10.1039/d3ee01234a",
      hrefs: [
        "/en/content/articlepdf/2024/ee/d3ee00001a",
        "/en/content/articlepdf/2024/ee/d3ee00002a",
      ],
    }),
    null,
  );
  // 链接含本篇 DOI：直接命中（Wiley/T&F/IOP/ACS 形态）
  assert.equal(
    runPdfUrl({
      pathname: "/doi/10.1002/adma.202304268",
      metaDoi: "10.1002/adma.202304268",
      hrefs: ["/doi/pdf/10.1002/adma.202304268?download=true"],
    }),
    "https://pubs.rsc.org/doi/pdf/10.1002/adma.202304268?download=true",
  );
  // citation_pdf_url meta 最优先（Springer/Nature/多数出版商形态）
  assert.equal(
    runPdfUrl({
      pathname: "/article/10.1007/s00894-026-0001-x",
      metaPdf: "https://link.springer.com/content/pdf/10.1007/s00894-026-0001-x.pdf",
      metaDoi: "10.1007/s00894-026-0001-x",
      hrefs: ["/article/10.1007/s00894-026-0001-x.pdf"],
    }),
    "https://link.springer.com/content/pdf/10.1007/s00894-026-0001-x.pdf",
  );
  // 页面没有 citation_doi：无从校对，维持首链旧口径（不新增猜测）
  assert.equal(
    runPdfUrl({ pathname: "/some/page", hrefs: ["/files/a.pdf"] }),
    "https://pubs.rsc.org/files/a.pdf",
  );
  // 站方阅读器（SD View PDF 弹层）：无 meta 无链接，PDF 内嵌在 iframe——
  // 取内嵌地址（用户拍板：View PDF 不拦、进阅读器再取）
  assert.equal(
    runPdfUrl({
      pathname: "/science/article/pii/S092583882604209X",
      origin: "https://www.sciencedirect.com",
      metaDoi: "10.1016/j.jallcom.2026.190140",
      embeds: ["/science/article/pii/S092583882604209X/pdfft?md5=t&pid=p.pdf"],
    }),
    "https://www.sciencedirect.com/science/article/pii/S092583882604209X/pdfft?md5=t&pid=p.pdf",
  );
  // SD 文章页：页内唯一 pdfish 锚链是补充材料（mmc1.pdf）——通用单链采用会
  // 误收，SD 整页不进通用启发式，回落 PII 构造兜底（2026-09-17 对齐口径）
  assert.equal(
    runPdfUrl({
      pathname: "/science/article/pii/S092583882604209X",
      origin: "https://www.sciencedirect.com",
      metaDoi: "10.1016/j.jallcom.2026.190140",
      hrefs: ["/science/article/pii/S092583882604209X/pdf/mmc1.pdf"],
    }),
    "https://www.sciencedirect.com/science/article/pii/S092583882604209X/pdfft?download=true",
  );
});

test("语法门自检：老 bug 形态（变量名被替换成数字）必须被抓住", () => {
  const broken = "window.41234 = 41234; window.__mesaGrab = 1;";
  assert.throws(() => new Function(broken), /Unexpected number|Invalid or unexpected/);
});
