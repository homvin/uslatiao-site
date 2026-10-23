// USLATIAO 1688 采集扩展 · content script
// 在 detail.1688.com/offer/*.html 注入浮动按钮与采集面板：
//   解析（全局变量优先 → DOM 兜底）→ 弹窗可改（名称/售价/重量/分类/图片）→ 推送后台草稿
(function () {
  if (document.getElementById('usl-capture-bar')) return; // 避免重复注入

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const txt = (s) => { const e = $(s); return e ? e.textContent.trim() : ''; };
  const round2 = (n) => Math.round((+n || 0) * 100) / 100;

  // —— 取 1688 页面全局数据（不同时间字段名会漂移，多探测几个位置）——
  function globalData() {
    try { return window.runParams && window.runParams.data ? window.runParams.data : null; } catch (e) {}
    try { return window.pageData || null; } catch (e) {}
    return null;
  }

  function pickImages(selector) {
    return $$('img', $(selector)).map(img => img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '')
      .filter(u => /^https?:\/\//.test(u));
  }

  function parsePage() {
    const g = globalData();
    // 标题
    let name = (g && (g.title || g.subject)) || txt('#mod-detail-title h1') || txt('.d-title') || document.title || '';
    name = name.replace(/【.*?】/g, '').replace(/\s+/g, ' ').trim();

    // 价格（人民币区间）
    let cnyMin = 0, cnyMax = 0;
    const priceText = (g && (g.priceRange || g.price)) || txt('#mod-detail-price') || txt('.price-notice') || txt('.price');
    const nums = (priceText || '').match(/(\d+(?:\.\d+)?)/g);
    if (nums && nums.length) {
      const arr = nums.map(Number);
      cnyMin = Math.min.apply(null, arr);
      cnyMax = Math.max.apply(null, arr);
    }

    // 主图 / 详情图
    let images = pickImages('#img-list') .concat(pickImages('#dt-tab')).concat(pickImages('.img-list'));
    if (!images.length && g && g.imageList) images = (g.imageList || []).map(x => x.url || x).filter(String);
    let detail = pickImages('#description').concat(pickImages('.desc-wrap')).concat(pickImages('#detail-description'));
    // 去重 + 只要 alicdn 图（1688 图床）
    const uniq = (arr) => Array.from(new Set(arr.filter(u => /alicdn|1688/.test(u))));
    images = uniq(images); detail = uniq(detail);

    // 重量（尽力而为，抓不到留空）
    let weightOz = 0;
    const wTxt = (txt('#mod-detail-attributes') || txt('.sku-attr-list') || '').match(/(\d+(?:\.\d+)?)\s*(g|克|kg|千克)/i);
    if (wTxt) { let w = parseFloat(wTxt[1]); if (/kg|千克/i.test(wTxt[2])) w *= 1000; weightOz = round2(w / 28.3495); }

    return { name, cnyMin, cnyMax, images, detail, weightOz, source_url: location.href };
  }

  // —— 浮动采集条 + 面板 ——
  const bar = document.createElement('div');
  bar.id = 'usl-capture-bar';
  bar.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;gap:8px;font-family:system-ui,sans-serif';
  bar.innerHTML = '<button id="usl-cap-btn" style="padding:10px 14px;border:0;border-radius:10px;background:#0f6e56;color:#fff;font-size:13px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.2)">采集到 USLATIAO</button>';
  document.body.appendChild(bar);

  $('#usl-cap-btn').onclick = async () => {
    const parsed = parsePage();
    const cfg = await chrome.storage.sync.get({ base: 'https://www.uslatiao.com', key: '', rate: '6.72' });
    const rate = (+cfg.rate > 0 ? +cfg.rate : 6.72);
    const usdMin = round2(parsed.cnyMin / rate);
    const usdMax = round2(parsed.cnyMax / rate);

    const panel = document.createElement('div');
    panel.id = 'usl-panel';
    panel.style.cssText = 'position:fixed;right:16px;bottom:68px;z-index:2147483647;width:340px;max-height:80vh;overflow:auto;background:#fff;border:1px solid #d3d1c7;border-radius:14px;padding:16px;box-shadow:0 8px 28px rgba(0,0,0,.18);font-family:system-ui,sans-serif;color:#2c2c2a';
    panel.innerHTML = `
      <div style="font-size:15px;font-weight:500;margin-bottom:10px">采集预览（可改后再推送）</div>
      <label style="font-size:12px;font-weight:500">商品名（英文，可先用中文）</label>
      <input id="usl-name" value="${parsed.name.replace(/"/g,'&quot;')}" style="width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #d3d1c7;border-radius:8px;margin:4px 0 10px">
      <div style="display:flex;gap:10px">
        <div style="flex:1"><label style="font-size:12px;font-weight:500">售价 USD</label>
          <input id="usl-price" value="${usdMin}" style="width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #d3d1c7;border-radius:8px;margin:4px 0"></div>
        <div style="flex:1"><label style="font-size:12px;font-weight:500">划线价 USD</label>
          <input id="usl-compare" value="${usdMax > usdMin ? usdMax : ''}" style="width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #d3d1c7;border-radius:8px;margin:4px 0"></div>
      </div>
      <label style="font-size:12px;font-weight:500">重量 oz（盎司）</label>
      <input id="usl-weight" value="${parsed.weightOz}" style="width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #d3d1c7;border-radius:8px;margin:4px 0 10px">
      <label style="font-size:12px;font-weight:500">分类（slug，如 spicy-strips）</label>
      <input id="usl-cat" value="spicy-strips" style="width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #d3d1c7;border-radius:8px;margin:4px 0 10px">
      <label style="font-size:12px;font-weight:500">主图链接（每行一个）</label>
      <textarea id="usl-imgs" style="width:100%;height:70px;box-sizing:border-box;padding:7px 9px;border:1px solid #d3d1c7;border-radius:8px;font-size:11px;margin:4px 0 10px">${parsed.images.join('\n')}</textarea>
      <label style="font-size:12px;font-weight:500">详情图链接（每行一个）</label>
      <textarea id="usl-detail" style="width:100%;height:60px;box-sizing:border-box;padding:7px 9px;border:1px solid #d3d1c7;border-radius:8px;font-size:11px;margin:4px 0 10px">${parsed.detail.join('\n')}</textarea>
      <div style="font-size:11px;color:#888780;margin-bottom:10px">来源：${parsed.source_url}</div>
      <div style="display:flex;gap:8px">
        <button id="usl-send" style="flex:1;padding:9px;border:0;border-radius:8px;background:#0f6e56;color:#fff;cursor:pointer">推送到后台</button>
        <button id="usl-close" style="padding:9px 12px;border:1px solid #d3d1c7;border-radius:8px;background:#fff;cursor:pointer">关闭</button>
      </div>
      <div id="usl-msg" style="font-size:12px;margin-top:8px;min-height:16px"></div>
    `;
    document.body.appendChild(panel);

    const msg = () => $('#usl-msg');
    $('#usl-close').onclick = () => panel.remove();
    $('#usl-send').onclick = async () => {
      const name = $('#usl-name').value.trim();
      const price = round2($('#usl-price').value);
      const compare = round2($('#usl-compare').value) || null;
      const weightOz = round2($('#usl-weight').value) || 0;
      const category = $('#usl-cat').value.trim() || 'spicy-strips';
      const images = $('#usl-imgs').value.split('\n').map(s => s.trim()).filter(Boolean);
      const detail_images = $('#usl-detail').value.split('\n').map(s => s.trim()).filter(Boolean);
      if (!name || !price) { msg().textContent = '名称和售价必填'; msg().style.color = '#d9442b'; return; }
      $('#usl-send').disabled = true; $('#usl-send').textContent = '推送中…';
      try {
        const res = await fetch(cfg.base.replace(/\/+$/, '') + '/api/hq/import-product', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-hq-key': cfg.key || '' },
          body: JSON.stringify({ product: { name, price, compare_at: compare, weight_oz: weightOz, category, source_url: parsed.source_url, status: 'draft' }, images, detail_images })
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok || !out.ok) { msg().style.color = '#d9442b'; msg().textContent = '失败：' + (out.error || res.status); $('#usl-send').disabled = false; $('#usl-send').textContent = '推送到后台'; return; }
        msg().style.color = '#0f6e56'; msg().textContent = '已推送为草稿：' + (out.slug || '');
        $('#usl-send').textContent = '已推送';
      } catch (e) { msg().style.color = '#d9442b'; msg().textContent = '网络错误：' + e.message; $('#usl-send').disabled = false; $('#usl-send').textContent = '推送到后台'; }
    };
  };
})();
