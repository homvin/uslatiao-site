/* =========================================================================
 * 购物车（localStorage 持久化）
 * ========================================================================= */
window.Store = (function () {
  const KEY = 'uslatiao_cart';
  function get() {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; }
    catch (e) { return []; }
  }
  function save(cart) { localStorage.setItem(KEY, JSON.stringify(cart)); }
  function add(slug, qty = 1, variant = null) {
    const cart = get();
    const vid = variant && (variant.sku || variant.option_label) ? (variant.sku || variant.option_label) : '';
    const key = slug + '::' + vid;
    const i = cart.find(x => x.key === key);
    if (i) i.qty += qty; else cart.push({ key, slug, qty, variant: variant || null });
    save(cart); updateBadge();
  }
  function setQty(key, qty) {
    let cart = get();
    const match = x => x.key === key || (!x.key && x.slug === key);
    if (qty <= 0) cart = cart.filter(x => !match(x));
    else { const i = cart.find(match); if (i) i.qty = qty; }
    save(cart); updateBadge();
  }
  function remove(key) {
    const match = x => x.key === key || (!x.key && x.slug === key);
    save(get().filter(x => !match(x))); updateBadge();
  }
  function clear() { save([]); updateBadge(); }
  function count() { return get().reduce((s, x) => s + x.qty, 0); }
  function updateBadge() {
    const b = document.getElementById('cart-count');
    if (b) b.textContent = count();
  }
  return { get, add, setQty, remove, clear, count, updateBadge };
})();
