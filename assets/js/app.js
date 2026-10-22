/* =========================================================================
 * 公共初始化（每个页面都引入）
 * - 加载云 SDK
 * - 挂载共享布局
 * - 根据登录态更新账户入口
 * - 金额格式化
 * ========================================================================= */
window.Money = function (n) {
  const v = Number(n || 0);
  return '$' + v.toFixed(2);
};

window.App = (function () {
  async function refreshAccountUI() {
    const link = document.getElementById('account-link');
    const session = await window.Cloud.getSession();
    if (link) {
      if (session && session.user) {
        link.textContent = 'Hi, ' + window.Cloud.displayName(session);
        link.href = 'account.html';
      } else {
        link.textContent = 'Account';
        link.href = 'account.html';
      }
    }
  }

  function init() {
    // 云 SDK 脚本由页面 <head> 引入（CDN），这里初始化实例
    window.Cloud.init();
    window.Layout.mount();
    refreshAccountUI();

    if (window.Cloud.onChange) {
      window.Cloud.onChange(() => refreshAccountUI());
    }
    document.addEventListener('click', e => {
      if (e.target && e.target.classList && e.target.classList.contains('btn') && e.target.dataset.toast) {
        window.Layout.toast(e.target.dataset.toast);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { refreshAccountUI };
})();
