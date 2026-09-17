// Mesa 文献收货 service worker（通道 C）：content → native messaging → mesa_helper。
// 每次保存一条连接（MV3 service worker 生命周期短，不维持长连接）。
// chrome.runtime.connectNative 的 postMessage 直接发对象，封帧由浏览器完成。
//
// MV3 铁律（2026-09-17 踩坑修正）：事件监听必须注册在 **worker 顶层**——写在
// onInstalled 里会在 worker 休眠唤醒后消失（badge/PDF 检测全失效）。
// pdfTabs 是内存态：worker 休眠会丢，丢了只是角标暂时不亮，点图标仍走页内路径
// （content script 会在 PDF 页自报，见下）。
const HOST = 'dev.ccode.mesa';
const pdfTabs = new Map();

// 观察型 webRequest（MV3 允许非阻塞监听）：识别主框架 PDF 响应 → 图标亮角标
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0 || details.type !== 'main_frame') return;
    const ct = (details.responseHeaders || []).find(
      (h) => h.name.toLowerCase() === 'content-type',
    );
    const pdf = ct && /application\/pdf/i.test(ct.value || '');
    if (pdf) {
      pdfTabs.set(details.tabId, details.url);
      chrome.action.setBadgeText({ tabId: details.tabId, text: 'PDF' });
      chrome.action.setBadgeBackgroundColor({ tabId: details.tabId, color: '#1c6b2d' });
    } else if (pdfTabs.has(details.tabId)) {
      pdfTabs.delete(details.tabId);
      chrome.action.setBadgeText({ tabId: details.tabId, text: '' });
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders'],
);

chrome.tabs.onRemoved.addListener((tabId) => {
  pdfTabs.delete(tabId);
});

// 工具栏图标点击：PDF 页 → 触发浏览器下载（通道 A 收货）；文章页 → 让页内按钮逻辑跑一次。
// 全防御：个别环境下 API/权限未生效时点图标静默无效，不允许 worker 崩
chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (!tab || tab.id == null) return;
    const pdfUrl = pdfTabs.get(tab.id);
    if (pdfUrl && chrome.downloads && chrome.downloads.download) {
      try {
        await chrome.downloads.download({ url: pdfUrl });
        return;
      } catch (_) {
        /* 下载失败继续走页内路径 */
      }
    }
    if (chrome.tabs && chrome.tabs.sendMessage) {
      await chrome.tabs.sendMessage(tab.id, { kind: 'mesa-save-from-icon' });
    }
  } catch (_) {
    /* 页面没有 content script（如纯 PDF 查看器）则静默 */
  }
});

// content script 在 PDF 查看器页自报地址（worker 唤醒后 pdfTabs 为空时的补位）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.kind === 'mesa-pdf-page' && sender.tab && sender.tab.id != null) {
    pdfTabs.set(sender.tab.id, sender.tab.url || msg.url);
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: 'PDF' });
    chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: '#1c6b2d' });
    sendResponse({ ok: true });
    return false;
  }
  if (!msg || msg.kind !== 'mesa-save-pdf') return false;
  (async () => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST);
    } catch (e) {
      sendResponse({ ok: false, error: '连不上 Mesa helper（先在 Mesa 设置里安装浏览器桥）' });
      return;
    }
    let done = false;
    const finish = (reply) => {
      if (done) return;
      done = true;
      try { port.disconnect(); } catch (_) {}
      sendResponse(reply);
    };
    port.onMessage.addListener((reply) => finish(reply || { ok: false, error: 'helper 无响应' }));
    port.onDisconnect.addListener(() => {
      if (done) return;
      const last = chrome.runtime.lastError;
      finish({ ok: false, error: (last && last.message) || 'Mesa helper 已断开' });
    });
    port.postMessage(msg);
    // 兜底超时（60s：大 PDF 传输 + 入库）
    setTimeout(() => finish({ ok: false, error: 'Mesa helper 超时' }), 60000);
  })();
  return true; // 异步 sendResponse
});
