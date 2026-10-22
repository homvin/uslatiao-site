/* =========================================================================
 * USLATIAO 自建站 · 网站浏览埋点（后台仪表盘流量监控数据源）
 * -------------------------------------------------------------------------
 * 目的：给后台「网站浏览」区块提供标准电商流量数据 ——
 *       PV/UV、新老客、流量来源、设备、热门页面、商品浏览、转化漏斗。
 *
 * 存储：page_views 表。RLS：anon 可 INSERT、仅管理员(is_admin)可 SELECT。
 * 写入：裸 fetch + 发布密钥 + Prefer: return=minimal，
 *       —— 故意不走 Cloud SDK，避开 SDK 可能自动附加的 ?select=*
 *          触发游客写入 42501（见 data.js uploadMedia/createOrder 同款规避）。
 * 隐私：只记匿名 session_id，绝不记邮箱/身份/订单，游客与登录用户一视同仁。
 *
 * 采集事件：
 *   pageview       每次页面加载（商品页额外带 product_slug）
 *   product_view   商品详情页
 *   add_to_cart    加购（monkeypatch window.Store.add，全站加购按钮全覆盖）
 *   begin_checkout 进入结账页
 * ========================================================================= */
window.Analytics = (function () {
  var SESS_KEY = 'usl_ana_sess';   // 会话 id（sessionStorage，关浏览器即结束）
  var NV_KEY = 'usl_ana_nv';       // 本会话是否新客
  var UID_KEY = 'usl_ana_uid';     // 持久 uid（localStorage，判新/老客）
  var UTM_KEY = 'usl_ana_utm';     // 首次触达 utm（会话内留存）
  var sent = false;

  function uuid() {
    try { if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID(); } catch (e) {}
    var b = new Uint8Array(16);
    try { window.crypto.getRandomValues(b); }
    catch (e) { for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256); }
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = []; for (var j = 0; j < 16; j++) h.push((b[j] + 0x100).toString(16).slice(1));
    return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' + h.slice(6, 8).join('') +
      '-' + h.slice(8, 10).join('') + '-' + h.slice(10, 16).join('');
  }

  // 会话级信息：id + 是否新客（新客只在“此生首次会话”为 true，之后全 false）
  function session() {
    try {
      var s = sessionStorage.getItem(SESS_KEY);
      if (!s) {
        s = uuid();
        sessionStorage.setItem(SESS_KEY, s);
        var nv = '0';
        try { if (!localStorage.getItem(UID_KEY)) { localStorage.setItem(UID_KEY, '1'); nv = '1'; } } catch (e) {}
        sessionStorage.setItem(NV_KEY, nv);
      }
      return { id: s, nv: sessionStorage.getItem(NV_KEY) === '1' };
    } catch (e) { return { id: uuid(), nv: false }; }
  }

  // utm：优先取当前 URL，没有则沿用本会话首次触达值（站内跳转不丢来源）
  function utm() {
    var q = {};
    try {
      var sp = new URLSearchParams(location.search);
      ['utm_source', 'utm_medium', 'utm_campaign'].forEach(function (k) { var v = sp.get(k); if (v) q[k] = v; });
    } catch (e) {}
    try {
      if (Object.keys(q).length) sessionStorage.setItem(UTM_KEY, JSON.stringify(q));
      else q = JSON.parse(sessionStorage.getItem(UTM_KEY) || '{}');
    } catch (e) {}
    return q || {};
  }

  function refHost() {
    try { return document.referrer ? new URL(document.referrer).hostname.replace(/^www\./, '') : ''; } catch (e) { return ''; }
  }
  function selfHost() { try { return location.hostname.replace(/^www\./, ''); } catch (e) { return ''; } }

  // 来源归类：utm → campaign；无 referrer → direct；站内 → internal；
  // 搜索引擎 → organic；其余 → referral
  function sourceKind(u, host) {
    if (u.utm_source || u.utm_medium) return 'campaign';
    if (!host) return 'direct';
    if (host === selfHost()) return 'internal';
    if (/(google|bing|duckduckgo|yahoo|baidu|ecosia|yandex|sogou)\./.test(host)) return 'organic';
    return 'referral';
  }

  function device() {
    var ua = navigator.userAgent || '';
    if (/iPad|Tablet|(?!.*Mobile).*Silk/i.test(ua)) return 'tablet';
    if (/Mobi|Android|iPhone|iPod|Windows Phone/i.test(ua)) return 'mobile';
    var w = window.innerWidth || 0;
    if (w && w <= 768) return 'mobile';
    return 'desktop';
  }

  // 发送一条事件（fire-and-forget，keepalive 保证跳转/关页也能送达）
  function send(evt, extra) {
    var c = window.APP_CONFIG && window.APP_CONFIG.CLOUD;
    if (!c || !c.publishableKey) return;                 // 本地预览/无密钥：静默跳过
    var endpoint = (c.endpoint || '').replace(/\/+$/, '');
    if (!/^https?:/.test(endpoint)) return;
    var u = utm();
    var host = refHost();
    var row = {
      id: uuid(),
      session_id: session().id,
      event: evt || 'pageview',
      path: location.pathname || '/',
      product_slug: (extra && extra.product_slug) || null,
      referrer_host: host,
      utm_source: u.utm_source || '',
      utm_medium: u.utm_medium || '',
      utm_campaign: u.utm_campaign || '',
      device: device(),
      new_visitor: session().nv,
      source_kind: sourceKind(u, host)
    };
    try {
      fetch(endpoint + '/.cloud/database/rest/page_views', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-wb-webapp-access-key': c.publishableKey,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(row),
        keepalive: true,
        credentials: 'omit'
      }).catch(function () {});
    } catch (e) {}
  }

  // 加载即埋：pageview；商品页补 product_view；结账页埋 begin_checkout
  function autoTrack() {
    if (sent) return; sent = true;
    var p = location.pathname;
    var slug = '';
    if (/product\.html/.test(p)) { try { slug = new URLSearchParams(location.search).get('slug') || ''; } catch (e) {} }
    send('pageview', slug ? { product_slug: slug } : null);
    if (slug) send('product_view', { product_slug: slug });
    if (/checkout\.html/.test(p)) send('begin_checkout');
  }

  // 包裹 Store.add：任何加购都记一条 add_to_cart（带商品 slug）
  function hookCart() {
    if (!window.Store || !window.Store.add || window.Store.__anaHooked) return;
    var orig = window.Store.add;
    window.Store.add = function (slug, qty, variant) {
      try { send('add_to_cart', { product_slug: slug }); } catch (e) {}
      return orig.apply(this, arguments);
    };
    window.Store.__anaHooked = true;
  }

  function init() { hookCart(); autoTrack(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { track: send };
})();
