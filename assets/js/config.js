/* =========================================================================
 * USLATIAO 自建站 · 全局配置
 * 主人改这一处即可调整品牌名、管理员邮箱、免邮门槛等。
 * CLOUD 段来自云端 publicConfig（仅含前端安全的发布密钥，不含任何私密）。
 * ========================================================================= */
window.APP_CONFIG = {
  // —— 品牌（2026-10-20 主人拍板：HICHEN Asian Market）——
  BRAND: 'HICHEN Asian Market',
  TAGLINE: 'Asian snacks, already stateside.',
  SUBTAGLINE: 'Stocked in the US. Ships in 1 business day.',
  ANNOUNCEMENT: 'FREE SHIPPING OVER $35  ·  SHIPS FROM THE US IN 1 BUSINESS DAY',

  // —— 运营参数 ——
  FREE_SHIP_THRESHOLD: 35,        // 免邮门槛（美元）
  CURRENCY: 'USD',
  SUBSCRIBE_SAVE: 15,             // 订阅省百分比

  // —— 管理员（改成主人真实邮箱；用于后台管理与查看全部订单）——
  // 用这里列出的邮箱注册登录，即为站点管理员。
  ADMIN_EMAILS: ['moeyooo@163.com'],

  // —— 销售税（重要，别随手打开）——
  // 美国经济关联（economic nexus）阈值：多数州 $100,000/年，约 16 个州另有「200 笔交易」触发器。
  // 年流水约 12 万是全国总额，单州远未达标 → 默认不代收，这在美国是合法的。
  // 反之「收了税却没注册没上缴」才是硬违规，比不收税严重得多。
  // 某州逼近阈值并完成注册后，把这里改成 true 即可开始按州税率代收。
  TAX_ENABLED: false,

  // —— 支付占位（先用占位入口，不接真实收款）——
  PAYMENT_LIVE: false,

  // —— 云端 publicConfig（前端安全，可公开）——
  CLOUD: (function () {
    // endpoint 动态取当前域名：自定义域名（www.uslatiao.com，经 Cloudflare Worker 转发）
    // 与源站域名（uslatiao-store.app.workbuddy.host，直连）都能工作；
    // 本地 file:// 预览时 location.origin 为 "null"，回退源站域名。
    var o = (typeof location !== 'undefined' && location.origin) || '';
    var sameOrigin = /^https:\/\//.test(o) && o.indexOf('.') !== -1 && o !== 'null'
      ? o : 'https://uslatiao-store.app.workbuddy.host';
    return {
      endpoint: sameOrigin,
      oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
      publishableKey: 'wbpk_E5UkpYFI7u0l7bJ2yFfhLz_s1kqYI3IdfvwtnXBeTPRWNQIO1vZvg6m'
    };
  })()
};
