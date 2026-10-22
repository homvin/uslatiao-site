/* =========================================================================
 * 商品展示：密集卡片（货架式）/ 分类筛选 / 搜索 / 加购 / 货架排
 * ========================================================================= */
window.Shop = (function () {
  // 分类字典：默认写死兜底，后台配置加载后由 setCategories 覆盖
  const CATEGORY_LABELS = {
    'spicy-strips': 'Spicy Strips',
    'chocolate-bites': 'Chocolate Bites',
    'variety-packs': 'Variety Packs',
    'bundles': 'Bundles'
  };
  const EMOJI = {
    'spicy-strips': '🌶️',
    'chocolate-bites': '🍫',
    'variety-packs': '🎁',
    'bundles': '📦'
  };
  let CATEGORY_LIST = [
    { key: 'spicy-strips', label_en: 'Spicy Strips', label_cn: '辣条类', emoji: '🌶️', sort_order: 1, enabled: true },
    { key: 'chocolate-bites', label_en: 'Chocolate Bites', label_cn: '巧克力星球杯', emoji: '🍫', sort_order: 2, enabled: true },
    { key: 'variety-packs', label_en: 'Variety Packs', label_cn: '混合装', emoji: '🎁', sort_order: 3, enabled: true },
    { key: 'bundles', label_en: 'Bundles', label_cn: '组合礼包', emoji: '📦', sort_order: 4, enabled: true }
  ];

  // 由 data.js 在拉到后台分类后调用：重建显示字典，让所有已渲染/将渲染的内容同步
  function setCategories(list) {
    if (!Array.isArray(list) || !list.length) return;
    CATEGORY_LIST = list.slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    CATEGORY_LIST.forEach(c => {
      CATEGORY_LABELS[c.key] = c.label_en || c.label || c.key;
      EMOJI[c.key] = c.emoji || '🍬';
    });
  }
  function getCategories(onlyEnabled) {
    const list = onlyEnabled ? CATEGORY_LIST.filter(c => c.enabled !== false) : CATEGORY_LIST;
    return list.slice();
  }
  function categoryCn(cat) {
    const hit = CATEGORY_LIST.filter(c => c.key === cat)[0];
    return hit ? (hit.label_cn || hit.label_en || cat) : cat;
  }
  // 前台可售过滤：draft（草稿，未上架）与 inactive（已下架）都不对顾客展示。
  // 后台列表不受此限（要能看到草稿并编辑上架）。
  function sellable(list) {
    return (list || []).filter(p => p && p.status !== 'inactive' && p.status !== 'draft');
  }

  function categoryLabel(cat) { return CATEGORY_LABELS[cat] || cat; }
  function emojiFor(p) { return EMOJI[p.category] || '🍬'; }

  function escapeAttr(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  // 有上传图就显示图，否则回退 emoji 占位（保持无图时页面不空）
  function firstImage(p) {
    const arr = (p && p.images) || [];
    return arr.length ? arr[0] : (p && p.image) || '';
  }
  function thumbHTML(p) {
    const img = firstImage(p);
    if (img) {
      return `<img class="pimg" src="${img}" alt="${escapeAttr(p.name)}" loading="lazy">`;
    }
    return `<div class="ph">${emojiFor(p)}<br><span style="font-size:11px">${categoryLabel(p.category)}</span></div>`;
  }

  // 辣度条：1–5 段点 + 文字（货架卡与商品详情页通用）
  function heatBar(heat) {
    const h = +heat || 0;
    if (!h) return '';
    return `<div class="heat">${[1, 2, 3, 4, 5].map(i => `<span class="dot ${i <= h ? 'on' : ''}"></span>`).join('')}<span class="lbl">Heat ${h}/5</span></div>`;
  }

  function variantsOf(p) { return (p && p.variants || []).filter(Boolean); }

  // 是否售罄：先看商品总库存，没有再看各规格是否全为 0
  function isSoldOut(p) {
    const vs = variantsOf(p);
    if (p.stock != null) return +p.stock <= 0;
    if (vs.length) return vs.every(v => v.stock != null && +v.stock <= 0);
    return false;
  }

  // 角标：只显示后台手填的 badge；没填就不加（2026-10-22 主人定）。
  // 1)「HEAT x/5」形式不作角标——卡片内已有真实辣度条（heat 字段驱动），重复且历史数据对不上；
  // 2) 划线折扣不再自动加「Deal」角标——价格区已有划线原价 + -XX%，人人打折时角标失去意义。
  // 3) Weee 式分色（2026-10-22）：折扣类红、NEW 绿、BEST SELLER 金，其他中性深色——按角标文案自动归类。
  function badgeClass(b) {
    if (/(%|off|save|deal)/i.test(b)) return 'off';
    if (/^new\b|\bnew$/i.test(b)) return 'new';
    if (/(best|hot|popular|seller)/i.test(b)) return 'best';
    return 'soft';
  }
  function badgeHTML(p) {
    const b = (p.badge || '').trim();
    if (b && !/^heat\s*\d\s*\/\s*5$/i.test(b)) return `<span class="badge-corner ${badgeClass(b)}">${escapeAttr(b)}</span>`;
    return '';
  }

  // 图片右下角快选按钮（Weee 式圆形 +）：单一规格点一下直接加购；多规格点开就地选规格
  function quickBtnHTML(p) {
    const slug = encodeURIComponent(p.slug);
    if (isSoldOut(p)) return `<button class="qbtn" disabled aria-label="Sold out">+</button>`;
    return `<button class="qbtn" data-quick="${slug}" aria-label="Add to cart">+</button>`;
  }
  // 多规格就地快选面板（隐藏，点购物车钮展开）
  function quickPanelHTML(p) {
    const slug = encodeURIComponent(p.slug);
    const vs = variantsOf(p);
    if (isSoldOut(p) || vs.length < 2) return '';
    const rows = vs.map((v, i) => {
      const label = v.option_label || v.sku || ('Pack ' + (i + 1));
      const out = v.stock != null && +v.stock <= 0;
      return `<button class="qrow" data-qadd="${slug}" data-vi="${i}" ${out ? 'disabled' : ''}>
        <span>${escapeAttr(label)}</span><b>${window.Money(v.price)}</b><i>+</i></button>`;
    }).join('');
    return `<div class="qpanel" data-qpanel="${slug}" hidden>
      <div class="qh">Choose pack<a href="product.html?slug=${slug}">Details</a></div>${rows}</div>`;
  }

  // 卡片价格区：多规格显示 From 起价，划线原价 + 折扣百分比
  function priceHTML(p) {
    const vs = variantsOf(p);
    const fromPrice = vs.length ? Math.min.apply(null, vs.map(v => +v.price || +p.price)) : +p.price;
    const old = p.compare_at ? ` <span class="old">${window.Money(p.compare_at)}</span>` : '';
    const off = (p.compare_at && +p.compare_at > +p.price)
      ? Math.max(0, Math.round((1 - (+p.price) / (+p.compare_at)) * 100)) : 0;
    const offChip = off > 0 ? `<span class="off">-${off}%</span>` : '';
    const fromLabel = vs.length > 1 ? '<span class="from">From </span>' : '';
    return `${fromLabel}${window.Money(fromPrice)}${old}${offChip}`;
  }

  // 库存稀缺提示：≤10 件才显示（缺货信息已由按钮承担）
  function stockHTML(p) {
    if (isSoldOut(p)) return '';
    if (p.stock != null && +p.stock > 0 && +p.stock <= 10) return `<div class="stock low">Only ${+p.stock} left</div>`;
    return '';
  }

  /* —— 销量展示：products.sold_count（后台设置的基数）+ 真实订单量 ——
   * 真实量由页面启动时 setSoldCounts() 注入（data.js getSoldCounts 扫 orders.items）；
   * 0 件时不显示，避免「0 sold」反而劝退顾客。 */
  let SOLD_REAL = {};
  function setSoldCounts(counts) { SOLD_REAL = counts || {}; }
  function soldHTML(p) {
    const n = window.Data.soldOf(p, SOLD_REAL);
    if (n === '0') return '';
    return `<div class="sold">${n} sold</div>`;
  }

  function cardHTML(p) {
    const slug = encodeURIComponent(p.slug);
    return `
    <div class="card">
      <div class="thumb-wrap">
        <a class="thumb" href="product.html?slug=${slug}">
          ${badgeHTML(p)}
          ${thumbHTML(p)}
        </a>
        ${quickBtnHTML(p)}
      </div>
      <div class="body">
        <h3><a href="product.html?slug=${slug}">${p.name}</a></h3>
        <p class="sub2">${p.subtitle || ''}</p>
        ${heatBar(p.heat)}
        <div class="price">${priceHTML(p)}</div>
        ${soldHTML(p)}
        ${stockHTML(p)}
      </div>
      ${quickPanelHTML(p)}
    </div>`;
  }

  // 已渲染过的商品按 slug 缓存，供「Add to cart」委托事件取规格对象
  const PRODUCT_INDEX = {};
  function remember(list) {
    (list || []).forEach(p => { if (p && p.slug) PRODUCT_INDEX[p.slug] = p; });
  }

  // 「Add to cart」/「购物车快选」事件委托：只绑定一次，卡片反复渲染也自动生效
  let addBound = false;
  function closeQuickPanels(except) {
    document.querySelectorAll('.qpanel').forEach(x => { if (x !== except) x.hidden = true; });
  }
  function bindAdd() {
    if (addBound) return;
    addBound = true;
    document.addEventListener('click', e => {
      const t = e.target;
      if (!t || !t.closest) return;

      // —— 底部 data-add（兼容旧结构）——
      const btn = t.closest('[data-add]');
      if (btn) {
        let slug = '';
        try { slug = decodeURIComponent(btn.getAttribute('data-add')); } catch (err) { slug = ''; }
        const p = PRODUCT_INDEX[slug];
        if (!p) { location.href = 'product.html?slug=' + encodeURIComponent(slug); return; }
        const vs = variantsOf(p);
        // 单一规格时直接把该规格（含重量 weight_oz）写进购物车，结账运费才准
        window.Store.add(slug, 1, vs.length === 1 ? vs[0] : null);
        if (window.Layout && window.Layout.toast) window.Layout.toast((p.name || 'Item') + ' added to cart');
        return;
      }

      // —— 卡片右上角购物车钮：多规格展开快选面板；单一规格直接加购 ——
      const qbtn = t.closest('[data-quick]');
      if (qbtn) {
        if (qbtn.disabled) return;
        e.preventDefault();
        let slug = '';
        try { slug = decodeURIComponent(qbtn.getAttribute('data-quick')); } catch (err) { slug = ''; }
        const p = PRODUCT_INDEX[slug];
        if (!p) { location.href = 'product.html?slug=' + encodeURIComponent(slug); return; }
        const vs = variantsOf(p);
        if (vs.length > 1) {
          // 在本卡片作用域内切换面板（同一商品可能在多个货架重复出现）
          const card = qbtn.closest('.card');
          const panel = card && card.querySelector('.qpanel');
          closeQuickPanels(panel);
          if (panel) panel.hidden = !panel.hidden;
          return;
        }
        window.Store.add(slug, 1, vs.length === 1 ? vs[0] : null);
        if (window.Layout && window.Layout.toast) window.Layout.toast((p.name || 'Item') + ' added to cart');
        return;
      }

      // —— 快选面板里的规格行：带规格（含重量）入车，然后收起 ——
      const qrow = t.closest('[data-qadd]');
      if (qrow) {
        if (qrow.disabled) return;
        e.preventDefault();
        let slug = '';
        try { slug = decodeURIComponent(qrow.getAttribute('data-qadd')); } catch (err) { slug = ''; }
        const vi = parseInt(qrow.getAttribute('data-vi'), 10) || 0;
        const p = PRODUCT_INDEX[slug];
        if (!p) return;
        const v = variantsOf(p)[vi] || null;
        window.Store.add(slug, 1, v);
        const label = v && (v.option_label || v.sku) ? ' · ' + (v.option_label || v.sku) : '';
        if (window.Layout && window.Layout.toast) window.Layout.toast((p.name || 'Item') + label + ' added to cart');
        const panel = qrow.closest('.qpanel');
        if (panel) panel.hidden = true;
        return;
      }

      // —— 点空白处收起所有快选面板 ——
      if (!t.closest('.qpanel') && !t.closest('.qbtn')) closeQuickPanels(null);
    });
  }

  function renderGrid(container, products) {
    if (!container) return;
    remember(products);
    bindAdd();
    if (!products || !products.length) {
      container.innerHTML = `<div class="shelf-empty">No products found.</div>`;
      return;
    }
    container.innerHTML = products.map(cardHTML).join('');
  }

  // 货架排：标题（中英）+ 横向滚动的一排卡片 + Show all 链接
  function renderShelf(container, list, opts) {
    if (!container) return;
    opts = opts || {};
    remember(list);
    bindAdd();
    if (!list || !list.length) {
      container.innerHTML = `<div class="shelf-empty">${opts.empty || 'Nothing on this shelf yet.'}</div>`;
      return;
    }
    const head = `<div class="shelf-head">
        <div><h2>${opts.title || 'Products'}</h2>${opts.cn ? `<span class="cn">${opts.cn}</span>` : ''}</div>
        ${opts.href ? `<a class="more" href="${opts.href}">Show all →</a>` : ''}
      </div>`;
    container.innerHTML = head + `<div class="shelf-row">${list.map(cardHTML).join('')}</div>`;
  }

  function filterProducts(products, cat) {
    if (!cat || cat === 'all') return products;
    return (products || []).filter(p => p.category === cat);
  }

  // 搜索：名称 / 副标题 / 分类名 / slug 全部命中才算匹配（多词 AND）
  function searchProducts(products, q) {
    const s = (q || '').trim().toLowerCase();
    if (!s) return products || [];
    const words = s.split(/\s+/);
    return (products || []).filter(p => {
      const hay = [p.name, p.subtitle, p.slug, categoryLabel(p.category), categoryCn(p.category)]
        .join(' ').toLowerCase();
      return words.every(w => hay.indexOf(w) >= 0);
    });
  }

  // 辣度区间筛选：'mild' = 1–2，'medium' = 3，'hot' = 4–5
  function filterByHeat(products, band) {
    if (!band || band === 'all') return products;
    return (products || []).filter(p => {
      const h = +p.heat || 0;
      if (band === 'mild') return h >= 1 && h <= 2;
      if (band === 'medium') return h === 3;
      if (band === 'hot') return h >= 4;
      return true;
    });
  }

  // 启动后异步拉一次后台分类并覆盖字典；失败静默，沿用内置默认
  setTimeout(function () {
    try { if (window.Data && window.Data.getProductCategories) window.Data.getProductCategories(); } catch (e) {}
  }, 0);

  return {
    categoryLabel, emojiFor, cardHTML, renderGrid, renderShelf, filterProducts, searchProducts,
    setSoldCounts,
    filterByHeat, CATEGORY_LABELS, heatBar, setCategories, getCategories, categoryCn, variantsOf, isSoldOut, sellable
  };
})();
