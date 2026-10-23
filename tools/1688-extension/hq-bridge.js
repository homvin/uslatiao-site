/* =========================================================================
 * USLATIAO 采集扩展 · 后台桥接
 * 注入 HQ 后台页面：读取扩展本地草稿（chrome.storage.local），一键导入。
 *
 * 关键架构（v1.2.2）：content script 与页面 JS 处于两个隔离世界，
 * 因此导入逻辑以 <script> 标签注入页面主世界执行（在那里 window.Data.saveProduct
 * 可用）。结果通过 window.postMessage（Chrome 跨世界最稳通道，比 CustomEvent 可靠）
 * 传回 content script 更新 UI 与进度条。
 * 图片不进服务器：草稿不含图，导入后主人手动上传本地图片。
 * ========================================================================= */
(function () {
  // 只在后台页生效，前台页面不弹条
  if (!/\/hq-/.test(location.pathname)) return;

  const DRAFT_KEY = 'uslatiao_drafts';
  let banner = null;
  const MSG_SOURCE = 'usl-import';

  function toast(s) {
    try { window.Layout && window.Layout.toast(s); } catch (e) { console.log('[USLATIAO]', s); }
  }

  async function readDrafts() {
    const st = await chrome.storage.local.get(DRAFT_KEY);
    return Array.isArray(st[DRAFT_KEY]) ? st[DRAFT_KEY] : [];
  }
  async function writeDrafts(list) {
    await chrome.storage.local.set({ [DRAFT_KEY]: list });
  }

  function ensureBanner(n) {
    if (banner) banner.remove();
    banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483000;display:flex;align-items:center;gap:12px;flex-wrap:wrap;' +
      'padding:10px 16px;background:#12271f;color:#f5f1ea;font:14px/1.4 system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25)';
    banner.innerHTML =
      '<span>📦 发现 <b>' + n + '</b> 条 1688 采集草稿</span>' +
      '<button data-act="import" style="padding:6px 14px;border:0;border-radius:7px;background:#3fae8c;color:#fff;cursor:pointer;font-weight:600">一键导入</button>' +
      '<button data-act="later" style="padding:6px 12px;border:1px solid #5a7268;border-radius:7px;background:transparent;color:#cfd8d3;cursor:pointer">稍后</button>' +
      '<button data-act="clear" style="padding:6px 12px;border:0;border-radius:7px;background:transparent;color:#e0876a;cursor:pointer;text-decoration:underline">清空</button>' +
      '<div id="usl-prog-wrap" style="display:none;flex:1 1 100%;align-items:center;gap:10px;margin-top:2px">' +
        '<div style="flex:1;height:10px;background:#1f3a30;border-radius:6px;overflow:hidden">' +
          '<div id="usl-prog-fill" style="height:100%;width:0%;background:#3fae8c;transition:width .15s"></div>' +
        '</div>' +
        '<span id="usl-prog-label" style="font-size:12px;color:#9fb3aa;min-width:96px;text-align:right"></span>' +
      '</div>' +
      '<span data-role="tip" style="font-size:12px;color:#9fb3aa;flex:1 1 100%"></span>';
    document.documentElement.appendChild(banner);

    banner.querySelector('[data-act="later"]').onclick = () => { banner.remove(); };
    banner.querySelector('[data-act="clear"]').onclick = async () => {
      await writeDrafts([]);
      banner.remove();
      toast('采集草稿已清空');
    };
    banner.querySelector('[data-act="import"]').onclick = () => importAll();
  }

  // —— 进度条显隐 / 更新（content script 侧）——
  function showProgress() {
    const wrap = banner && banner.querySelector('#usl-prog-wrap');
    if (wrap) wrap.style.display = 'flex';
  }
  function setProgress(done, total, label) {
    if (!banner) return;
    const fill = banner.querySelector('#usl-prog-fill');
    const lab = banner.querySelector('#usl-prog-label');
    if (fill) fill.style.width = (total ? Math.round(done / total * 100) : 0) + '%';
    if (lab) lab.textContent = (label || (done + '/' + total));
  }
  function tip(text, color) {
    if (!banner) return;
    const t = banner.querySelector('[data-role="tip"]');
    if (t) { t.textContent = text; t.style.color = color || '#9fb3aa'; }
  }

  // —— 页面主世界执行的导入函数（在那里才看得到 window.Data）——
  // 通过 window.postMessage 回传 start / progress / result，比 CustomEvent 跨世界更稳。
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
          const msg = String(e && e.message || e);
          results.push({ id: d.id, ok: false, err: msg });
          done++;
          console.error('[USLATIAO] 第 ' + done + ' 条异常：' + msg);
          post({ type: 'progress', done: done, total: list.length, lastOk: false, lastErr: msg, lastName: p.name || 'Untitled' });
        }
      }
      console.log('[USLATIAO] 导入完成：成功 ' + results.filter(r => r.ok).length + ' / ' + results.length);
      post({ type: 'result', results: results });
    })();
  }

  async function importAll() {
    if (!banner) return;
    const tipEl = banner.querySelector('[data-role="tip"]');
    const btn = banner.querySelector('[data-act="import"]');
    btn.disabled = true;
    tip('导入中…（请保持此标签页打开）', '#9fb3aa');
    showProgress();
    setProgress(0, 1, '0%');

    const drafts = await readDrafts();
    if (!drafts.length) { tip('没有待导入的草稿', '#9fb3aa'); btn.disabled = false; return; }

    let finished = false;
    let lastTick = Date.now();
    // 60 秒整体超时：任一环节挂起都能报出来，不再干等
    const watchdog = setTimeout(() => {
      if (finished) return;
      finished = true;
      window.removeEventListener('message', onMsg);
      tip('导入超时（60 秒无响应）：多半是 saveProduct 网络请求卡住或后台 Session 失效。请按 F12 → Console 看 [USLATIAO] 日志，把最后几行发我。', '#e0876a');
      btn.disabled = false; btn.textContent = '重试';
    }, 60000);

    function onMsg(e) {
      if (!e.data || e.data.source !== MSG_SOURCE) return;
      lastTick = Date.now();
      const m = e.data;
      if (m.type === 'start') {
        setProgress(0, m.total, '0/' + m.total);
        tip('正在导入 ' + m.total + ' 条草稿…', '#9fb3aa');
        return;
      }
      if (m.type === 'progress') {
        setProgress(m.done, m.total, m.done + '/' + m.total);
        tip('已处理 ' + m.done + '/' + m.total + (m.lastOk ? '' : ('（最近一条失败：' + (m.lastErr || '未知') + '）')), m.lastOk ? '#9fb3aa' : '#e0a86a');
        return;
      }
      if (m.type === 'error') {
        if (finished) return;
        finished = true; clearTimeout(watchdog); window.removeEventListener('message', onMsg);
        if (m.error === 'page_not_ready') tip('后台数据层还没就绪：请等「商品列表」完全显示出来后，再点一次导入', '#e0a86a');
        else tip('导入出错：' + (m.error || '未知'), '#e0876a');
        btn.disabled = false; btn.textContent = '重试';
        return;
      }
      if (m.type === 'result') {
        if (finished) return;
        finished = true; clearTimeout(watchdog); window.removeEventListener('message', onMsg);
        const results = m.results || [];
        const okIds = results.filter(r => r.ok).map(r => r.id);
        const firstErr = (results.find(r => !r.ok) || {}).err || '';
        writeDrafts(drafts.filter(d => okIds.indexOf(d.id) === -1));
        if (okIds.length && !firstErr) {
          setProgress(results.length, results.length, '100%');
          tip('完成：成功导入 ' + okIds.length + ' 条，页面即将刷新', '#9fb3aa');
          toast('已导入 ' + okIds.length + ' 条采集草稿（图片请在后台商品编辑手动上传）');
          setTimeout(() => location.reload(), 1200);
        } else if (okIds.length) {
          setProgress(results.length, results.length, '100%');
          tip('成功 ' + okIds.length + ' 条，失败 ' + (results.length - okIds.length) + ' 条：' + firstErr, '#e0a86a');
          btn.disabled = false; btn.textContent = '重试失败的';
        } else {
          tip('导入失败：' + (firstErr || '未知错误'), '#e0876a');
          btn.disabled = false; btn.textContent = '重试';
        }
      }
    }
    window.addEventListener('message', onMsg);

    // 把导入函数注入页面主世界执行（携带草稿数据），结果经 postMessage 传回
    const s = document.createElement('script');
    s.textContent = '(' + uslImportMain.toString() + ')(' + JSON.stringify(drafts.map(d => ({ id: d.id, product: d.product }))) + ');';
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  }

  // 立即读草稿并弹条幅：不等后台框架加载（后台白屏时也能看到草稿提示）
  (async () => {
    try {
      const drafts = await readDrafts();
      if (drafts.length) ensureBanner(drafts.length);
    } catch (e) { /* 扩展刚重载时 context 可能失效，忽略 */ }
  })();
})();
