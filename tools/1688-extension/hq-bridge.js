/* =========================================================================
 * USLATIAO 采集扩展 · 后台桥接
 * 注入 HQ 后台页面：读取扩展本地草稿（chrome.storage.local），
 * 用主人已登录的管理员会话把草稿入库（uploadMedia + saveProduct）。
 * 零服务端密钥：RLS 走 is_admin，天然合规。
 * ========================================================================= */
(function () {
  // 只在后台页生效，前台页面不弹条
  if (!/\/hq-/.test(location.pathname)) return;

  const DRAFT_KEY = 'uslatiao_drafts';
  let banner = null;

  function toast(s) {
    try { window.Layout && window.Layout.toast(s); } catch (e) { console.log('[USLATIAO]', s); }
  }

  function slugify(s) {
    return String(s || '').toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'item';
  }

  function waitForData(cb) {
    if (window.Data && window.Cloud) return cb();
    setTimeout(() => waitForData(cb), 200);
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
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999999;display:flex;align-items:center;gap:12px;' +
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

  async function importAll() {
    const tip = banner.querySelector('[data-role="tip"]');
    const btn = banner.querySelector('[data-act="import"]');
    btn.disabled = true;
    const drafts = await readDrafts();
    if (!drafts.length) { banner.remove(); return; }

    let okN = 0, failN = 0;
    const remain = [];
    for (let i = 0; i < drafts.length; i++) {
      const d = drafts[i];
      tip.textContent = '导入中 ' + (i + 1) + '/' + drafts.length + '：' + ((d.product && d.product.name) || '').slice(0, 16) + '…';
      try {
        const row = await buildRow(d);
        const r = await window.Data.saveProduct(row);
        if (r && r.ok) okN++; else { failN++; remain.push(d); tip.textContent = '失败：' + ((r && r.error) || ''); }
      } catch (e) {
        failN++; remain.push(d);
        const m = String(e && e.message || e);
        tip.textContent = m.indexOf('42501') >= 0 || /permission|row-level/i.test(m)
          ? '权限不足：请先登录后台管理员账号，再点导入'
          : '导入失败：' + m;
      }
    }
    await writeDrafts(remain);
    tip.textContent = '完成：成功 ' + okN + ' 条' + (failN ? '，失败 ' + failN + ' 条（草稿保留，可重试）' : '');
    if (okN && !failN) {
      toast('已导入 ' + okN + ' 条采集草稿，页面即将刷新');
      setTimeout(() => location.reload(), 1200);
    } else if (okN) {
      btn.disabled = false;
      btn.textContent = '重试失败的';
    } else {
      btn.disabled = false;
    }
  }

  async function buildRow(d) {
    const p = d.product || {};
    const slug = slugify(p.name) + '-' + Date.now().toString(36).slice(-4);
    const row = {
      slug: slug,
      name: p.name || 'Untitled',
      price: p.price || 0,
      compare_at: p.compare_at || null,
      weight_oz: p.weight_oz || null,
      category: p.category || 'spicy-strips',
      status: 'draft',
      source_url: d.source_url || '',
      sku: slug.toUpperCase().slice(0, 24),
      image: '',
      images: [],
      detail_images: []
    };
    const up = async (uri) => {
      if (!uri) return '';
      if (/^(https?:\/\/|\/media\/)/i.test(uri)) return uri;
      try { return await window.Data.uploadMedia(uri, 'product'); } catch (e) { return ''; }
    };
    const imgs = [];
    for (const uri of (p.images || [])) { const u = await up(uri); if (u) imgs.push(u); }
    const det = [];
    for (const uri of (p.detail_images || [])) { const u = await up(uri); if (u) det.push(u); }
    row.image = imgs[0] || '';
    row.images = imgs;
    row.detail_images = det;
    return row;
  }

  waitForData(async () => {
    const drafts = await readDrafts();
    if (drafts.length) ensureBanner(drafts.length);
  });
})();
