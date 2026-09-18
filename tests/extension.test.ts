import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

/**
 * 浏览器桥扩展（extension/content.js、background.js、manifest.json）的纯逻辑回归。
 * 359 行 JS 承载的是刚发生过回归的关键行为（54dbdaf 连修三个 bug），此前完全
 * 零测试（2026-09-17 审计）；本文件按 init-script.test.ts 同款手法切函数在 vm 里跑，
 * 另用结构断言守住 background/manifest 的关键纪律（同源代取门禁、超时、权限）。
 */

function readExt(name: string): string {
  return readFileSync(new URL(`../extension/${name}`, import.meta.url), "utf-8");
}

/** 切出 content.js 的取链纯函数块（PDFISH … b64），配 stub 的 location/document */
function runContentPdfUrl(opts: {
  pathname: string;
  origin?: string;
  contentType?: string;
  metaPdf?: string | null;
  metaDoi?: string | null;
  hrefs?: string[];
  embeds?: Array<{ src?: string; data?: string; w?: number; h?: number }>;
}): unknown {
  const js = readExt("content.js");
  const start = js.indexOf("var PDFISH");
  const end = js.indexOf("var btn = null;");
  assert.ok(start > 0 && end > start, "content.js 取链块边界没找到（改了函数顺序？）");
  const origin = opts.origin ?? "https://pubs.rsc.org";
  const sandbox = {
    location: { pathname: opts.pathname, origin, href: origin + opts.pathname },
    document: {
      contentType: opts.contentType,
      querySelector: (sel: string) => {
        if (sel.includes("citation_pdf_url") && opts.metaPdf != null) return { content: opts.metaPdf };
        if (sel.includes("citation_doi") && opts.metaDoi != null) return { content: opts.metaDoi };
        return null;
      },
      querySelectorAll: (sel: string) => {
        if (sel.startsWith("a[href]")) {
          return (opts.hrefs ?? []).map((h) => ({ href: new URL(h, origin).href }));
        }
        if (sel.startsWith("iframe")) {
          return (opts.embeds ?? []).map((e) => ({
            src: e.src ? new URL(e.src, origin).href : e.src,
            offsetWidth: e.w ?? 0,
            offsetHeight: e.h ?? 0,
          }));
        }
        return [];
      },
      getElementById: () => null,
    },
    JSON,
    encodeURIComponent,
    chrome: { runtime: { sendMessage: async () => ({}) } },
  };
  return vm.runInNewContext(`${js.slice(start, end)}\npdfUrl()`, sandbox);
}

test("content pdfUrl：citation_pdf_url 直接信（/pdf 无点结尾不再被误杀）", () => {
  assert.equal(
    runContentPdfUrl({
      pathname: "/2673-6497/22/1/1",
      origin: "https://www.mdpi.com",
      metaPdf: "https://www.mdpi.com/2673-6497/22/1/1/pdf?version=1758111111",
    }),
    "https://www.mdpi.com/2673-6497/22/1/1/pdf?version=1758111111",
  );
});

test("content pdfUrl：DOI 命中链优先、唯一 pdfish 链第二遍采用、多链不猜", () => {
  assert.equal(
    runContentPdfUrl({
      pathname: "/doi/10.1002/adma.202304268",
      metaDoi: "10.1002/adma.202304268",
      hrefs: ["/doi/pdf/10.1002/adma.202304268?download=true"],
    }),
    "https://pubs.rsc.org/doi/pdf/10.1002/adma.202304268?download=true",
  );
  // RSC 形态：链接只有 DOI 后缀——单链采用
  assert.equal(
    runContentPdfUrl({
      pathname: "/en/content/articlehtml/2024/ee/d3ee01234a",
      metaDoi: "10.1039/d3ee01234a",
      hrefs: ["/en/content/articlepdf/2024/ee/d3ee01234a"],
    }),
    "https://pubs.rsc.org/en/content/articlepdf/2024/ee/d3ee01234a",
  );
  // 列表/检索页：多条不同 pdfish 链且都不含本篇 DOI → 不猜
  assert.equal(
    runContentPdfUrl({
      pathname: "/en/journals/issues",
      metaDoi: "10.1039/d3ee01234a",
      hrefs: [
        "/en/content/articlepdf/2024/ee/d3ee00001a",
        "/en/content/articlepdf/2024/ee/d3ee00002a",
      ],
    }),
    null,
  );
});

test("content pdfUrl：SD 文章页不走通用启发式，补充材料链不采、回落 PII 构造", () => {
  const PII = "S092583882604209X";
  assert.equal(
    runContentPdfUrl({
      pathname: `/science/article/pii/${PII}`,
      origin: "https://www.sciencedirect.com",
      metaDoi: "10.1016/j.jallcom.2026.190140",
      hrefs: [`/science/article/pii/${PII}/pdf/mmc1.pdf`],
    }),
    `https://www.sciencedirect.com/science/article/pii/${PII}/pdfft?download=true`,
  );
});

