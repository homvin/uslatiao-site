/* =========================================================================
 * USLATIAO 采集扩展 · 后台桥接
 * 注入 HQ 后台页面：读取扩展本地草稿（chrome.storage.local），一键导入。
 *
 * 关键架构（v1.2.1）：content script 与页面 JS 处于两个隔离世界——
 * content script 看不到页面的 window.Data。因此导入逻辑以 <script> 标签
 * 注入页面主世界执行（在那里 window.Data.saveProduct 可用），执行结果
 * 通过 CustomEvent('usl-import-result') 传回 content script 更新 UI。
 * 图片不进服务器：草稿不含图，导入后主人手动上传本地图片。
 * ========================================================================= */
(function () {
  // 只在后台页生效，前台页面不弹条
  if (!/\/hq-/.test(location.pathname)) return;

  const DRAFT_KEY = 'uslatiao_drafts';
  let banner = null;

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
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483000;display:flex;align-items:center;gap:12px;' +
      'padding:10px 16px;background:#12271f;color:#f5f1ea;font:14px/1.4 system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25)';
    banner.innerHTML =
      '<span>📦 发现 <b>' + n + '</b> 条 1688 采集草稿</span>' +
      '<button data-act="import" style="padding:6px 14px;border:0;border-radius:7px;background:#3fae8c;color:#fff;cursor:pointer;font-weight:600">一键导入</button>' +
      '<button data-act="later" style="padding:6px 12px;border:1px solid #5a7268;border-radius:7px;background:transparent;color:#cfd8d3;cursor:pointer">稍后</button>' +
      '<button data-act="clear" style="padding:6px 12px;border:0;border-radius:7px;background:transparent;color:#e0876a;cursor:pointer;text-decoration:underline">清空</button>' +
      '<span data-role="tip" style="font-size:12px;color:#9fb3aa"></span>';
    document.documentElement.appendChild(banner);

    banner.querySelector('[data-act="later"]').onclick = () => { banner.remove(); };
    banner.querySelector('[data-act="clear"]').onclick = async () => {
      await writeDrafts([]);
      banner.remove();
      toast('采集草稿已清空');
    };
    banner.querySelector('[data-act="import"]').onclick = importAll;
  }

  // —— 页面主世界执行的导入函数（在那里才看得到 window.Data）——
  function uslImportMain(drafts) {
    const results = [];
    const finish = (extra) => {
      window.dispatchEvent(new CustomEvent('usl-import-result', { detail: Object.assign({ results: results }, extra || {}) }));
    };
    if (!window.Data || typeof window.Data.saveProduct !== 'function') { finish({ error: 'page_not_ready' }); return; }
    (async () => {
      for (const d of (drafts || [])) {
        try {
          const p = d.product || {};
          const slug = (String(p.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item') + '-' + Date.now().toString(36).slice(-4);
          const row = {
            slug: slug,
            name: p.name || 'Untitled',
            price: p.price || 0,
            compare_at: p.compare_at || null,
            weight_oz: p.weight_oz || null,
            category: p.category || 'spicy-strips',
            status: 'draft',
            sku: slug.toUpperCase().slice(0, 24),
            image: '', images: [], detail_images: []
          };
          const r = await window.Data.saveProduct(row);
          results.push({ id: d.id, ok: !!(r && r.ok), err: (r && r.error) || '' });
        } catch (e) { results.push({ id: d.id, ok: false, err: String(e && e.message || e) }); }
      }
      finish();
    })();
  }

  async function importAll() {
    const tip = banner.querySelector('[data-role="tip"]');
    const btn = banner.querySelector('[data-act="import"]');
    btn.disabled = true;
    tip.textContent = '导入中…';
    const drafts = await readDrafts();
    if (!drafts.length) { banner.remove(); return; }

    const handler = (e) => {
      window.removeEventListener('usl-import-result', handler);
      const det = e.detail || {};
      if (det.error === 'page_not_ready') {
        tip.textContent = '后台数据层还没就绪：请等「商品列表」完全显示出来后，再点一次导入';
        btn.disabled = false; return;
      }
      const results = det.results || [];
      const okIds = results.filter(r => r.ok).map(r => r.id);
      const firstErr = (results.find(r => !r.ok) || {}).err || '';
      writeDrafts(drafts.filter(d => okIds.indexOf(d.id) === -1));
      if (okIds.length && !firstErr) {
        tip.textContent = '完成：成功导入 ' + okIds.length + ' 条，页面即将刷新';
        toast('已导入 ' + okIds.length + ' 条采集草稿（图片请在后台商品编辑手动上传）');
        setTimeout(() => location.reload(), 1200);
      } else if (okIds.length) {
        tip.textContent = '成功 ' + okIds.length + ' 条，失败 ' + (results.length - okIds.length) + ' 条：' + firstErr;
        btn.disabled = false; btn.textContent = '重试失败的';
      } else {
        tip.textContent = '导入失败：' + (firstErr || '未知错误');
        btn.disabled = false;
      }
    };
    window.addEventListener('usl-import-result', handler);

    // 把导入函数注入页面主世界执行（携带草稿数据），结果经事件传回
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
