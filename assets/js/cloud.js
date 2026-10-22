/* =========================================================================
 * 云后端初始化（CDN 全局 SDK：WorkBuddyCloud）
 * 仅暴露前端安全的 publicConfig，任何密钥都不写进前端代码。
 * 注：云端强制精确 Origin 匹配 —— 本地 localhost 预览无法访问云后端，
 *     需在发布到 https://uslatiao-store.app.workbuddy.host 后功能才生效。
 * ========================================================================= */
window.Cloud = (function () {
  let cloud = null;
  let adminCloud = null; // 后台专用客户端（独立会话存储，与前台顾客会话互不干扰）

  function sdk() { return window.WorkBuddyCloud || null; }

  // 后台会话存储：同源 localStorage 的独立命名空间（前缀 admin-hq:）。
  // SDK 内部键为 workbuddy-cloud.session.<publishableKey>，加了前缀后
  // 后台登录态与前台顾客登录态就是两条互不覆盖的记录，实现账号体系隔离。
  const ADMIN_STORAGE_PREFIX = 'admin-hq:';
  function adminStorage() {
    const wrap = store => ({
      getItem: k => { try { return store.getItem(ADMIN_STORAGE_PREFIX + k); } catch (e) { return null; } },
      setItem: (k, v) => { try { store.setItem(ADMIN_STORAGE_PREFIX + k, v); } catch (e) {} },
      removeItem: k => { try { store.removeItem(ADMIN_STORAGE_PREFIX + k); } catch (e) {} }
    });
    try { if (typeof localStorage !== 'undefined') return wrap(localStorage); } catch (e) {}
    return null;
  }

  // 后台页调用：创建独立会话的后台客户端。此后 Cloud.* 全部走这个客户端。
  async function initAdminClient(timeoutMs) {
    if (adminCloud) return adminCloud;
    await ready(timeoutMs || 8000);
    if (!cloud || !sdk()) return null;
    try {
      adminCloud = sdk().createWorkBuddyCloud({
        endpoint: APP_CONFIG.CLOUD.endpoint,
        oauthRelayBaseUrl: APP_CONFIG.CLOUD.oauthRelayBaseUrl,
        publishableKey: APP_CONFIG.CLOUD.publishableKey,
        storage: adminStorage()
      });
    } catch (e) { console.warn('[cloud] admin client init failed', e); }
    return adminCloud;
  }

  // 只退后台会话，不动前台顾客的登录态
  async function adminSignOut() {
    const c = adminCloud;
    adminCloud = null;
    if (c && c.auth && c.auth.signOut) { try { await c.auth.signOut(); } catch (e) {} }
    try {
      const key = ADMIN_STORAGE_PREFIX + 'workbuddy-cloud.session.' + APP_CONFIG.CLOUD.publishableKey;
      if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
    } catch (e) {}
  }

  function init() {
    if (adminCloud) return adminCloud;
    if (cloud) return cloud;
    if (!sdk()) {
      console.warn('[cloud] SDK 未加载（可能 CDN 被拦截或本地预览）');
      return null;
    }
    cloud = sdk().createWorkBuddyCloud({
      endpoint: APP_CONFIG.CLOUD.endpoint,
      oauthRelayBaseUrl: APP_CONFIG.CLOUD.oauthRelayBaseUrl,
      publishableKey: APP_CONFIG.CLOUD.publishableKey
    });
    return cloud;
  }

  // 等待 SDK 就绪后再初始化（CDN 较慢或脚本次序问题时的兜底），超时放弃
  // 注意：adminCloud（后台独立会话）必须优先——否则后台页的登录/读会话会错走
  // 前台顾客客户端，导致「登录写顾客空间、查名单走后台空间」的撕裂状态。
  async function ready(timeoutMs) {
    if (adminCloud) return adminCloud;
    if (cloud) return cloud;
    const t0 = Date.now();
    while (!sdk() && Date.now() - t0 < (timeoutMs || 6000)) {
      await new Promise(r => setTimeout(r, 60));
    }
    return init();
  }

  // —— 邮箱挖掘：SDK 会话里 email 不保证在 user.email 顶层，多路径兜底 ——
  function pickEmail(u) {
    if (!u) return '';
    if (typeof u.email === 'string' && u.email) return u.email;
    const md = u.user_metadata || {};
    const id = u.identity_data || {};
    return md.email || md.user_email || id.email || '';
  }
  function userEmail(session) {
    if (!session) return '';
    return pickEmail(session.user)
      || pickEmail(session.session && session.session.user)
      || (typeof session.email === 'string' ? session.email : '')
      || '';
  }

  async function getSession() {
    const c = await ready(); if (!c) return null;
    try {
      const { data, error } = await c.auth.getSession();
      if (error || !data) return null;
      // 会话里挖不到邮箱时，向服务器验证当前用户并把 email 合并进会话，
      // 下游所有 session.user.email 的读取因此保证有值。
      if (data.user && !pickEmail(data.user)) {
        try {
          const me = await c.auth.getUser();
          const em = me && me.data ? pickEmail(me.data.user || me.data) : '';
          if (em) data.user.email = em;
        } catch (e) { /* getUser 失败不阻断会话 */ }
      }
      return data;
    }
    catch (e) { return null; }
  }

  function isAdmin(session) {
    if (!session) return false;
    const email = (userEmail(session) || '').toLowerCase();
    if (!email) return false;
    return APP_CONFIG.ADMIN_EMAILS.map(e => e.toLowerCase()).includes(email);
  }

  async function sendOtp(email) {
    const c = await ready(); if (!c) return { error: { message: 'Cloud not loaded' } };
    return c.auth.sendOtp({ email });
  }

  async function verifyOtp(payload) {
    const c = await ready(); if (!c) return { error: { message: 'Cloud not loaded' } };
    return c.auth.verifyOtp(payload);
  }

  async function signOut() {
    const c = await ready(); if (!c) return;
    try { await c.auth.signOut(); } catch (e) {}
  }

  function onChange(cb) {
    ready().then(c => {
      if (!c) return;
      try { c.auth.onAuthStateChange((event, session) => cb(event, session)); } catch (e) {}
    });
  }

  function displayName(session) {
    if (!session) return '';
    const u = session.user || {};
    return u.name || (userEmail(session) ? userEmail(session).split('@')[0] : '');
  }

  return {
    init, ready, getSession, isAdmin, sendOtp, verifyOtp, signOut, onChange, displayName, userEmail,
    initAdminClient, adminSignOut,
    get instance() { return cloud; },
    get adminInstance() { return adminCloud || cloud; }
  };
})();