test("content fixPdfUrl：/doi/epdf/ 改写成 /doi/pdf/（终检补：epdf 分支此前零覆盖）", () => {
  // citation_pdf_url 声明的是 epdf 阅读页形态 → fetch 目标应是可下载的 /doi/pdf/
  assert.equal(
    runContentPdfUrl({
      pathname: "/doi/10.1002/adma.202304268",
      metaPdf: "https://onlinelibrary.wiley.com/doi/epdf/10.1002/adma.202304268",
    }),
    "https://onlinelibrary.wiley.com/doi/pdf/10.1002/adma.202304268",
  );
});

/** 切出 background.js 的 allowedFetchTarget（同源代取门禁纯函数）在 vm 里直测 */
function runAllowedFetch(targetUrl: string, senderUrl: string | undefined): boolean {
  const js = readExt("background.js");
  const start = js.indexOf("function allowedFetchTarget");
  const end = js.indexOf("const ownDownloads");
  assert.ok(start > 0 && end > start, "allowedFetchTarget 函数边界没找到");
  return vm.runInNewContext(
    `${js.slice(start, end)}\nallowedFetchTarget(${JSON.stringify(targetUrl)}, ${JSON.stringify(senderUrl)})`,
    { URL },
  ) as boolean;
}

test("background allowedFetchTarget：仅放行与发起页同源的代取（运行时判定，终检补）", () => {
  assert.equal(
    runAllowedFetch("https://pubs.rsc.org/article/pdf", "https://pubs.rsc.org/article"),
    true,
  );
  // 跨源（页面伪造 citation_pdf_url 指向内网/第三方）一律拒绝
  assert.equal(
    runAllowedFetch("https://internal.company/admin", "https://evil-journal.example/article"),
    false,
  );
  assert.equal(
    runAllowedFetch("https://cdn.other.com/x.pdf", "https://pubs.rsc.org/article"),
    false,
  );
  // 无发起页地址 / 畸形 URL：拒绝
  assert.equal(runAllowedFetch("https://a.com/x", undefined), false);
  assert.equal(runAllowedFetch("not a url", "https://a.com/page"), false);
});

test("content pdfUrl：blob: 内嵌阅读器（尺寸可观）不再是盲区（2026-09-17 审计）", () => {
  const hit = runContentPdfUrl({
    pathname: "/reader/12345",
    origin: "https://reader.example.com",
    embeds: [{ src: "blob:https://reader.example.com/uuid-1", w: 900, h: 600 }],
  });
  assert.equal(hit, "blob:https://reader.example.com/uuid-1");
  // 小尺寸的 blob（广告位/像素点）不算
  assert.equal(
    runContentPdfUrl({
      pathname: "/page",
      origin: "https://reader.example.com",
      embeds: [{ src: "blob:https://reader.example.com/uuid-2", w: 10, h: 10 }],
    }),
    null,
  );
});

test("content b64：分块 base64 与整串一致（页侧与 background 同款实现）", () => {
  const js = readExt("content.js");
  const start = js.indexOf("function b64(");
  const end = js.indexOf("var btn = null;");
  assert.ok(start > 0 && end > start, "b64 函数边界没找到");
  const bytes = new Uint8Array(200_000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 3) % 251;
  const out = vm.runInNewContext(
    `${js.slice(start, end)}\nb64(bytes)`,
    { bytes, btoa: (s: string) => Buffer.from(s, "binary").toString("base64") },
  ) as string;
  // Buffer 整串编码必须与分块拼接结果一致（分块只影响性能不影响结果）
  assert.equal(out, Buffer.from(bytes).toString("base64"));
});

test("background：同源代取门禁 + 大文件超时口径（结构断言）", () => {
  const bg = readExt("background.js");
  // 代取仅限发起页同源（sender.tab.url 对比 target.origin），跨源回「跨源地址不代取」
  assert.ok(bg.includes("sender.tab && sender.tab.url"), "代取必须看发起页地址");
  assert.ok(bg.includes("allowedFetchTarget"), "门禁走纯函数（运行时用例见上）");
  assert.ok(bg.includes("跨源地址不代取"), "拒绝文案");
  // 图标点击失败要有反馈（badge + 通知），不再静默
  assert.ok(bg.includes("resp.ok === false"), "content 回包的失败分支必须被消费");
  assert.ok(bg.includes("chrome.notifications.create"), "失败要发系统通知");
  // helper 超时 150s（60MB 解码 + md5 查重可超 60s，旧值会先报失败后悄悄成功）
  assert.ok(bg.includes("150000"), "超时 150s");
  assert.ok(!bg.includes("60000)"), "旧 60s 兜底不得残留");
  // 自触发的下载要把最终路径上报 helper（绕过「监听目录 == 系统 Downloads」假定）；
  // 路径字段是 filename（DownloadItem 没有 finalPath——终检二轮抓出的死链）
  assert.ok(bg.includes("mesa-report-download"), "下载完成要上报路径");
  assert.ok(bg.includes("watchOwnDownload"), "要跟踪自己触发的下载");
  assert.ok(bg.includes("item.filename"), "上报路径取 DownloadItem.filename");
  // 大文件改道收口在 background 的 downloads API（跨源 a[download] 无效），
  // 下载 id 同样进上报跟踪
  assert.ok(bg.includes("mesa-big-download"), "大文件改道消息");
});

