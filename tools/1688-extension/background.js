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
  // —— HQ 导入：替 content script 在主世界执行导入函数 ——
  // 内联 <script> 注入会被 MV3 的 CSP 拦截（Executing inline script violates
  // Content Security Policy），必须走 chrome.scripting.executeScript(world:'MAIN')。
  if (msg && msg.type === 'USL_IMPORT_RUN' && msg.drafts && sender && sender.tab && sender.tab.id != null) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: 'MAIN',
      func: uslImportMain,
      args: [msg.drafts]
    }, (out) => {
      const le = chrome.runtime.lastError;
      if (le) sendResponse({ ok: false, err: le.message });
      else sendResponse({ ok: true });
    });
    return true; // 异步 sendResponse
  }
  // —— 图片转 base64（保留备用，当前流程未用）——
  if (msg && msg.type === 'USL_FETCH_IMAGE' && msg.url) {
    fetchAndEncode(msg.url).then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
});

// —— 页面主世界执行的导入函数（executeScript 序列化注入，函数体须自包含、不引用闭包）——
// 通过 window.postMessage 回传 start / progress / result 给 content script。
function uslImportMain(drafts) {
  const post = (m) => { try { window.postMessage(Object.assign({ source: 'usl-import' }, m), '*'); } catch (e) {} };
  const results = [];
  if (!window.Data || typeof window.Data.saveProduct !== 'function') {
    console.error('[USLATIAO] window.Data.saveProduct 不可用（页面数据层未就绪）');
    post({ type: 'error', error: 'page_not_ready' });
    return;
  }
  (async () => {
    const list = drafts || [];
    post({ type: 'start', total: list.length });
    console.log('[USLATIAO] 开始导入，共 ' + list.length + ' 条');
    let done = 0;
    for (const d of list) {
      const p = d.product || {};
      try {
        const slug = (String(p.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item') + '-' + Date.now().toString(36).slice(-4);
        const row = {
          slug: slug,
          name: p.name || 'Untitled',
          subtitle: '',
          price: p.price || 0,
          compare_at: p.compare_at || null,
          category: p.category || 'spicy-strips',
          heat: 0,
          stock: 0,
          sold_count: 0,
          weight_oz: p.weight_oz || null,
          tags: [],
          bullets: [],
          image: '',
          images: [],
          detail_images: [],
          sku: (p.sku || slug).toUpperCase().slice(0, 24),
          status: 'draft'
        };
        console.log('[USLATIAO] 导入中 (' + (done + 1) + '/' + list.length + ')：' + row.name);
        const r = await window.Data.saveProduct(row);
        const ok = !!(r && r.ok);
        const err = (r && r.error) || '';
        results.push({ id: d.id, ok: ok, err: err });
        done++;
        console.log('[USLATIAO] 第 ' + done + ' 条 ' + (ok ? '成功' : ('失败：' + err)));
        post({ type: 'progress', done: done, total: list.length, lastOk: ok, lastErr: err, lastName: row.name });
      } catch (e) {
        const msg2 = String(e && e.message || e);
        results.push({ id: d.id, ok: false, err: msg2 });
        done++;
        console.error('[USLATIAO] 第 ' + done + ' 条异常：' + msg2);
        post({ type: 'progress', done: done, total: list.length, lastOk: false, lastErr: msg2, lastName: p.name || 'Untitled' });
      }
    }
    console.log('[USLATIAO] 导入完成：成功 ' + results.filter(r => r.ok).length + ' / ' + results.length);
    post({ type: 'result', results: results });
  })();
}

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
