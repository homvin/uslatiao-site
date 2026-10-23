/* =========================================================================
 * USLATIAO 采集扩展 · 后台脚本
 * 职责：替页面下载 1688/阿里 CDN 图片并转成 base64 data URI。
 * 有 host_permissions，在扩展上下文 fetch 不受页面 CORS 限制。
 * ========================================================================= */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // —— 图片下载：content script 无 chrome.downloads，必须由后台（有完整权限）执行 ——
  if (msg && msg.type === 'USL_DOWNLOAD' && msg.url && msg.filename) {
    try {
      chrome.downloads.download({ url: msg.url, filename: msg.filename, conflictAction: 'overwrite', saveAs: false }, (id) => {
        const le = chrome.runtime.lastError;
        if (le) sendResponse({ ok: false, err: le.message });
        else if (id === undefined) sendResponse({ ok: false, err: 'no_download_id' });
        else sendResponse({ ok: true });
      });
    } catch (e) { sendResponse({ ok: false, err: String(e && e.message || e) }); }
    return true; // 异步 sendResponse
  }
  // —— 图片转 base64（保留备用，当前流程未用）——
  if (msg && msg.type === 'USL_FETCH_IMAGE' && msg.url) {
    fetchAndEncode(msg.url).then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
});

async function fetchAndEncode(url) {
  let r;
  try {
    r = await fetch(url, { credentials: 'omit', mode: 'cors' });
  } catch (e) {
    return { ok: false, error: 'fetch_blocked' };
  }
  if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
  const blob = await r.blob();
  if (blob.size > 8 * 1024 * 1024) return { ok: false, error: 'too_large' };
  const ct = (blob.type || '').toLowerCase();
  if (!/^image\//.test(ct)) return { ok: false, error: 'not_image:' + ct };
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return { ok: true, dataUri: 'data:' + ct + ';base64,' + btoa(bin), bytes: blob.size };
}
