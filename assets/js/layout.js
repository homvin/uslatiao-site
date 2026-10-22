/* =========================================================================
 * 共享布局：顶栏 / 页脚 / Toast / 移动端菜单
 * 每个页面只放 <div id="site-header"></div> 与 <div id="site-footer"></div>，
 * 由 Layout.mount() 注入，保持全站一致、改一处即可。
 * ========================================================================= */
window.Layout = (function () {
  const C = window.APP_CONFIG;

  function headerHTML() {
    return `
    <div class="announce">${C.ANNOUNCEMENT}</div>
    <div class="topbar">
      <div class="container">
        <a class="brand" href="index.html">${C.BRAND}<small>US · Ships in 1 business day</small></a>
        <form class="topsearch" id="topsearch" action="shop.html" method="get" role="search">
          <span class="ic"></span>
          <input type="search" name="q" id="topsearch-input" placeholder="Search snacks, flavors, brands…" aria-label="Search snacks" autocomplete="off">
        </form>
        <nav class="nav" id="nav">
          <a href="shop.html" data-nav="shop">Shop All</a>
          <a href="shop.html?cat=spicy-strips" data-nav="spicy-strips">Spicy Strips</a>
          <a href="shop.html?cat=chocolate-bites" data-nav="chocolate-bites">Chocolate Bites</a>
          <a href="shop.html?cat=variety-packs" data-nav="variety-packs">Variety Packs</a>
          <a href="story.html" data-nav="story">Our Story</a>
          <a href="learn.html" data-nav="learn">Learn</a>
          <a href="faq.html" data-nav="faq">FAQ</a>
        </nav>
        <span class="spacer"></span>
        <a class="iconlink" id="account-link" href="account.html">Account</a>
        <a class="iconlink" href="cart.html">Cart <span class="cart-count" id="cart-count">0</span></a>
        <button class="hamburger" id="hamburger" aria-label="Menu">&#9776;</button>
      </div>
    </div>`;
  }

  function footerHTML() {
    return `
    <footer>
      <div class="container">
        <div id="foot-subscribe"></div>
        <div class="cols">
          <div>
            <h5>Shop</h5>
            <a href="shop.html">All Snacks</a>
            <a href="shop.html?cat=spicy-strips">Spicy Strips</a>
            <a href="shop.html?cat=chocolate-bites">Chocolate Bites</a>
            <a href="shop.html?cat=variety-packs">Variety Packs</a>
            <a href="shop.html?cat=bundles">Bundles</a>
          </div>
          <div>
            <h5>Company</h5>
            <a href="story.html">Our Story</a>
            <a href="learn.html">Learn &amp; Guides</a>
            <a href="https://www.youtube.com/@homvin666" target="_blank" rel="noopener">YouTube</a>
            <a href="track.html">Track Order</a>
            <a href="account.html">My Account</a>
          </div>
          <div>
            <h5>Support</h5>
            <a href="faq.html">FAQ</a>
            <a href="shipping.html">Shipping &amp; Returns</a>
            <a href="contact.html">Contact Us</a>
          </div>
          <div>
            <h5>Legal</h5>
            <a href="shipping.html">Shipping Policy</a>
            <a href="faq.html">Terms</a>
            <a href="faq.html">Privacy</a>
          </div>
        </div>
        <div class="bottom">
          <span>&copy; 2026 ${C.BRAND}. All rights reserved.</span>
          <span>${C.TAGLINE}</span>
        </div>
      </div>
    </footer>`;
  }

  // 移动端底部标签栏（仅 <=900px 显示，桌面隐藏）：首页 / 分类 / 购物车 / 账户
  function tabbarHTML() {
    const icon = {
      home: '<span class="ti">🏠</span>',
      shop: '<span class="ti">🛍️</span>',
      cart: '<span class="ti">🛒</span>',
      account: '<span class="ti">👤</span>'
    };
    const here = location.pathname.split('/').pop() || 'index.html';
    const isActive = p => {
      if (p === 'index.html') return here === 'index.html';
      if (p === 'shop.html') return here === 'shop.html' || here === 'product.html';
      if (p === 'account.html') return here === 'account.html';
      return false;
    };
    const item = (href, p, label) =>
      `<a class="tbitem ${isActive(p) ? 'on' : ''}" href="${href}">${icon[p]}<span>${label}</span>${p === 'cart' ? `<i class="tbbadge" id="tab-cart-count">0</i>` : ''}</a>`;
    return `
    <nav class="tabbar" id="tabbar">
      ${item('index.html', 'home', 'Home')}
      ${item('shop.html', 'shop', 'Shop')}
      ${item('cart.html', 'cart', 'Cart')}
      ${item('account.html', 'account', 'Account')}
    </nav>`;
  }

  // —— SEO/GEO 头部注入（全站一处，所有页面共用）——
  // 1) Organization 结构化数据（JSON-LD）—— 帮助 Google / GPT / Perplexity 等识别品牌实体
  // 2) 子域 noindex：当请求来自 app.workbuddy.host 时，给页面打 noindex，
  //    让搜索引擎只收录主域 www.uslatiao.com（消除双域重复内容稀释）
  function injectSeoHead() {
    const head = document.head;
    if (!head) return;

    // —— Organization JSON-LD（只注入一次）——
    if (!document.getElementById('ld-organization')) {
      const org = {
        '@context': 'https://schema.org',
        '@type': 'Organization',
        name: 'HICHEN Asian Market',
        url: 'https://www.uslatiao.com',
        description: 'Asian snacks stocked in the US and shipped in 1 business day — spicy strips, chocolate bites, variety packs and bundles for chili lovers.',
        address: {
          '@type': 'PostalAddress',
          addressCountry: 'US'
        },
        // sameAs：把品牌实体与主人的 YouTube 频道绑定（AI 建立「同一实体」的正统信号）
        sameAs: ['https://www.youtube.com/@homvin666']
      };
      const s = document.createElement('script');
      s.type = 'application/ld+json';
      s.id = 'ld-organization';
      s.textContent = JSON.stringify(org);
      head.appendChild(s);
    }

    // —— WebSite 结构化数据（站名 + 站内搜索入口 + 指向 Organization）——
    // SearchAction 的 target 与 shop.html 的 ?q= 搜索参数一致；alternateName 挂域名品牌名 USLATIAO，
    // 让 Google / GPT / Perplexity 把「HICHEN Asian Market」与「uslatiao.com」认成同一个实体
    if (!document.getElementById('ld-website')) {
      const site = {
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: 'HICHEN Asian Market',
        alternateName: 'USLATIAO',
        url: 'https://www.uslatiao.com',
        description: 'Asian snacks stocked in the US and shipped in 1 business day — spicy strips, chocolate bites, variety packs and bundles for chili lovers.',
        inLanguage: 'en-US',
        publisher: { '@type': 'Organization', name: 'HICHEN Asian Market', url: 'https://www.uslatiao.com' },
        potentialAction: {
          '@type': 'SearchAction',
          target: 'https://www.uslatiao.com/shop.html?q={search_term_string}',
          'query-input': 'required name=search_term_string'
        }
      };
      const s = document.createElement('script');
      s.type = 'application/ld+json';
      s.id = 'ld-website';
      s.textContent = JSON.stringify(site);
      head.appendChild(s);
    }

    // —— 子域 noindex（仅对 app.workbuddy.host 生效；主域不受影响）——
    if (location.hostname.indexOf('app.workbuddy.host') !== -1) {
      let m = document.querySelector('meta[name="robots"]');
      if (!m) {
        m = document.createElement('meta');
        m.name = 'robots';
        head.appendChild(m);
      }
      m.content = 'noindex,follow';
    }
  }

  let toastEl = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 2400);
  }

  function mount() {
    injectSeoHead();
    const h = document.getElementById('site-header');
    if (h) h.innerHTML = headerHTML();
    const f = document.getElementById('site-footer');
    if (f) f.innerHTML = footerHTML();

    // 移动端菜单
    const ham = document.getElementById('hamburger');
    const nav = document.getElementById('nav');
    if (ham && nav) {
      ham.addEventListener('click', () => nav.classList.toggle('open'));
      nav.addEventListener('click', e => { if (e.target.tagName === 'A') nav.classList.remove('open'); });
    }

    // 当前导航高亮（带 ?q= 搜索时按 Shop All 高亮）
    const here = location.pathname.split('/').pop() || 'index.html';
    const cat = new URLSearchParams(location.search).get('cat');
    document.querySelectorAll('#nav a').forEach(a => {
      const nav = a.getAttribute('data-nav');
      if (here === 'shop.html' && nav === (cat || 'shop')) a.classList.add('active');
    });

    if (window.Store) window.Store.updateBadge();

    // 注册入口：页脚常驻订阅条 + 浏览中弹窗（时机参考美国 DTC 通行做法）
    if (window.Signup) {
      try {
        window.Signup.mountFooterBar(document.getElementById('foot-subscribe'));
        window.Signup.start();
      } catch (e) { /* 注册入口失败不能拖垮页面 */ }
    }

    // 移动端底部标签栏
    if (!document.getElementById('tabbar')) {
      const wrap = document.createElement('div');
      wrap.innerHTML = tabbarHTML();
      document.body.appendChild(wrap.firstElementChild);
    }
    const tabCart = document.getElementById('tab-cart-count');
    if (tabCart && window.Store && (window.Store.count || window.Store.get)) {
      const n = (window.Store.count ? window.Store.count() : (window.Store.get() || []).reduce((s, x) => s + (x.qty || 0), 0));
      tabCart.textContent = n;
    }
    // 购物车数量变化时同步到底部标签栏角标
    if (window.Store && typeof window.Store.updateBadge === 'function') {
      const orig = window.Store.updateBadge;
      window.Store.updateBadge = function () {
        orig();
        const tb = document.getElementById('tab-cart-count');
        if (tb && window.Store) tb.textContent = (window.Store.count ? window.Store.count() : 0);
      };
    }
  }

  return { mount, toast, headerHTML, footerHTML };
})();
