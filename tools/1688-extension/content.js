// USLATIAO 1688 采集扩展 · content script
// 注入 1688 全域（国内站 detail.1688.com / 国际站 www.1688.com 等），
// 仅在商品详情页（URL 含 /offer/）显示浮动按钮与采集面板：
//   解析（全局变量优先 → DOM 兜底）→ 弹窗可改（名称/售价/重量/分类/图片）→ 图片转存 → 存浏览器草稿
(function () {
  const _href = location.href;
  const _host = location.hostname;
  const isTaobao = /taobao\.com$|tmall\.com$/.test(_host);
  const is1688 = /1688\.com$/.test(_host);
  // 只在对应平台的商品详情页注入
  if (is1688 && !/\/offer\//.test(_href)) return;
  if (isTaobao && !/\/item\.htm|\/item\/|\/detail\.htm/.test(_href)) return;
  if (!is1688 && !isTaobao) return;
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

  function parsePage(isTaobao) {
    const g = globalData();
    let name = '', cnyMin = 0, cnyMax = 0, images = [], detail = [], weightOz = 0;

    if (isTaobao) {
      // —— 淘宝 / 天猫 ——
      name = txt('#J_Title h1') || txt('h1.tb-main-title') || document.title || '';
      name = name.replace(/【.*?】|\[.*?\]/g, '').replace(/\s+/g, ' ').trim();
      const pEl = $('#J_StrPrice') || $('.tb-rmb-num') || $('.tm-price') || $('#J_PromoPrice') || $('.tb-promo-price');
      const priceText = (pEl ? pEl.textContent : '') || (g && (g.priceRange || g.price)) || '';
      const nums = (priceText || '').match(/(\d+(?:\.\d+)?)/g);
      if (nums && nums.length) { const arr = nums.map(Number); cnyMin = Math.min.apply(null, arr); cnyMax = Math.max.apply(null, arr); }
      // 主图 + 缩略图列表
      const booth = $('#J_ImgBooth') || $('.tb-main-image img');
      if (booth && booth.getAttribute('src')) images.push(booth.getAttribute('src'));
      $$('.tb-thumb li img, .tb-thumb img, .J_TMain li img, .tb-pic ul li img').forEach(img => {
        const u = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
        if (u) images.push(u);
      });
      // 重量：规格参数区
      const wTxt = (txt('#J_AttrList') || txt('.attributes-list') || txt('.tm-item-attributes') || '').match(/重量[^\d]*(\d+(?:\.\d+)?)\s*(g|克|kg|千克)/i);
      if (wTxt) { let w = parseFloat(wTxt[1]); if (/kg|千克/i.test(wTxt[2])) w *= 1000; weightOz = round2(w / 28.3495); }
    } else {
      // —— 1688 国内站 / 国际站 ——
      name = (g && (g.title || g.subject)) || txt('#mod-detail-title h1') || txt('.d-title') || document.title || '';
      name = name.replace(/【.*?】/g, '').replace(/\s+/g, ' ').trim();
      const priceText = (g && (g.priceRange || g.price)) || txt('#mod-detail-price') || txt('.price-notice') || txt('.price');
      const nums = (priceText || '').match(/(\d+(?:\.\d+)?)/g);
      if (nums && nums.length) { const arr = nums.map(Number); cnyMin = Math.min.apply(null, arr); cnyMax = Math.max.apply(null, arr); }
      images = pickImages('#img-list').concat(pickImages('#dt-tab')).concat(pickImages('.img-list'));
      if (!images.length && g && g.imageList) images = (g.imageList || []).map(x => x.url || x).filter(String);
      detail = pickImages('#description').concat(pickImages('.desc-wrap')).concat(pickImages('#detail-description'));
      const wTxt = (txt('#mod-detail-attributes') || txt('.sku-attr-list') || '').match(/(\d+(?:\.\d+)?)\s*(g|克|kg|千克)/i);
      if (wTxt) { let w = parseFloat(wTxt[1]); if (/kg|千克/i.test(wTxt[2])) w *= 1000; weightOz = round2(w / 28.3495); }
    }

    // 去重 + 只收阿里系图床（alicdn / taobaocdn / tbcdn）；兼容 // 协议相对的图
    const uniq = (arr) => {
      const norm = (u) => /^https?:\/\//.test(u) ? u : (/^\/\//.test(u) ? 'https:' + u : '');
      return Array.from(new Set((arr || []).map(norm).filter(Boolean))).filter(u => /alicdn|taobaocdn|tbcdn|1688/.test(u));
    };
    images = uniq(images); detail = uniq(detail);
    // 数量封顶：主图最多 10 张、详情最多 15 张，避免重复/超大图无谓占空间与拖慢转存
    images = images.slice(0, 10);
    detail = detail.slice(0, 15);
    return { name, cnyMin, cnyMax, images, detail, weightOz, source_url: location.href };
  }

  // —— 浮动采集条 + 面板 ——
  const bar = document.createElement('div');
  bar.id = 'usl-capture-bar';
  bar.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;gap:8px;font-family:system-ui,sans-serif';
  bar.innerHTML = '<button id="usl-cap-btn" style="padding:10px 14px;border:0;border-radius:10px;background:#0f6e56;color:#fff;font-size:13px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.2)">采集到 USLATIAO</button>';
  document.body.appendChild(bar);

  $('#usl-cap-btn').onclick = async () => {
    const parsed = parsePage(isTaobao);
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
        <button id="usl-send" style="flex:1;padding:9px;border:0;border-radius:8px;background:#0f6e56;color:#fff;cursor:pointer">保存商品并下载图片</button>
        <button id="usl-close" style="padding:9px 12px;border:1px solid #d3d1c7;border-radius:8px;background:#fff;cursor:pointer">关闭</button>
      </div>
      <div style="font-size:11px;color:#888780;margin-top:6px">图片下载到本地「下载目录/uslatiao-import/…」（建议把 Chrome 下载位置设为 D 盘），商品信息存草稿；后台一键导入后再手动上传图片。</div>
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
      const imageUrls = $('#usl-imgs').value.split('\n').map(s => s.trim()).filter(Boolean);
      const detailUrls = $('#usl-detail').value.split('\n').map(s => s.trim()).filter(Boolean);
      if (!name || !price) { msg().textContent = '名称和售价必填'; msg().style.color = '#d9442b'; return; }
      const btn = $('#usl-send');
      btn.disabled = true; btn.textContent = '保存中…';

      // —— 图片下载到本地（不进服务器，主人自行挑选上传）——
      const slug = (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'item') + '-' + Date.now().toString(36).slice(-4);
      const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
      // 直接用 Chrome 下载根目录（主人已设为 D:\uslatiao-import），不再嵌套同名子文件夹；纯 ASCII 文件名避免中文路径静默失败
      const folder = slug + '_' + ts;
      const extOf = (u) => { const m = u.match(/\.(jpg|jpeg|png|webp|gif)(?:[?#]|$)/i); return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg'; };
      const downloadOne = (url, file) => new Promise(res => {
        chrome.downloads.download({ url: url, filename: file, conflictAction: 'overwrite', saveAs: false }, () => {
          const le = chrome.runtime.lastError;
          res(le ? { ok: false, err: le.message } : { ok: true });
        });
      });

      // 先存草稿（不等图片），点一下立即完成
      const draft = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        created_at: new Date().toISOString(),
        source_url: parsed.source_url,
        product: {
          name: name, price: price, compare_at: compare,
          weight_oz: weightOz, category: category, status: 'draft',
          image: '', images: [], detail_images: []
        },
        meta: { folder: folder, main_count: imageUrls.length, detail_count: detailUrls.length }
      };
      let saved = true;
      try {
        const st = await chrome.storage.local.get('uslatiao_drafts');
        const list = Array.isArray(st.uslatiao_drafts) ? st.uslatiao_drafts : [];
        list.push(draft);
        await chrome.storage.local.set({ uslatiao_drafts: list });
      } catch (e) { saved = false; }
      if (!saved) {
        msg().style.color = '#d9442b';
        msg().textContent = '保存失败：' + (chrome.runtime.lastError && chrome.runtime.lastError.message || '请重试');
        btn.disabled = false; btn.textContent = '保存商品并下载图片';
        return;
      }

      // 图片全部并行后台下载（不阻塞操作），每完成一张更新计数
      const all = imageUrls.map(u => [u, 'main']).concat(detailUrls.map(u => [u, 'detail']));
      let okN = 0, failN = 0, firstErr = '';
      const upd = () => {
        if (okN + failN >= all.length && okN === 0) {
          msg().style.color = '#d9442b';
          msg().textContent = '图片全部下载失败' + (firstErr ? '：' + firstErr : '') + '。请按 Ctrl+J 看 Chrome「下载记录」红色条目，把原因发我。';
          return;
        }
        msg().style.color = '#0f6e56';
        msg().textContent = '商品已存草稿 ✓；图片已下载 ' + okN + '/' + all.length + ' 张' + (failN ? '（失败 ' + failN + ' 张）' : '') + ' → 下载位置下的「' + folder + '」文件夹';
      };
      upd();
      btn.textContent = '已保存草稿 ✓';
      all.forEach((pair, i) => {
        downloadOne(pair[0], folder + '/' + pair[1] + '_' + String(i + 1).padStart(2, '0') + '.' + extOf(pair[0])).then(r => {
          if (r.ok) okN++; else { failN++; if (!firstErr) firstErr = r.err || 'unknown'; }
          upd();
        });
      });
    };
  };
})();
