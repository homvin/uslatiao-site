/* =========================================================================
 * 数据层（商品 + 订单）
 * 策略：云端优先，本地兜底。本地预览无法访问云端，自动回退到
 *       products.json（商品）与 localStorage（管理员编辑 / 订单），
 *       发布到 https://uslatiao-store.app.workbuddy.host 后云端生效。
 * ========================================================================= */
window.Data = (function () {
  const LOCAL_OVERRIDE = 'uslatiao_admin_products';
  const LOCAL_ORDERS = 'uslatiao_orders';

  function db() {
    const c = window.Cloud && window.Cloud.init();
    return c ? c.database : null;
  }

  // 客户端生成 UUID（RFC4122 v4）。crypto.randomUUID 在部分环境不可用，故有兜底。
  function makeUuid() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    } catch (e) {}
    const b = new Uint8Array(16);
    try { (window.crypto || {}).getRandomValues && window.crypto.getRandomValues(b); }
    catch (e) { for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256); }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = [];
    for (let i = 0; i < 16; i++) hex.push((b[i] + 0x100).toString(16).slice(1));
    return hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' + hex.slice(6, 8).join('') +
      '-' + hex.slice(8, 10).join('') + '-' + hex.slice(10, 16).join('');
  }

  // —— 商品 —— //
  async function fetchJsonProducts() {
    try {
      const r = await fetch('products.json', { cache: 'no-store' });
      if (!r.ok) return [];
      return await r.json();
    } catch (e) { return []; }
  }
  function localOverride() {
    try { return JSON.parse(localStorage.getItem(LOCAL_OVERRIDE)) || null; } catch (e) { return null; }
  }

  // 内存缓存：避免每次读写商品都去拉整份 products.json（CDN 往返是后台存档变慢的主因）
  let _productsCache = null;

  async function getProducts() {
    const database = db();
    if (database) {
      try {
        const { data, error } = await database.from('products').select('*').order('created_at', { ascending: true });
        if (!error && Array.isArray(data) && data.length) { _productsCache = data; return data; }
      } catch (e) {}
    }
    const ov = localOverride();
    if (ov && ov.length) { _productsCache = ov; return ov; }
    const j = await fetchJsonProducts();
    _productsCache = j;
    return j;
  }

  // 后台列表专用：只取列表展示所需窄列，排除 images/detail_images/variants 等大字段。
  // 商品图以 base64 存库，这几个字段合计 12MB+；列表根本用不到，全量 select(*) 会拖垮后台。
  const PRODUCT_LIST_COLS = 'slug,name,subtitle,price,compare_at,stock,status,category,heat,badge,image,weight_oz,length_in,width_in,height_in,sku,tags,created_at,sold_count';
  async function getProductsList() {
    const database = db();
    if (database) {
      try {
        const { data, error } = await database.from('products').select(PRODUCT_LIST_COLS).order('created_at', { ascending: true });
        if (!error && Array.isArray(data)) return data;
      } catch (e) {}
    }
    const ov = localOverride() || await fetchJsonProducts();
    return (ov || []).map(p => { const o = {}; PRODUCT_LIST_COLS.split(',').forEach(c => { o[c] = p[c]; }); return o; });
  }

  // 前台首页专用：窄列 + variants（卡片快选/多规格起价需要；variants 全表仅约 0.3MB，可安全放行）。
  // 首页此前走全量 getProducts()，每次拖 12MB+ 的图库 base64 —— 这里把 images/detail_images 排除掉。
  const PRODUCT_FRONT_COLS = PRODUCT_LIST_COLS + ',variants';
  let _frontCache = null;
  async function getProductsFront() {
    const database = db();
    if (database) {
      try {
        const { data, error } = await database.from('products').select(PRODUCT_FRONT_COLS).order('created_at', { ascending: true });
        if (!error && Array.isArray(data) && data.length) { _frontCache = data; return data; }
      } catch (e) {}
    }
    if (_frontCache && _frontCache.length) return _frontCache;
    // 回退：全量拉一次并按窄列裁剪（本地打开 / 云库异常时兜底）
    const full = await getProducts();
    return (full || []).map(p => { const o = {}; PRODUCT_FRONT_COLS.split(',').forEach(c => { o[c] = p[c]; }); return o; });
  }

  // 单条商品全量（编辑/详情用）：按需按 slug 拉，不污染列表内存缓存
  async function getProductBySlug(slug) {
    if (!slug) return null;
    const database = db();
    if (database) {
      try {
        const { data, error } = await database.from('products').select('*').eq('slug', slug).limit(1);
        if (!error && Array.isArray(data) && data.length) return data[0];
      } catch (e) {}
    }
    const ov = localOverride() || await fetchJsonProducts();
    return (ov || []).find(p => p.slug === slug) || null;
  }

  // 局部更新：只改给定字段，不覆盖 images/detail_images/variants 等大字段。
  // 用于上架/下架、改库存等「只动个别字段」的场景——否则拿窄列对象 upsert 会把大字段清空。
  async function patchProduct(slug, patch) {
    if (!slug || !patch) return { ok: false, error: 'missing slug/patch' };
    const database = db();
    if (database) {
      try {
        const { error } = await database.from('products').update(patch).eq('slug', slug);
        if (error) return { ok: false, error: error.message };
      } catch (e) { return { ok: false, error: String(e) }; }
    }
    let list = _productsCache || localOverride() || await fetchJsonProducts();
    const i = list.findIndex(p => p.slug === slug);
    if (i >= 0) { list[i] = Object.assign({}, list[i], patch); _productsCache = list; localStorage.setItem(LOCAL_OVERRIDE, JSON.stringify(list)); }
    return { ok: true };
  }

  // 管理员：把整份商品列表同步到云端（upsert by slug）+ 本地兜底
  async function publishProducts(list) {
    const database = db();
    if (database) {
      try {
        const { error } = await database.from('products').upsert(list, { onConflict: 'slug' });
        if (error) return { ok: false, error: error.message };
      } catch (e) { return { ok: false, error: String(e) }; }
    }
    localStorage.setItem(LOCAL_OVERRIDE, JSON.stringify(list));
    return { ok: true };
  }

  // 单条保存（新增或更新）
  async function saveProduct(product) {
    const database = db();
    if (database) {
      try {
        const { error } = await database.from('products').upsert(product, { onConflict: 'slug' }).select();
        if (error) return { ok: false, error: error.message };
      } catch (e) { return { ok: false, error: String(e) }; }
    }
    let list = _productsCache || localOverride() || await fetchJsonProducts();
    const i = list.findIndex(p => p.slug === product.slug);
    if (i >= 0) list[i] = product; else list.push(product);
    _productsCache = list; // 写回内存缓存，下次存档不再下载 products.json
    localStorage.setItem(LOCAL_OVERRIDE, JSON.stringify(list));
    return { ok: true };
  }

  async function deleteProduct(slug) {
    const database = db();
    if (database) {
      try {
        const { error } = await database.from('products').delete().eq('slug', slug).select();
        if (error) return { ok: false, error: error.message };
      } catch (e) { return { ok: false, error: String(e) }; }
    }
    let list = localOverride() || await fetchJsonProducts();
    list = list.filter(p => p.slug !== slug);
    localStorage.setItem(LOCAL_OVERRIDE, JSON.stringify(list));
    return { ok: true };
  }

  async function seedFromJson() {
    const list = await fetchJsonProducts();
    return await publishProducts(list);
  }

  // —— 折扣 / 营销活动 —— //
  async function getDiscounts() {
    const database = db();
    if (database) {
      try {
        // 顾客（anon）只能读到 active=true（由 public 策略限制）；
        // 管理员（authenticated）可读取全部（含已停用）。
        const { data, error } = await database.from('discounts').select('*').order('created_at', { ascending: false });
        if (!error && Array.isArray(data)) return data;
      } catch (e) {}
    }
    return [];
  }

  async function saveDiscount(d) {
    const database = db();
    if (database) {
      try {
        const { error } = await database.from('discounts').upsert(d, { onConflict: 'code' }).select();
        if (error) return { ok: false, error: error.message };
      } catch (e) { return { ok: false, error: String(e) }; }
    }
    return { ok: true };
  }

  async function deleteDiscount(code) {
    const database = db();
    if (database) {
      try {
        const { error } = await database.from('discounts').delete().eq('code', code).select();
        if (error) return { ok: false, error: error.message };
      } catch (e) { return { ok: false, error: String(e) }; }
    }
    return { ok: true };
  }

  // 校验折扣：返回 { ok, amount, discount, message }
  // opts: { items:[{slug,category,price,qty}], firstOrder:bool, codeUsage:number }
  function validateDiscount(code, subtotal, list, opts) {
    opts = opts || {};
    const items = opts.items || [];
    const firstOrder = opts.firstOrder !== false; // 默认视为新客（无历史订单）
    const codeUsage = opts.codeUsage || 0;
    if (!code) return { ok: false, message: 'No code' };
    const c = (code || '').trim().toUpperCase();
    const d = (list || []).find(x => (x.code || '').toUpperCase() === c);
    if (!d) return { ok: false, message: 'Code not found' };
    if (d.active === false) return { ok: false, message: 'Code is inactive' };
    const now = Date.now();
    if (d.starts_at && new Date(d.starts_at).getTime() > now) return { ok: false, message: 'Not started yet' };
    if (d.ends_at && new Date(d.ends_at).getTime() < now) return { ok: false, message: 'Expired' };
    if (d.min_order && subtotal < d.min_order) return { ok: false, message: `Min order $${d.min_order}` };
    if (d.usage_limit && (d.usage_count || 0) >= d.usage_limit) return { ok: false, message: 'Usage limit reached' };
    // 适用范围
    if (d.applies_to === 'category' && d.target) {
      if (!items.some(it => it.category === d.target)) return { ok: false, message: 'This code applies to a specific category only' };
    }
    if (d.applies_to === 'product' && d.target) {
      if (!items.some(it => it.slug === d.target)) return { ok: false, message: 'This code applies to a specific product only' };
    }
    // 新客专享
    if (d.first_order_only && !firstOrder) return { ok: false, message: 'This code is for first-time customers only' };
    // 每人限用
    if (d.per_customer_limit && codeUsage >= d.per_customer_limit) return { ok: false, message: `You have already used this code the maximum ${d.per_customer_limit} time(s)` };
    let amount = 0;
    if (d.type === 'percent') amount = +(subtotal * (d.value || 0) / 100).toFixed(2);
    else if (d.type === 'fixed') amount = +Math.min(d.value || 0, subtotal).toFixed(2);
    else if (d.type === 'free_shipping') amount = 0; // 运费减免在结账页单独处理
    return { ok: true, amount, discount: d };
  }

  // —— 订单 —— //
  async function updateOrder(id, patch) {
    const database = db();
    if (database) {
      try {
        const { error } = await database.from('orders').update(patch).eq('id', id).select();
        if (error) return { ok: false, error: error.message };
      } catch (e) { return { ok: false, error: String(e) }; }
    } else {
      // 本地兜底
      const arr = localOrders().map(o => o.id === id ? Object.assign({}, o, patch) : o);
      localStorage.setItem(LOCAL_ORDERS, JSON.stringify(arr));
    }
    return { ok: true };
  }

  function pushLocalOrder(o) {
    try {
      const arr = JSON.parse(localStorage.getItem(LOCAL_ORDERS)) || [];
      arr.unshift(o);
      localStorage.setItem(LOCAL_ORDERS, JSON.stringify(arr));
    } catch (e) {}
  }
  function localOrders() {
    try { return JSON.parse(localStorage.getItem(LOCAL_ORDERS)) || []; } catch (e) { return []; }
  }

  async function createOrder(order, session) {
    // 游客结账：session 可能为 null，此时用顾客手填的邮箱；
    // 顾客注册后（同一邮箱）可通过 orders_email_read 策略认领这笔单。
    const email = window.Cloud.userEmail(session) || (order.email || null);
    // 订单 ID 客户端生成：PostgREST 带 ?select=* 时会在 INSERT 后做 SELECT 回读，
    // 而 RLS 的 SELECT 策略不保证允许匿名读到新行 → 整条语句会失败。
    // 不回读、自己带 id 就绕开了这一步，游客/登录用户都能顺利下单。
    const orderId = makeUuid();
    const payload = {
        id: orderId,
        email,
        items: order.items,
        subtotal: order.subtotal,
        shipping: order.shipping,
        tax: order.tax || 0,
        total: order.total,
        discount_code: order.discount_code || null,
        discount_amount: order.discount_amount || 0,
        notes: order.notes || '',
        // 收货信息：没有这几项，收了钱也不知道货往哪发
        ship_name: order.ship_name || '',
        ship_addr: order.ship_addr || '',
        ship_city: order.ship_city || '',
        ship_state: order.ship_state || '',
        ship_zip: order.ship_zip || '',
        phone: order.phone || '',
        payment_provider: order.payment_provider || '',
        payment_status: order.payment_status || 'unpaid',
        status: 'pending',
        created_at: new Date().toISOString()
      };
    const database = db();
    if (database) {
      try {
        // 注意：不加 .select()，避免触发 RLS 下的 SELECT 回读
        const { error } = await database.from('orders').insert(payload);
        if (error) return { ok: false, error: error.message };
        const created = Object.assign({}, payload, { id: orderId });
        pushLocalOrder(created);
        return { ok: true, order: created };
      } catch (e) { /* 回退本地 */ }
    }
    const local = Object.assign({ id: orderId, created_at: new Date().toISOString() }, payload);
    pushLocalOrder(local);
    return { ok: true, order: local, local: true };
  }

  async function getMyOrders(session) {
    // 没有登录态就没有"我的订单"可言（游客的订单凭邮箱在 Stripe/后台侧追踪）
    if (!session || !session.user) return [];
    const database = db();
    if (database) {
      try {
        const { data, error } = await database.from('orders').select('*').order('created_at', { ascending: false });
        if (!error && Array.isArray(data)) {
          // RLS 的 orders_email_read 已按 JWT 邮箱放行；这里再按邮箱兜一层，
          // 让「先游客下单、后注册」的历史单也能被认领。
          const mail = (window.Cloud.userEmail(session) || '').toLowerCase();
          if (!mail) return [];
          return data.filter(o => (o.email || '').toLowerCase() === mail);
        }
      } catch (e) {}
    }
    const email = window.Cloud.userEmail(session) || null;
    return localOrders().filter(o => !email || o.email === email);
  }

  async function getAllOrders() {
    const database = db();
    if (database) {
      try {
        const { data, error } = await database.from('orders').select('*').order('created_at', { ascending: false });
        if (!error && Array.isArray(data)) return data;
      } catch (e) {}
    }
    return localOrders();
  }

  /* —— 评价 / 晒单 —— */
  async function getReviews(opts) {
    const database = db();
    if (database) {
      try {
        let q = database.from('reviews').select('*').order('created_at', { ascending: false });
        if (opts && opts.status) q = q.eq('status', opts.status);
        const { data, error } = await q;
        if (!error && Array.isArray(data)) return data;
      } catch (e) {}
    }
    return [];
  }
  async function saveReview(review) {
    const database = db();
    if (database) {
      try {
        const { error } = await database.from('reviews').insert(review).select();
        if (error) return { ok: false, error: error.message };
      } catch (e) { return { ok: false, error: String(e) }; }
    }
    return { ok: true };
  }
  async function updateReview(id, patch) {
    const database = db();
    if (database) {
      try {
        const { error } = await database.from('reviews').update(patch).eq('id', id).select();
        if (error) return { ok: false, error: error.message };
      } catch (e) { return { ok: false, error: String(e) }; }
    }
    return { ok: true };
  }
  async function deleteReview(id) {
    const database = db();
    if (database) {
      try {
        const { error } = await database.from('reviews').delete().eq('id', id).select();
        if (error) return { ok: false, error: error.message };
      } catch (e) { return { ok: false, error: String(e) }; }
    }
    return { ok: true };
  }

  /* —— 退款 / 售后 —— */
  async function refundOrder(id, amount) {
    const database = db();
    if (database) {
      try {
        const { error } = await database.from('orders').update({
          status: 'refunded',
          refund_amount: amount,
          refunded_at: new Date().toISOString()
        }).eq('id', id).select();
        if (error) return { ok: false, error: error.message };
      } catch (e) { return { ok: false, error: String(e) }; }
    }
    return { ok: true };
  }

  // 删除所有「未付款」（pending）订单。
  // 这类单从未收款，留着只会污染「待发货」统计与导出；paid/shipped/delivered 均已收款，绝不在此删除。
  // 仅管理员 HQ 上下文可调用（orders 表 DELETE 走 is_admin 策略）。
  async function deletePendingOrders() {
    const database = db();
    if (database) {
      try {
        const { data, error } = await database.from('orders').delete().eq('status', 'pending').select('id');
        if (error) return { ok: false, error: error.message, count: 0 };
        return { ok: true, count: Array.isArray(data) ? data.length : 0 };
      } catch (e) { return { ok: false, error: String(e), count: 0 }; }
    }
    // 本地兜底（无数据库时清本地 pending）
    const before = localOrders();
    const kept = before.filter(o => (o.status || 'pending') !== 'pending');
    localStorage.setItem(LOCAL_ORDERS, JSON.stringify(kept));
    return { ok: true, count: before.length - kept.length };
  }

  /* —— 售后申请（取消/退货审核流，2026-10-22） ——
   * 规则：已付款未发货可申请取消；下单 ≤3h 的申请后台标绿优先处理；
   * 已发货/已送达不提供申请入口；审核通过才由管理员把订单置 refunded。
   * 顾客只能插入自己的申请（RLS rr_insert_own），不能改订单本身。
   */
  async function createReturnRequest(order, reason) {
    const rec = {
      id: makeUuid(),
      order_id: order.id,
      email: String(order.email || '').trim().toLowerCase(),
      owner_id: String(order.owner_id || ''),
      reason: String(reason || '').trim().slice(0, 500),
      status: 'requested',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    const database = db();
    if (database) {
      try {
        // 不带 .select()：游客插入回读会撞 RLS（42501 老坑）
        const { error } = await database.from('return_requests').insert(rec);
        if (error) return { ok: false, error: error.message };
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    } else {
      try {
        const arr = JSON.parse(localStorage.getItem('uslatiao_return_requests')) || [];
        arr.unshift(rec);
        localStorage.setItem('uslatiao_return_requests', JSON.stringify(arr));
      } catch (e) {}
    }
    return { ok: true, request: rec };
  }

  async function getReturnRequests() {
    const database = db();
    if (database) {
      try {
        const { data, error } = await database.from('return_requests')
          .select('id,order_id,email,reason,status,created_at,updated_at')
          .order('created_at', { ascending: false });
        if (error) return [];
        return data || [];
      } catch (e) { return []; }
    }
    try { return JSON.parse(localStorage.getItem('uslatiao_return_requests')) || []; } catch (e) { return []; }
  }

  async function updateReturnRequest(id, patch) {
    const database = db();
    if (database) {
      try {
        const p = Object.assign({}, patch, { updated_at: new Date().toISOString() });
        const { error } = await database.from('return_requests').update(p).eq('id', id);
        if (error) return { ok: false, error: error.message };
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    } else {
      try {
        const key = 'uslatiao_return_requests';
        const arr = (JSON.parse(localStorage.getItem(key)) || []).map(r => r.id === id ? Object.assign({}, r, patch) : r);
        localStorage.setItem(key, JSON.stringify(arr));
      } catch (e) {}
    }
    return { ok: true };
  }

  async function getMyReturnRequests(email) {
    const mail = String(email || '').trim().toLowerCase();
    if (!mail) return [];
    const database = db();
    if (database) {
      try {
        const { data, error } = await database.from('return_requests')
          .select('id,order_id,status,created_at,updated_at')
          .eq('email', mail)
          .order('created_at', { ascending: false });
        if (error) return [];
        return data || [];
      } catch (e) { return []; }
    }
    try {
      return (JSON.parse(localStorage.getItem('uslatiao_return_requests')) || []).filter(r => r.email === mail);
    } catch (e) { return []; }
  }

  /* —— 折扣 ROI 聚合（从订单统计每个码的用量与带来营收） —— */
  function discountAnalytics(orders, discounts) {
    const map = {};
    (discounts || []).forEach(d => {
      map[d.code] = { code: d.code, type: d.type, value: d.value, used: 0, revenue: 0, discount: 0 };
    });
    (orders || []).forEach(o => {
      if (o.discount_code && map[o.discount_code]) {
        map[o.discount_code].used += 1;
        map[o.discount_code].revenue += (+o.total || 0);
        map[o.discount_code].discount += (+o.discount_amount || 0);
      }
    });
    return Object.values(map);
  }

  /* =======================================================================
   * 物流 / 运费设置
   * 美国惯例：重量用 oz（盎司，16oz = 1lb），外包装尺寸用 in（英寸）。
   * 计费方式 mode：
   *   flat   统一费率        —— 不论重量金额，一律 flat_rate
   *   weight 按重量分段      —— 用 weight_rates：[{up_to:16,rate:5.95}]，up_to=0 表示「以上」
   *   price  按订单金额分段  —— 用 price_rates：[{up_to:25,rate:4.99}]，up_to=0 表示「以上」
   * 区域 zones：[{key,label,states:[],surcharge,enabled}]，states 为空的是默认区。
   * ======================================================================= */
  const DEFAULT_SHIPPING = {
    id: 'default',
    mode: 'flat',
    flat_rate: 4.99,
    weight_rates: [
      { up_to: 8, rate: 4.5 }, { up_to: 16, rate: 5.95 },
      { up_to: 32, rate: 8.5 }, { up_to: 80, rate: 12.5 }, { up_to: 0, rate: 18 }
    ],
    price_rates: [
      { up_to: 25, rate: 4.99 }, { up_to: 50, rate: 6.99 }, { up_to: 0, rate: 8.99 }
    ],
    free_threshold: 35,
    free_after_discount: true,
    packaging_weight_oz: 4,
    handling_fee: 0,
    origin_zip: '',
    zones: [
      { key: 'domestic', label: 'Continental US (48 states)', states: [], surcharge: 0, enabled: true },
      { key: 'akhi', label: 'Alaska & Hawaii', states: ['AK', 'HI'], surcharge: 8.5, enabled: true },
      { key: 'territory', label: 'Territories & Military (APO/FPO)', states: ['PR', 'GU', 'VI', 'AS', 'MP', 'AA', 'AE', 'AP'], surcharge: 12, enabled: true }
    ]
  };

  const num = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };

  async function getShippingSettings() {
    const database = db();
    if (database) {
      try {
        const { data, error } = await database.from('shipping_settings').select('*').eq('id', 'default').limit(1);
        if (!error && Array.isArray(data) && data.length) return normalizeSettings(data[0]);
      } catch (e) {}
    }
    try {
      const local = JSON.parse(localStorage.getItem('uslatiao_shipping'));
      if (local) return normalizeSettings(local);
    } catch (e) {}
    return Object.assign({}, DEFAULT_SHIPPING);
  }

  // Postgres numeric 会返回字符串，统一转成数字；jsonb 可能是字符串也可能是数组
  function normalizeSettings(s) {
    s = s || {};
    const arr = v => {
      if (Array.isArray(v)) return v;
      if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch (e) { return []; } }
      return [];
    };
    const out = {
      id: s.id || 'default',
      mode: s.mode || 'flat',
      flat_rate: num(s.flat_rate),
      weight_rates: arr(s.weight_rates),
      price_rates: arr(s.price_rates),
      free_threshold: num(s.free_threshold),
      free_after_discount: s.free_after_discount !== false,
      packaging_weight_oz: num(s.packaging_weight_oz),
      include_packaging_weight: s.include_packaging_weight === true, // 默认不加包装重量（2026-10-20 主人定）
      active_template: String(s.active_template || ''), // 当前生效的运费模板名（空=未使用模板）
      handling_fee: num(s.handling_fee),
      origin_zip: s.origin_zip || '',
      zones: arr(s.zones)
    };
    if (!out.zones.length) out.zones = DEFAULT_SHIPPING.zones;
    if (!out.weight_rates.length) out.weight_rates = DEFAULT_SHIPPING.weight_rates;
    if (!out.price_rates.length) out.price_rates = DEFAULT_SHIPPING.price_rates;
    return out;
  }

  async function saveShippingSettings(s) {
    const payload = Object.assign({ id: 'default', updated_at: new Date().toISOString() }, normalizeSettings(s));
    const database = db();
    if (database) {
      // 网络瞬断（Failed to fetch 类）自动重试 2 次；数据库明确报错则不重试
      let lastErr = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const { error } = await database.from('shipping_settings').upsert(payload, { onConflict: 'id' }).select();
          if (!error) { lastErr = ''; break; }
          lastErr = error.message;
          break;
        } catch (e) {
          lastErr = (e && e.message) ? e.message : String(e);
          if (attempt < 2) await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
        }
      }
      if (lastErr) {
        // 云端保存失败也写本地缓存，避免辛苦填好的设置一刷新就丢
        try { localStorage.setItem('uslatiao_shipping', JSON.stringify(payload)); } catch (e) {}
        return { ok: false, error: lastErr + '。已暂存到本机浏览器（刷新不丢），请稍后重试保存' };
      }
    }
    try { localStorage.setItem('uslatiao_shipping', JSON.stringify(payload)); } catch (e) {}
    return { ok: true };
  }

  /* —— 运费模板：多套配置并存，可切换「使用」 —— */
  async function getShippingTemplates() {
    const database = db();
    if (database) {
      try {
        const { data, error } = await database.from('shipping_templates').select('*').order('updated_at', { ascending: false });
        if (!error && Array.isArray(data)) {
          return data.map(t => ({
            id: t.id, name: t.name || t.id,
            settings: normalizeSettings(t.settings || {}),
            updated_at: t.updated_at
          }));
        }
      } catch (e) {}
    }
    return [];
  }

  async function saveShippingTemplate(id, name, settings) {
    const tplId = id || ('tpl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
    const payload = { id: tplId, name: String(name || '').trim() || tplId, settings: normalizeSettings(settings), updated_at: new Date().toISOString() };
    const database = db();
    if (database) {
      try {
        const { error } = await database.from('shipping_templates').upsert(payload, { onConflict: 'id' }).select();
        if (error) return { ok: false, error: error.message, id: tplId };
      } catch (e) { return { ok: false, error: String(e), id: tplId }; }
    }
    return { ok: true, id: tplId };
  }

  async function deleteShippingTemplate(id) {
    const database = db();
    if (database) {
      try {
        const { error } = await database.from('shipping_templates').delete().eq('id', id).select();
        if (error) return { ok: false, error: error.message };
      } catch (e) { return { ok: false, error: String(e) }; }
    }
    return { ok: true };
  }

  // 使用模板：把模板设置写进默认生效行，并记下模板名（顶部卡片据此显示）
  async function useShippingTemplate(id) {
    const database = db();
    let tpl = null;
    if (database) {
      try {
        const { data } = await database.from('shipping_templates').select('*').eq('id', id).limit(1);
        if (data && data.length) tpl = data[0];
      } catch (e) {}
    }
    if (!tpl) return { ok: false, error: '模板不存在或已删除' };
    const merged = Object.assign({}, normalizeSettings(tpl.settings || {}), { active_template: tpl.name || id });
    const r = await saveShippingSettings(merged);
    return Object.assign({}, r, { settings: merged, name: tpl.name || id });
  }

  // 根据收货州匹配区域：先找明确列出该州的区域，否则落到 states 为空的默认区
  function matchZone(zones, state) {
    const st = String(state || '').trim().toUpperCase();
    const enabled = (zones || []).filter(z => z.enabled !== false);
    if (st) {
      const hit = enabled.find(z => Array.isArray(z.states) && z.states.map(x => String(x).toUpperCase()).indexOf(st) >= 0);
      if (hit) return hit;
    }
    return enabled.find(z => !Array.isArray(z.states) || !z.states.length) || enabled[0] || null;
  }

  // 分段费率：找到第一条上限 >= 值 的档位（上限 0 视为无上限）
  // 防御性排序：不管表格行顺序怎么填，都按上限从小到大匹配，0（以上全部）永远排最后，
  // 避免手滑把「以上全部」填在第一行导致所有订单都命中该档
  // 单位并存：每档可带 unit('oz'|'lb')，一律换算成 oz 再比较（lb × 16）
  function toOz(v, unit) { return unit === 'lb' ? v * 16 : v; }
  function tierRate(rates, value) {
    const list = (rates || []).filter(r => r != null)
      .map(r => ({ up: num(r.up_to) ? toOz(num(r.up_to), r.unit) : 0, rate: num(r.rate) }))
      .sort((a, b) => (a.up || Infinity) - (b.up || Infinity));
    for (let i = 0; i < list.length; i++) {
      if (list[i].up === 0 || value <= list[i].up) return list[i].rate;
    }
    return list.length ? list[list.length - 1].rate : 0;
  }

  // 计算运费
  // opts: { items:[{slug, qty, weight_oz, price}], subtotal, discountedSubtotal, destState, freeShipping:bool }
  // 返回 { rate, base, surcharge, handling, zone, zoneLabel, weightOz, free, reason }
  function computeShipping(opts, settings) {
    opts = opts || {};
    const s = normalizeSettings(settings || DEFAULT_SHIPPING);
    const items = opts.items || [];
    const subtotal = num(opts.subtotal);
    const discounted = num(opts.discountedSubtotal != null ? opts.discountedSubtotal : subtotal);

    // 总重（商品重量 × 数量；包装重量仅在设置开启「加收包装」时计入）
    const goodsOz = items.reduce((sum, it) => sum + num(it.weight_oz) * (parseInt(it.qty, 10) || 0), 0);
    const weightOz = +(goodsOz + (s.include_packaging_weight ? num(s.packaging_weight_oz) : 0)).toFixed(2);

    const zone = matchZone(s.zones, opts.destState) || { key: 'domestic', label: 'Continental US (48 states)', surcharge: 0 };

    const base0 = { rate: 0, base: 0, surcharge: 0, handling: 0, zone: zone.key || '', zoneLabel: zone.label || '', weightOz, free: true, reason: 'empty' };
    if (!items.length || subtotal <= 0) return base0;

    // 免邮折扣（free_shipping 类型的折扣码）
    if (opts.freeShipping) {
      return { rate: 0, base: 0, surcharge: 0, handling: 0, zone: zone.key || '', zoneLabel: zone.label || '', weightOz, free: true, reason: 'code' };
    }
    // 免邮门槛
    const basis = s.free_after_discount ? discounted : subtotal;
    if (num(s.free_threshold) > 0 && basis >= num(s.free_threshold)) {
      return { rate: 0, base: 0, surcharge: 0, handling: 0, zone: zone.key || '', zoneLabel: zone.label || '', weightOz, free: true, reason: 'threshold' };
    }

    let base = 0;
    if (s.mode === 'weight') base = tierRate(s.weight_rates, weightOz);
    else if (s.mode === 'price') base = tierRate(s.price_rates, basis);
    else base = num(s.flat_rate);

    const surcharge = num(zone.surcharge);
    const handling = num(s.handling_fee);
    const rate = +Math.max(0, base + surcharge + handling).toFixed(2);
    return { rate: +Math.max(0, base + surcharge + handling).toFixed(2), base: +base.toFixed(2), surcharge, handling, zone: zone.key || '', zoneLabel: zone.label || '', weightOz, goodsOz, free: false, reason: s.mode };
  }

  /* =======================================================================
   * 首页装修配置（homepage_settings 表单行，云端优先 + 本地兜底）
   *   hero       头图：eyebrow / title（\n 分行）/ lead / badges[] /
   *               cta_primary{label,href} / cta_secondary{label,href} /
   *               image（上传后为 data URI，空则 emoji 占位）/ art_text
   *   categories 分类入口：[{key,label,emoji}]
   *   featured   畅销商品：{mode:'recent'|'manual', count, slugs[]}
   *   story      品牌故事：{kicker,title,body,link_label,art_text}
   *   values     Why us 优势：[{icon,title,body}]
   *   drop       底部横幅：{kicker,title,body,cta_label,href}
   * ======================================================================= */
  const DEFAULT_HOME = {
    hero: {
      eyebrow: 'Stocked in the US',
      title: 'Asian snacks,\nalready stateside.',
      lead: 'The chili-oil strips and chocolate cups you crave — already in a warehouse here, shipping in one business day. No waiting on a boat.',
      badges: ['Ships in 1 business day', 'Free shipping over $35', 'No refrigeration'],
      cta_primary: { label: 'Shop all snacks', href: 'shop.html' },
      cta_secondary: { label: 'Our story', href: 'story.html' },
      image: '',
      art_text: 'Real snacks, real fast. From our US shelf to your door.'
    },
    categories: [
      { key: 'spicy-strips', label: 'Spicy Strips', emoji: '🌶️' },
      { key: 'chocolate-bites', label: 'Chocolate Bites', emoji: '🍫' },
      { key: 'variety-packs', label: 'Variety Packs', emoji: '🎁' },
      { key: 'bundles', label: 'Bundles', emoji: '📦' }
    ],
    cats_head: { kicker: 'Browse by category', title: 'Pick your aisle', sub: 'Four ways in. Find your heat, or start safe with a variety pack.' },
    featured: { mode: 'recent', count: 8, slugs: [] },
    feat_head: { kicker: 'Bestsellers', title: 'What people reorder', sub: 'Pulled from the shelf we keep stocked stateside.' },
    // 广告位：空数组 = 前台回退到原头图 / LATIAO10 促销条（未配置不破站）
    hero_ads: [],   // 头图区 3 个广告位：{image, link_type:'none'|'category'|'product', link_value, label}
    promo_ads: [],  // 促销条 3 张轮播图：同上结构
    story: {
      kicker: 'Our story',
      title: 'We got tired of waiting weeks for a snack.',
      body: "Asian pantry favorites shouldn't take a month to arrive. So we stocked them in the US and ship the same week you order. Same flavors, none of the wait.",
      link_label: 'Read more',
      art_text: "\"Already stateside\" isn't a tagline — it's the whole point."
    },
    values: [
      { icon: '🚚', title: '1-Day Ship', body: 'Leaves our US warehouse in one business day.' },
      { icon: '📦', title: 'US Stocked', body: 'No ocean freight, no surprise delays.' },
      { icon: '🌶️', title: 'Real Heat', body: 'Sichuan pepper that actually tingles.' },
      { icon: '🍫', title: 'Sweet Too', body: 'Chocolate cups and wafers for the rest of the table.' },
      { icon: '↩️', title: 'Easy Returns', body: 'Not your taste? Send it back, no fuss.' }
    ],
    values_head: { kicker: 'Why us', title: 'Not another 3-week wait' },
    drop: {
      kicker: 'New here?',
      title: 'Not sure how hot you like it?',
      body: 'Start with the First-Timer Variety Pack — six snacks across the heat scale.',
      cta_label: 'Shop the pack',
      href: 'product.html?slug=first-timer-variety-pack'
    }
  };

  // jsonb 字段可能是数组/对象，也可能是 JSON 字符串，统一解析
  function parseJ(v, fallback) {
    if (v == null) return fallback;
    if (typeof v === 'string') { try { const p = JSON.parse(v); return p == null ? fallback : p; } catch (e) { return fallback; } }
    return v;
  }
  const str = (v, d) => (typeof v === 'string' && v.length ? v : (d == null ? '' : d));

  function normalizeHome(s) {
    s = s || {};
    const arr = v => { const p = parseJ(v, []); return Array.isArray(p) ? p : []; };
    const obj = v => { const p = parseJ(v, {}); return (p && typeof p === 'object' && !Array.isArray(p)) ? p : {}; };
    const D = DEFAULT_HOME;
    const hero = Object.assign({}, D.hero, obj(s.hero));
    hero.badges = arr(hero.badges).filter(x => x);
    hero.cta_primary = Object.assign({}, D.hero.cta_primary, obj(hero.cta_primary));
    hero.cta_secondary = Object.assign({}, D.hero.cta_secondary, obj(hero.cta_secondary));
    const story = Object.assign({}, D.story, obj(s.story));
    const drop = Object.assign({}, D.drop, obj(s.drop));
    const featured = Object.assign({}, D.featured, obj(s.featured));
    featured.mode = featured.mode === 'manual' ? 'manual' : 'recent';
    featured.count = Math.max(1, parseInt(featured.count, 10) || 8);
    featured.slugs = arr(featured.slugs).filter(x => x);
    // 广告位：固定补齐为 3 槽；link_type 只认 none/category/product
    const adSlots = v => {
      const list = arr(v).slice(0, 3).map(a => ({
        image: str(a && a.image),
        link_type: ['category', 'product'].indexOf(a && a.link_type) >= 0 ? a.link_type : 'none',
        link_value: str(a && a.link_value),
        label: str(a && a.label)
      }));
      while (list.length < 3) list.push({ image: '', link_type: 'none', link_value: '', label: '' });
      return list;
    };
    const categories = arr(s.categories).length ? arr(s.categories).map(c => ({
      key: str(c && c.key), label: str(c && c.label, c && c.key), emoji: str(c && c.emoji, '🍬')
    })).filter(c => c.key) : D.categories;
    const values = arr(s.values).length ? arr(s.values).map(v => ({
      icon: str(v && v.icon, '⭐'), title: str(v && v.title), body: str(v && v.body)
    })).filter(v => v.title) : D.values;
    return {
      hero, categories, featured, story, values, drop,
      hero_ads: adSlots(s.hero_ads),
      promo_ads: adSlots(s.promo_ads),
      cats_head: Object.assign({}, D.cats_head, obj(s.cats_head)),
      feat_head: Object.assign({}, D.feat_head, obj(s.feat_head)),
      values_head: Object.assign({}, D.values_head, obj(s.values_head))
    };
  }

  async function getHomeSettings() {
    const database = db();
    if (database) {
      try {
        const { data, error } = await database.from('homepage_settings').select('*').eq('id', 'default').limit(1);
        if (!error && Array.isArray(data) && data.length) return normalizeHome(data[0]);
      } catch (e) {}
    }
    try {
      const local = JSON.parse(localStorage.getItem('uslatiao_home'));
      if (local) return normalizeHome(local);
    } catch (e) {}
    return normalizeHome(DEFAULT_HOME);
  }

  async function saveHomeSettings(s) {
    const n = normalizeHome(s);
    const payload = {
      id: 'default', updated_at: new Date().toISOString(),
      hero: n.hero, categories: n.categories, featured: n.featured,
      hero_ads: n.hero_ads, promo_ads: n.promo_ads,
      story: n.story, values: n.values, drop: n.drop,
      cats_head: n.cats_head, feat_head: n.feat_head, values_head: n.values_head
    };
    const database = db();
    if (database) {
      try {
        const { error } = await database.from('homepage_settings').upsert(payload, { onConflict: 'id' }).select();
        if (error) return { ok: false, error: error.message };
      } catch (e) { return { ok: false, error: String(e) }; }
    }
    try { localStorage.setItem('uslatiao_home', JSON.stringify(payload)); } catch (e) {}
    return { ok: true };
  }

  /* =========================================================================
   * 商品分类（全站唯一数据源：商品编辑 / 前台筛选 / 首页入口 都读这里）
   * ========================================================================= */
  const DEFAULT_CATEGORIES = [
    { key: 'spicy-strips',    label_en: 'Spicy Strips',    label_cn: '辣条类',       emoji: '🌶️', sort_order: 1, enabled: true },
    { key: 'chocolate-bites', label_en: 'Chocolate Bites', label_cn: '巧克力星球杯', emoji: '🍫', sort_order: 2, enabled: true },
    { key: 'variety-packs',   label_en: 'Variety Packs',   label_cn: '混合装',       emoji: '🎁', sort_order: 3, enabled: true },
    { key: 'bundles',         label_en: 'Bundles',         label_cn: '组合礼包',     emoji: '📦', sort_order: 4, enabled: true }
  ];

  // key 去重 + 补齐 + 排序；空表回退默认四条
  function normalizeCategories(list) {
    const seen = {};
    const out = [];
    (Array.isArray(list) ? list : []).forEach((c, i) => {
      const key = String((c && c.key) || '').trim();
      if (!key || seen[key]) return;
      seen[key] = 1;
      out.push({
        key,
        label_en: String((c && c.label_en) || (c && c.label) || key).trim() || key,
        label_cn: String((c && c.label_cn) || '').trim(),
        emoji: String((c && c.emoji) || '🍬').trim() || '🍬',
        sort_order: Number.isFinite(+(c && c.sort_order)) ? +(c.sort_order) : i + 1,
        enabled: (c && c.enabled === false) ? false : true
      });
    });
    out.sort((a, b) => a.sort_order - b.sort_order || a.key.localeCompare(b.key));
    return out.length ? out : DEFAULT_CATEGORIES.slice();
  }

  async function getProductCategories() {
    const database = db();
    if (database) {
      try {
        const { data, error } = await database.from('product_categories').select('*').order('sort_order', { ascending: true });
        if (!error && Array.isArray(data) && data.length) {
          const list = normalizeCategories(data);
          applyCategoriesToShop(list);
          return list;
        }
      } catch (e) {}
    }
    try {
      const local = JSON.parse(localStorage.getItem('uslatiao_cats'));
      if (local && local.length) {
        const list = normalizeCategories(local);
        applyCategoriesToShop(list);
        return list;
      }
    } catch (e) {}
    const list = normalizeCategories(DEFAULT_CATEGORIES);
    applyCategoriesToShop(list);
    return list;
  }

  // 商品分类内存缓存：后台「保存分类」后由 saveProductCategories 直接更新，避免重复读库
  let _catsCache = null;
  async function getProductCategoriesCached() {
    if (_catsCache) return _catsCache;
    const list = await getProductCategories();
    _catsCache = list;
    return list;
  }

  // 同步进 shop.js 的字典，让 categoryLabel / emojiFor 立即生效
  function applyCategoriesToShop(list) {
    try { if (window.Shop && window.Shop.setCategories) window.Shop.setCategories(list); } catch (e) {}
    try { window.dispatchEvent(new CustomEvent('shop:cats', { detail: list })); } catch (e) {}
  }

  async function saveProductCategories(list) {
    const rows = normalizeCategories(list).map(c => ({
      key: c.key, label_en: c.label_en, label_cn: c.label_cn,
      emoji: c.emoji, sort_order: c.sort_order, enabled: c.enabled,
      updated_at: new Date().toISOString()
    }));
    const database = db();
    if (database) {
      try {
        const { error } = await database.from('product_categories').upsert(rows, { onConflict: 'key' }).select();
        if (error) return { ok: false, error: error.message };
        // 删除本次不再存在的分类
        const keep = rows.map(r => r.key);
        const { data: cur } = await database.from('product_categories').select('key');
        const gone = (cur || []).map(r => r.key).filter(k => keep.indexOf(k) === -1);
        if (gone.length) {
          await database.from('product_categories').delete().in('key', gone);
        }
      } catch (e) { return { ok: false, error: String(e) }; }
    }
    try { localStorage.setItem('uslatiao_cats', JSON.stringify(rows)); } catch (e) {}
    applyCategoriesToShop(rows);
    _catsCache = rows; // 写回内存缓存，下次读取不重复走网络
    return { ok: true };
  }

  // key -> 标签（中文优先给后台，英文给顾客端）
  function categoryLabelOf(list, key) {
    const hit = (list || []).filter(c => c.key === key)[0];
    return hit ? (hit.label_en || key) : key;
  }
  function categoryCnOf(list, key) {
    const hit = (list || []).filter(c => c.key === key)[0];
    return hit ? (hit.label_cn || hit.label_en || key) : key;
  }

  /* —— 邮件订阅者（注册入口收集） —— */
  // 订阅表是独立于账号的：留邮箱即可订阅，不强制注册。
  // 触发时机参考美国 DTC 主流做法：滚动中弹窗 + 下单后邀请 + 页脚常驻。
  async function subscribe(email, source, meta) {
    const mail = String(email || '').trim().toLowerCase();
    if (!mail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      return { ok: false, error: 'Please enter a valid email address' };
    }
    const database = db();
    if (database) {
      try {
        const now = new Date().toISOString();
        // 邮箱唯一：已存在则更新来源与时间（upsert onConflict=email）
        const { error } = await database.from('subscribers').upsert({
          id: 'sub-' + mail.replace(/[^a-z0-9]/g, '') + '-' + Date.now().toString(36),
          email: mail,
          source: String(source || 'unknown'),
          source_meta: String(meta || ''),
          status: 'active',
          created_at: now,
          updated_at: now
        }, { onConflict: 'email' });
        if (error) return { ok: false, error: error.message };
        return { ok: true, email: mail };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    }
    // 本地兜底（预览模式）
    try {
      const key = 'uslatiao_subscribers';
      const list = JSON.parse(localStorage.getItem(key)) || [];
      const i = list.findIndex(s => s.email === mail);
      const rec = { email: mail, source: String(source || 'unknown'), source_meta: String(meta || ''), created_at: new Date().toISOString() };
      if (i >= 0) list[i] = Object.assign({}, list[i], { source: rec.source, source_meta: rec.source_meta }); else list.push(rec);
      localStorage.setItem(key, JSON.stringify(list));
    } catch (e) {}
    return { ok: true, email: mail, local: true };
  }

  async function isSubscriber(email) {
    const mail = String(email || '').trim().toLowerCase();
    if (!mail) return false;
    const database = db();
    if (database) {
      try {
        const { data, error } = await database.from('subscribers').select('email').eq('email', mail).limit(1);
        if (!error && Array.isArray(data)) return data.length > 0;
      } catch (e) {}
    }
    try {
      const list = JSON.parse(localStorage.getItem('uslatiao_subscribers')) || [];
      return list.some(s => s.email === mail);
    } catch (e) { return false; }
  }

  // 管理员：全部订阅者
  async function getSubscribers() {
    const database = db();
    if (database) {
      try {
        const { data, error } = await database.from('subscribers').select('*').order('created_at', { ascending: false });
        if (!error && Array.isArray(data)) return data;
      } catch (e) {}
    }
    try { return JSON.parse(localStorage.getItem('uslatiao_subscribers')) || []; } catch (e) { return []; }
  }

  async function deleteSubscriber(email) {
    const mail = String(email || '').trim().toLowerCase();
    const database = db();
    if (database) {
      try {
        const { error } = await database.from('subscribers').delete().eq('email', mail).select();
        if (error) return { ok: false, error: error.message };
      } catch (e) { return { ok: false, error: String(e) }; }
    }
    try {
      const list = (JSON.parse(localStorage.getItem('uslatiao_subscribers')) || []).filter(s => s.email !== mail);
      localStorage.setItem('uslatiao_subscribers', JSON.stringify(list));
    } catch (e) {}
    return { ok: true };
  }

  /* —— 顾客聚合（从订单聚合顾客档案） —— */
  function getCustomers(orders) {
    const map = {};
    (orders || []).forEach(o => {
      const email = (o.email || '').trim() || '(guest)';
      if (!map[email]) map[email] = { email, orders: 0, spent: 0, last: '', items: 0 };
      map[email].orders += 1;
      map[email].spent += (+o.total || 0);
      map[email].items += (o.items || []).reduce((s, it) => s + (+it.qty || 0), 0);
      const d = o.created_at || '';
      if (d > map[email].last) map[email].last = d;
    });
    return Object.values(map).sort((a, b) => b.spent - a.spent);
  }

  /* =========================================================================
   * 后台管理员名单（admin_users）
   * 独立于前台顾客账号：只有表内 active 的邮箱才允许进入后台写任何数据。
   * RLS：任何 admin 可读；仅 owner（role='owner'）可增删改。
   * 查询一律带超时：SDK 请求偶发挂起时，门禁/登录流程必须能恢复，不能卡死。
   * ========================================================================= */
  function withTimeout(p, ms, label) {
    return Promise.race([
      Promise.resolve(p),
      new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' timeout')), ms))
    ]);
  }
  async function getAdmins() {
    const database = db();
    if (database) {
      try {
        const { data, error } = await withTimeout(
          database.from('admin_users').select('*').order('created_at', { ascending: true }), 10000, 'admins read');
        if (!error && Array.isArray(data)) return { ok: true, rows: data };
        return { ok: false, error: (error && error.message) || 'read failed' };
      } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    }
    return { ok: false, error: 'Cloud not available' };
  }

  // 后台门禁用：按邮箱核对是否为启用中的管理员。非管理员查不到行（RLS 静默返回空），
  // 调用方据此拒绝进入——不泄露名单内容。
  async function getAdminByEmail(email) {
    const em = String(email || '').trim();
    if (!em) return { ok: true, row: null };
    const database = db();
    if (database) {
      try {
        const { data, error } = await withTimeout(
          database.from('admin_users').select('*').eq('email', em).limit(1), 10000, 'admin lookup');
        if (!error) {
          const rows = Array.isArray(data) ? data : (data ? [data] : []);
          // 精确匹配空时再宽松匹配一次（RLS 静默返回空与真的不存在都走这条兜底）
          if (!rows.length) {
            const all = await getAdmins();
            if (all.ok && all.rows) {
              const hit = all.rows.find(r => String(r.email || '').toLowerCase() === em.toLowerCase());
              if (hit) return { ok: true, row: hit };
            }
          }
          return { ok: true, row: rows[0] || null };
        }
        return { ok: false, error: error.message };
      } catch (e) { return { ok: false, error: String(e) }; }
    }
    return { ok: false, error: 'Cloud not available' };
  }

  async function addAdmin(a) {
    const email = String((a && a.email) || '').trim().toLowerCase();
    const name = String((a && a.name) || '').trim();
    const role = (a && a.role === 'owner') ? 'owner' : 'admin';
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: '邮箱格式不正确' };
    const database = db();
    if (database) {
      try {
        // 不带 .select()：避免 PostgREST 回读触发 RLS SELECT 判定（42501 坑）
        const { error } = await database.from('admin_users').insert({ email, name, role, active: true });
        if (error) return { ok: false, error: error.message };
        return { ok: true };
      } catch (e) { return { ok: false, error: String(e) }; }
    }
    return { ok: false, error: 'Cloud not available' };
  }

  async function setAdminActive(id, active) {
    const database = db();
    if (database) {
      try {
        const { error } = await database.from('admin_users').update({ active: !!active }).eq('id', id);
        if (error) return { ok: false, error: error.message };
        return { ok: true };
      } catch (e) { return { ok: false, error: String(e) }; }
    }
    return { ok: false, error: 'Cloud not available' };
  }

  async function deleteAdmin(id) {
    const database = db();
    if (database) {
      try {
        const { error } = await database.from('admin_users').delete().eq('id', id);
        if (error) return { ok: false, error: error.message };
        return { ok: true };
      } catch (e) { return { ok: false, error: String(e) }; }
    }
    return { ok: false, error: 'Cloud not available' };
  }

  /* =========================================================================
   * 批量导入（表格 → 草稿商品）
   * 来源：运营表格（CSV/JSON，列见 deploy/product-import-template.csv）。
   * 原则：一律以 draft（草稿）落库，运营在后台商品页改完点「上架」才对顾客可见；
   *       slug/sku 自动生成；图片/链接原样带过去，供运营核对。
   * ========================================================================= */
  function slugify(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
  function splitList(v) {
    return String(v || '').split(/[|;；]/).map(x => x.trim()).filter(Boolean);
  }
  // 表格一行 → 商品对象（草稿）。人填的只有：链接/品名/类目/价/库存/辣度/重量/规格/图/标签。
  function normalizeImportRow(row) {
    const nameEn = String(row.name_en || row.name || '').trim();
    const nameCn = String(row.name_cn || '').trim();
    const slug = slugify(row.slug || nameEn || nameCn);
    const price = parseFloat(row.price_usd);
    const stock = parseInt(row.stock, 10);
    const soldCount = parseInt(row.sold_count != null ? row.sold_count : row.sold, 10);
    const heat = Math.max(0, Math.min(5, parseInt(row.heat, 10) || 0));
    const weightOz = parseFloat(row.weight_oz) || 0;
    const images = splitList(row.images);
    const vLabel = String(row.variant_label || '').trim();
    const vPrice = parseFloat(row.variant_price_usd);
    const variants = vLabel
      ? [{ sku: (row.sku ? String(row.sku) : slug.toUpperCase().slice(0, 12)) + '-1', option_label: vLabel, price: isNaN(vPrice) ? price : vPrice, weight_oz: weightOz, stock: isNaN(stock) ? 0 : stock, image: images[0] || '' }]
      : [];
    const tags = splitList(row.tags);
    return {
      slug,
      name: nameEn || nameCn,
      subtitle: String(row.subtitle_en || (tags.length ? tags.join(' · ') : '')).trim(),
      category: String(row.category || '').trim() || 'spicy-strips',
      price: isNaN(price) ? 0 : price,
      compare_at: row.compare_at_usd ? parseFloat(row.compare_at_usd) : null,
      stock: isNaN(stock) ? 0 : stock,
      sold_count: isNaN(soldCount) ? 0 : soldCount, // 销量展示基数（导入时可一并给）
      heat,
      status: 'draft', // 永远草稿：运营确认后才上架
      sku: row.sku ? String(row.sku) : slug.toUpperCase().slice(0, 12),
      weight_oz: weightOz,
      length_in: parseFloat(row.length_in) || 0,
      width_in: parseFloat(row.width_in) || 0,
      height_in: parseFloat(row.height_in) || 0,
      image: images[0] || '',
      images,
      detail_images: splitList(row.detail_images),
      option_name: vLabel ? 'Pack' : '',
      variants,
      source_url: String(row.source_url || '').trim(), // 1688 链接，供运营回查
      note: String(row.note || '').trim(),             // 运营备注，不进前台
      created_at: new Date().toISOString()
    };
  }
  async function importProducts(rows) {
    const list = (rows || []).filter(r => r && (r.name_en || r.name || r.name_cn));
    if (!list.length) return { ok: false, error: '没有可导入的行（至少要有商品名）' };
    const items = list.map(normalizeImportRow);
    // slug 去重：同表内重复只留第一行
    const seen = {};
    const dup = [];
    const uniq = items.filter(p => {
      if (!p.slug) return false;
      if (seen[p.slug]) { dup.push(p.slug); return false; }
      seen[p.slug] = 1;
      return true;
    });
    const database = db();
    const failed = [];
    let inserted = 0;
    if (database) {
      for (const p of uniq) {
        try {
          // 不带 .select()：避免 PostgREST 回读触发 RLS SELECT 判定（42501 坑）
          const { error } = await database.from('products').upsert(p, { onConflict: 'slug' });
          if (error) failed.push({ slug: p.slug, error: error.message });
          else inserted++;
        } catch (e) { failed.push({ slug: p.slug, error: String(e) }); }
      }
    }
    // 本地兜底与云端一致：写进 local override，保证预览环境也有数据
    try {
      let local = _productsCache || localOverride() || await fetchJsonProducts();
      uniq.forEach(p => {
        const i = local.findIndex(x => x.slug === p.slug);
        if (i >= 0) local[i] = p; else local.push(p);
      });
      _productsCache = local;
      localStorage.setItem(LOCAL_OVERRIDE, JSON.stringify(local));
    } catch (e) {}
    return { ok: failed.length === 0, inserted, failed, duplicates: dup, drafts: uniq.length };
  }

  // 上传图片进 media 表（P1：base64 迁出业务表）。已是链接（含 /media/xx）直接返回，不二次上传。
  // 写入走当前登录态（hq 后台管理员），RLS media_admin_insert 用 is_admin() 把关，匿名插不进。
  // 返回本站代读链接 /media/<id>，由 Cloudflare Worker 用发布密钥代读吐图（公开 SELECT 已放行）。
  async function uploadMedia(dataUri, kind) {
    if (!dataUri) return '';
    if (/^(https?:\/\/|\/media\/)/i.test(dataUri)) return dataUri; // 已是链接，原样返回
    const m = String(dataUri).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!m) throw new Error('bad_data_uri');
    const id = makeUuid();
    const { error } = await db().from('media').insert({
      id: id,
      kind: kind || 'media',
      content_type: m[1],
      data: m[2],
      bytes: Math.round(m[2].length * 0.75)
    });
    if (error) throw new Error(error.message || 'media_insert_failed');
    return '/media/' + id;
  }

  // —— 网站浏览埋点读取（page_views 表，RLS：仅 is_admin 可 SELECT）——
  // 后台仪表盘「网站浏览」区块专用；游客/前台写入见 assets/js/analytics.js。
  // 只取聚合所需窄列，按 created_at 倒序、设上限，避免把整表拖进浏览器。
  async function getPageViews(days) {
    days = Math.max(1, Math.min(90, parseInt(days, 10) || 30));
    const database = db();
    if (!database) return [];
    const since = new Date(Date.now() - days * 86400000).toISOString();
    try {
      const { data, error } = await database.from('page_views')
        .select('session_id,event,path,product_slug,referrer_host,utm_source,utm_medium,utm_campaign,device,new_visitor,source_kind,country,region,created_at')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(30000);
      if (error) throw error;
      return data || [];
    } catch (e) { return []; }
  }

  /* —— 销量（前台展示用）——
   * 显示口径：products.sold_count（后台设置的基数）+ 真实订单量（orders.items 按 slug 累加 qty，排除取消单）。
   * 只取 items/status 两列窄读，orders 再大也拖不垮；失败静默返回 {}，前台退化为只显示基数。 */
  async function getSoldCounts() {
    const database = db();
    if (!database) return {};
    try {
      const { data, error } = await database.from('orders').select('items,status');
      if (error || !Array.isArray(data)) return {};
      const out = {};
      data.forEach(o => {
        if (String(o.status || '').toLowerCase() === 'cancelled') return;
        (Array.isArray(o.items) ? o.items : []).forEach(it => {
          if (!it || !it.slug) return;
          out[it.slug] = (out[it.slug] || 0) + (parseInt(it.qty, 10) || 0);
        });
      });
      return out;
    } catch (e) { return {}; }
  }

  // 前台销量显示值：基数 + 真实订单；格式化为 1.2k+
  function soldOf(product, realCounts) {
    const base = parseInt(product && product.sold_count, 10) || 0;
    const real = (realCounts && parseInt(realCounts[product.slug], 10)) || 0;
    const n = base + real;
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k+';
    return String(n);
  }

  return {
    getProducts, publishProducts, saveProduct, deleteProduct, seedFromJson,
    getPageViews,
    uploadMedia,
    getDiscounts, saveDiscount, deleteDiscount, validateDiscount,
    createOrder, getMyOrders, getAllOrders, updateOrder, deletePendingOrders,
    getReviews, saveReview, updateReview, deleteReview,
    refundOrder, discountAnalytics, getCustomers,
    createReturnRequest, getReturnRequests, updateReturnRequest, getMyReturnRequests,
    subscribe, isSubscriber, getSubscribers, deleteSubscriber,
    getShippingSettings, saveShippingSettings, computeShipping, matchZone,
    getShippingTemplates, saveShippingTemplate, deleteShippingTemplate, useShippingTemplate,
    DEFAULT_SHIPPING,
    getHomeSettings, saveHomeSettings, DEFAULT_HOME,
    getProductCategories, saveProductCategories, DEFAULT_CATEGORIES,
    categoryLabelOf, categoryCnOf,
    getAdmins, addAdmin, setAdminActive, deleteAdmin, getAdminByEmail,
    importProducts, normalizeImportRow,
    getProductsList, getProductBySlug, patchProduct, getProductsFront,
    getSoldCounts, soldOf
  };
})();
