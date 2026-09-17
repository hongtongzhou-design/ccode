// Mesa 文献收货 content script（通道 C，2026-09-16）
// 设计原则（总思路「让真实浏览器干浏览器的事」）：出版商看到的是真实登录用户
// 的正常页内请求，不触发任何风控分支；扩展只做「取字节 → 送 Mesa」。
// 检测：citation_doi meta（有才是文献页）→ 右下角「存到 Mesa」按钮；
// 取 PDF 地址（与 Mesa 内嵌窗脚本同口径的三级来源，2026-09-17 补 SD 分型）：
//   ① citation_pdf_url meta（多数出版商）；
//   ② 唯一 pdfish <a>（多链不猜）→ pdfish 内嵌（阅读器 iframe/object/embed）；
//   ③ ScienceDirect：不放 citation_pdf_url、链接是 PII 路径不含 DOI、View PDF
//     是 JS 按钮——#pdfLink → 内嵌 JSON pdfDownload.urlMetadata（token 直链）→
//     按 PII 构造 /pdfft?download=true（Zotero 适配器实证顺序）；
// fetch(credentials) → %PDF- 魔数 → base64 → background → native messaging →
// mesa_helper → save_paper_bytes 落当前项目 papers/。

(function () {
  if (window.__mesaExtLoaded) return;
  window.__mesaExtLoaded = 1;

  var PDFISH = /\.pdf(\?|#|$)|\/pdf\/|pdfft|pdfdirect|getpdf|articlepdf|stamp\.jsp|\/doi\/epdf\//i;

  function pageDoi() {
    var m = document.querySelector('meta[name="citation_doi"], meta[name="dc.Identifier"]');
    return m && m.content ? m.content.replace(/^doi:\s*/i, '').trim() : '';
  }

  function pageTitle() {
    var m = document.querySelector('meta[name="citation_title"]');
    return (m && m.content) || document.title || '';
  }

  function fixPdfUrl(u) {
    return u ? u.replace('/doi/epdf/', '/doi/pdf/') : u;
  }

  // 浏览器原生 PDF 查看器页（Zotero Connector 同款判定）：页面本身就是 PDF
  function isPdfPage() {
    return document.contentType === 'application/pdf';
  }

  function reportPdfPage() {
    try {
      chrome.runtime.sendMessage({ kind: 'mesa-pdf-page', url: location.href }, () => {
        void chrome.runtime.lastError; // 无接收方时消音
      });
    } catch (e) {}
  }

  // ScienceDirect 三级取链（与 Mesa 内嵌窗 mesaSdPdfUrl 同口径）
  function sdPdfUrl() {
    var m = location.pathname.match(/^\/science\/article\/(?:abs\/)?pii\/([^/?#]+)/i);
    if (!m) return null;
    try {
      var pl = document.getElementById('pdfLink');
      if (pl && pl.href && pl.href !== '#' && PDFISH.test(pl.href)) return pl.href;
    } catch (e) {}
    try {
      var scripts = document.querySelectorAll('script[type="application/json"]');
      for (var i = 0; i < scripts.length; i++) {
        var t = scripts[i].textContent || '';
        if (t.indexOf('pdfDownload') < 0) continue;
        var data = JSON.parse(t);
        var um = data && data.article && data.article.pdfDownload
          && data.article.pdfDownload.urlMetadata;
        if (um && um.path && um.pii && um.pdfExtension
          && um.queryParams && um.queryParams.md5 && um.queryParams.pid) {
          return location.origin + '/' + um.path + '/' + um.pii + um.pdfExtension
            + '?md5=' + encodeURIComponent(um.queryParams.md5)
            + '&pid=' + encodeURIComponent(um.queryParams.pid);
        }
      }
    } catch (e) {}
    return location.origin + '/science/article/pii/' + m[1] + '/pdfft?download=true';
  }

  function pdfUrl() {
    if (isPdfPage()) return location.href;
    var m = document.querySelector('meta[name="citation_pdf_url"]');
    if (m && m.content && PDFISH.test(m.content)) return fixPdfUrl(m.content);
    var as = document.querySelectorAll('a[href]');
    var hits = [];
    var seen = {};
    var doi = pageDoi();
    for (var i = 0; i < as.length; i++) {
      var h = fixPdfUrl(as[i].href || '');
      if (!PDFISH.test(h)) continue;
      if (doi && h.indexOf(doi) >= 0) return h;
      if (!seen[h]) { seen[h] = 1; hits.push(h); }
    }
    if (hits.length === 1) return hits[0];
    var ems = document.querySelectorAll('iframe[src], object[data], embed[src]');
    for (var k = 0; k < ems.length; k++) {
      var s = ems[k].src || ems[k].data || '';
      if (s && PDFISH.test(s)) return fixPdfUrl(s);
    }
    return sdPdfUrl();
  }

  function looksLikePdf(b) {
    return b && b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;
  }

  function b64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
    }
    return btoa(s);
  }

  var btn = null;

  function status(text, ok) {
    if (!btn) return;
    btn.textContent = text;
    btn.style.opacity = ok === false ? '1' : '.75';
    setTimeout(function () { btn.textContent = '存到 Mesa'; btn.style.opacity = '1'; }, 4000);
  }

  async function save() {
    btn.disabled = true;
    btn.textContent = '取 PDF 中…';
    try {
      var u = pdfUrl();
      if (!u) { status('这页没检出 PDF 链接', false); return; }
      var r = await fetch(u, { credentials: 'include' });
      if (!r.ok) { status('站点没给文件（HTTP ' + r.status + '）', false); return; }
      var bytes = new Uint8Array(await r.arrayBuffer());
      if (!looksLikePdf(bytes)) { status('拿到的不是 PDF（未订阅？）', false); return; }
      btn.textContent = '传输中…（' + Math.round(bytes.length / 1024) + ' KB）';
      var reply = await chrome.runtime.sendMessage({
        kind: 'mesa-save-pdf',
        doi: pageDoi(),
        title: pageTitle(),
        url: location.href,
        bytesB64: b64(bytes)
      });
      if (reply && reply.ok) status('✓ 已存进 papers/：' + (reply.saved || ''), true);
      else status('✗ ' + ((reply && reply.error) || 'Mesa 未响应'), false);
    } catch (e) {
      status('✗ 取 PDF 失败：' + (e && e.message ? e.message : e), false);
    } finally {
      btn.disabled = false;
    }
  }

  function ensureButton() {
    if (!document.body || (!pageDoi() && !isPdfPage())) return;
    if (isPdfPage()) reportPdfPage();
    if (btn && document.getElementById('__mesa_save')) return;
    btn = document.createElement('button');
    btn.id = '__mesa_save';
    btn.textContent = '存到 Mesa';
    btn.setAttribute('style',
      'position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:9px 14px;' +
      'border-radius:10px;border:1px solid rgba(140,140,140,.5);background:rgba(28,28,30,.92);' +
      'color:#fff;font:13px system-ui;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.4)');
    btn.onclick = save;
    document.body.appendChild(btn);
  }

  // 工具栏图标点击（background 转发）：等同按一次页内按钮
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.kind === 'mesa-save-from-icon') {
      save();
      sendResponse({ ok: true });
    }
    return false;
  });

  // SPA 换页/晚渲染都能追上
  setInterval(ensureButton, 2000);
  ensureButton();
})();