test("manifest：permissions 带 notifications；content_scripts 全站注入", () => {
  const m = JSON.parse(readExt("manifest.json"));
  assert.ok(m.permissions.includes("notifications"), "失败通知需要 notifications 权限");
  assert.ok(m.permissions.includes("nativeMessaging"), "native messaging");
  assert.ok(m.permissions.includes("downloads"), "PDF 页图标触发浏览器下载");
  assert.deepEqual(m.content_scripts[0].matches, ["<all_urls>"]);
});

test("content save：45s 超时与 40MB 大文件改道（结构断言）", () => {
  const js = readExt("content.js");
  assert.ok(js.includes("AbortController"), "fetch 必须可超时");
  assert.ok(js.includes("取文件超时"), "超时要给人话错误");
  // 改道阈值常量 + Content-Length 预检（>40MB 不读 body——abort 会掐断读取）
  assert.ok(js.includes("BIG_BYTES"), "40MB 阈值常量");
  assert.ok(js.includes("content-length"), "按 Content-Length 预检");
  assert.ok(js.includes("mesa-big-download"), "大文件经 background downloads API 改道");
  assert.ok(js.includes("已转浏览器下载"), "改道要交代去向");
  assert.ok(js.includes("60MB"), "超过 60MB 上限要如实告知留在下载文件夹");
});

test("content save：重复保存要有 dedup 提示（2026-09-17 用户实测补）", () => {
  const js = readExt("content.js");
  // helper 回执带 dedup（字节级去重命中）时如实说「已有同一份」，
  // 不再静默装作又一次成功
  assert.ok(js.includes("reply.dedup"), "必须消费 helper 回执的 dedup 字段");
  assert.ok(js.includes("未重复存入"), "重复保存要给「已有同一份」提示");
});

test("background：图标下载拿到网页（SD 型反爬）要清掉并指路（用户实测补）", () => {
  const bg = readExt("background.js");
  assert.ok(bg.includes("item.mime"), "完成后要检查 DownloadItem.mime");
  assert.ok(bg.includes("removeFile"), "html 垃圾文件要清掉");
  assert.ok(bg.includes("站方给了网页而不是 PDF"), "要指路页内「存到 Mesa」按钮");
});

test("background：图标优先走页内保存，downloads 只作无 content script 的末路", () => {
  const bg = readExt("background.js");
  const start = bg.indexOf("chrome.action.onClicked");
  const end = bg.indexOf("chrome.runtime.onMessage.addListener");
  assert.ok(start > 0 && end > start, "onClicked 块边界没找到");
  const click = bg.slice(start, end);
  const saveIdx = click.indexOf("mesa-save-from-icon");
  const dlIdx = click.indexOf("chrome.downloads.download");
  assert.ok(saveIdx > 0, "图标要点页内保存");
  assert.ok(dlIdx > saveIdx, "downloads 必须在页内保存之后（PDF 页先下载会拿到 HTML 再被删）");
});

/** 切出 pageDoi 在 vm 里直测 */
function runContentPageDoi(opts: {
  pathname: string;
  origin?: string;
  metaDoi?: string | null;
}): string {
  const js = readExt("content.js");
  const start = js.indexOf("var PDFISH");
  const end = js.indexOf("var btn = null;");
  assert.ok(start > 0 && end > start, "content.js 取链块边界没找到");
  const origin = opts.origin ?? "https://onlinelibrary.wiley.com";
  const sandbox = {
    location: { pathname: opts.pathname, origin, href: origin + opts.pathname },
    document: {
      querySelector: (sel: string) => {
        if (sel.includes("citation_doi") && opts.metaDoi != null) return { content: opts.metaDoi };
        return null;
      },
      querySelectorAll: () => [],
      getElementById: () => null,
    },
  };
  return vm.runInNewContext(`${js.slice(start, end)}\npageDoi()`, sandbox) as string;
}

test("content pageDoi：PDF 阅读器页没有 meta 时从 URL 抠 DOI", () => {
  assert.equal(
    runContentPageDoi({
      pathname: "/doi/pdf/10.1002/adma.202304268",
    }),
    "10.1002/adma.202304268",
  );
  assert.equal(
    runContentPageDoi({
      pathname: "/science/article/pii/S092583882604209X/pdfft",
      origin: "https://www.sciencedirect.com",
      metaDoi: "10.1016/j.jallcom.2026.190140",
    }),
    "10.1016/j.jallcom.2026.190140",
  );
});
