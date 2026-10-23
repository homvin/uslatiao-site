// 扩展设置页：把 域名 / 采集密钥 / 汇率 存进 chrome.storage.sync
(async function () {
  const DEFAULTS = {
    base: 'https://www.uslatiao.com',
    key: '',
    rate: '6.72'
  };
  const $ = id => document.getElementById(id);
  const store = await chrome.storage.sync.get(DEFAULTS);
  $('base').value = store.base || DEFAULTS.base;
  $('key').value = store.key || '';
  $('rate').value = store.rate || DEFAULTS.rate;

  $('save').onclick = async () => {
    const base = ($('base').value || '').trim().replace(/\/+$/, '');
    const key = ($('key').value || '').trim();
    const rate = ($('rate').value || '').trim();
    if (!base || !key) { $('msg').textContent = '域名和采集密钥必填'; $('msg').style.color = '#d9442b'; return; }
    if (!/^\d+(\.\d+)?$/.test(rate) || +rate <= 0) { $('msg').textContent = '汇率须为正数'; $('msg').style.color = '#d9442b'; return; }
    await chrome.storage.sync.set({ base, key, rate });
    $('msg').style.color = '#0f6e56';
    $('msg').textContent = '已保存';
  };
})();
