/* =========================================================================
 * 注册 / 订阅入口（Signup & Subscribe）— v3
 *
 * 触发时机参考美国 DTC 独立站的通行做法（2026 年主流基准）：
 *   1. 浏览中滚动 40–60%  → 弹窗（主力，邮件列表转化 8–15%）
 *   2. 离开意图 / 停留 30–45 秒 → 弹窗（补充，转化 2–7%）
 *   3. 下单成功后 → 邀请注册（转化最高的时机，见 checkout.html）
 *   4. 页脚常驻订阅条 + 顶栏 Account 入口（长期兜底）
 *
 * v3（2026-10-22）：订阅改为「邮箱验证码双步确认」（double opt-in）。
 *   输邮箱 → 发 6 位验证码 → 输码验证通过 → 才写入 subscribers 名单
 *   并发放 WELCOME10。乱填的邮箱收不到码、进不了库，保证名单全真。
 *   复用站点现有 OTP 通道（Cloud.sendOtp / verifyOtp，与下单后建号一致），
 *   验证通过即顺带建立账号（可查订单）。无 OTP 能力时降级为直接订阅。
 *
 * 共同底线（缺一不可）：
 *   - 单次会话只弹一次
 *   - 关闭后 14–30 天不再打扰
 *   - 已登录 / 已订阅者永不弹
 *   - 移动端用底部抽屉，绝不整屏覆盖（Google intrusive interstitial 惩罚）
 *   - 绝不整页加载即弹（会伤转化并触发 SEO 惩罚）
 * ========================================================================= */
window.Signup = (function () {
  const KEY = 'uslatiao_signup_state';
  const DISMISS_DAYS = 30;          // 关闭后静默天数
  const SCROLL_TRIGGER = 0.45;      // 滚动到 45% 触发
  const DWELL_SECONDS = 35;         // 停留 35 秒触发
  const RESEND_COOLDOWN = 60;       // 重发验证码冷却（秒）
  const CODE = 'WELCOME10';         // 欢迎折扣码

  const state = { shown: false, fired: false, timers: [], listeners: [] };

  function readState() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
  }
  function writeState(o) {
    try { localStorage.setItem(KEY, JSON.stringify(Object.assign(readState(), o))); } catch (e) {}
  }

  // 本次会话是否已弹过（会话内不重复打扰）
  function shownThisSession() {
    try { return sessionStorage.getItem(KEY + '_session') === '1'; } catch (e) { return false; }
  }
  function markSessionShown() {
    try { sessionStorage.setItem(KEY + '_session', '1'); } catch (e) {}
  }

  // 关闭后 N 天内不再弹
  function dismissedRecently() {
    const s = readState();
    if (!s.dismissedAt) return false;
    const days = (Date.now() - s.dismissedAt) / 86400000;
    return days < DISMISS_DAYS;
  }

  function isSubscribed() {
    try { return localStorage.getItem(KEY + '_subscribed') === '1'; } catch (e) { return false; }
  }
  function markSubscribed() {
    try { localStorage.setItem(KEY + '_subscribed', '1'); } catch (e) {}
  }

  // 页面级排除：这些页面上不该弹注册窗
  function excludedPage() {
    const p = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
    return p === 'checkout.html' || p === 'hq-8xk29a.html' || p === 'admin.html';
  }

  function mobile() {
    return (window.matchMedia && window.matchMedia('(max-width:900px)').matches) || window.innerWidth <= 900;
  }

  /* ---------------- 共用：两步验证订阅流程 ----------------
   * 阶段 email：输邮箱 → Cloud.sendOtp 发码 → 切到阶段 code
   * 阶段 code：输码 → Cloud.verifyOtp → 通过才 Data.subscribe 入名单 + onSuccess
   * 表单内容随阶段重绘，事件统一绑在 form 的 submit 上（phase 分支），
   * 避免动态绑定/解绑的内存泄漏与监听丢失。
   * -------------------------------------------------------- */
  function attachFlow(opts) {
    const form = opts.form;
    const msgEl = opts.msgEl;
    const okCls = opts.okCls || 'sg-msg ok';
    const errCls = opts.errCls || 'sg-msg err';
    let phase = 'email';
    let pending = null;        // { email, verificationId, isExistingUser }
    let resendTimer = null;

    function setMsg(text, cls) { msgEl.textContent = text; msgEl.className = cls; }
    function mainBtn() { return form.querySelector('.sg-go'); }
    function mailInput() { return form.querySelector('.sg-mail'); }
    function busy(label) {
      const b = mainBtn();
      if (b) { b.disabled = true; b.dataset.label = b.textContent; b.textContent = label; }
    }
    function unbusy() {
      const b = mainBtn();
      if (b) { b.disabled = false; b.textContent = b.dataset.label || (phase === 'code' ? 'Verify' : 'Join'); }
    }
    function validMail(m) { return m && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m); }

    function stopResendTimer() {
      if (resendTimer) { clearInterval(resendTimer); resendTimer = null; }
    }

    function renderCodeUI() {
      form.innerHTML =
        '<input type="text" class="' + opts.inputClass + ' sg-code" inputmode="numeric" maxlength="8" ' +
        'placeholder="6-digit code" autocomplete="one-time-code" aria-label="Verification code">' +
        '<button type="submit" class="btn red ' + opts.btnClass + ' sg-go">Verify</button>' +
        '<span class="sg-links">' +
        '<button type="button" class="sg-link sg-resend">Resend code</button>' +
        '<button type="button" class="sg-link sg-change">Use a different email</button>' +
        '</span>';

      form.querySelector('.sg-resend').addEventListener('click', async e => {
        const b = e.currentTarget;
        if (b.disabled) return;
        b.disabled = true;
        try {
          await window.Cloud.sendOtp(pending.email);
          setMsg('Code resent to ' + pending.email + '.', okCls);
        } catch (err) {
          setMsg('Could not resend right now. Try again in a minute.', errCls);
          b.disabled = false;
          return;
        }
        let n = RESEND_COOLDOWN;
        b.textContent = 'Resend in ' + n + 's';
        resendTimer = setInterval(() => {
          n--;
          if (n <= 0) { stopResendTimer(); b.disabled = false; b.textContent = 'Resend code'; }
          else b.textContent = 'Resend in ' + n + 's';
        }, 1000);
      });

      form.querySelector('.sg-change').addEventListener('click', () => {
        stopResendTimer();
        phase = 'email';
        pending = null;
        form.innerHTML = opts.emailHTML();
        setMsg('', '');
        const inp = mailInput();
        if (inp && !mobile()) inp.focus();
      });

      const c = form.querySelector('.sg-code');
      if (c && !mobile()) setTimeout(() => { try { c.focus(); } catch (e) {} }, 100);
    }

    async function doVerify() {
      const codeEl = form.querySelector('.sg-code');
      const token = ((codeEl && codeEl.value) || '').trim();
      if (!token) { setMsg('Enter the 6-digit code from your email.', errCls); if (codeEl) codeEl.focus(); return; }
      busy('Verifying…');
      try {
        const r = await window.Cloud.verifyOtp({
          email: pending.email,
          verificationId: pending.verificationId,
          isExistingUser: pending.isExistingUser,
          token: token
        });
        if (r.error) {
          setMsg((r.error && r.error.message) || 'That code is not valid. Try again.', errCls);
          unbusy();
          return;
        }
        // 验证通过 → 才进订阅名单（double opt-in 关键一步）
        const sr = await window.Data.subscribe(pending.email, opts.source, opts.meta);
        if (!sr.ok) { setMsg(sr.error || 'Please try again.', errCls); unbusy(); return; }
        markSubscribed();
        stopResendTimer();
        opts.onSuccess(pending.email);
      } catch (err) {
        setMsg('Could not verify right now. Please try again.', errCls);
        unbusy();
      }
    }

    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (phase === 'code') { doVerify(); return; }

      const mail = ((mailInput() && mailInput().value) || '').trim().toLowerCase();
      if (!validMail(mail)) {
        setMsg('Please enter a valid email address.', errCls);
        const i = mailInput(); if (i) i.focus();
        return;
      }
      busy('Sending…');

      // 兜底：无 OTP 能力（本地预览/无 Cloud）→ 保持旧的单步订阅
      if (!(window.Cloud && window.Cloud.sendOtp)) {
        try {
          const sr = await window.Data.subscribe(mail, opts.source, opts.meta);
          if (!sr.ok) { setMsg(sr.error || 'Please try again.', errCls); unbusy(); return; }
          markSubscribed();
          opts.onSuccess(mail);
        } catch (err) {
          setMsg('Could not subscribe right now.', errCls);
          unbusy();
        }
        return;
      }

      try {
        const { data, error } = await window.Cloud.sendOtp(mail);
        if (error || !data) {
          setMsg((error && error.message) || 'Could not send the code. Please try again.', errCls);
          unbusy();
          return;
        }
        pending = { email: mail, verificationId: data.verificationId, isExistingUser: data.isExistingUser };
        phase = 'code';
        renderCodeUI();
        setMsg('We sent a 6-digit code to ' + mail + '. Enter it below to get your welcome code.', okCls);
      } catch (err) {
        setMsg('Could not subscribe right now. Please try again.', errCls);
        unbusy();
      }
    });
  }

  /* ---------------- 弹窗 HTML ---------------- */
  function popupEmailHTML() {
    return '<input type="email" class="sg-input sg-mail" placeholder="you@example.com" ' +
           'autocomplete="email" aria-label="Email address" required>' +
           '<button type="submit" class="btn red sg-submit sg-go">Send my code</button>';
  }

  function popupHTML() {
    return `
    <div class="sg-mask" id="sg-mask" hidden>
      <div class="sg-box" role="dialog" aria-modal="true" aria-labelledby="sg-title">
        <button class="sg-close" id="sg-close" aria-label="Close">&times;</button>
        <div class="sg-gift" aria-hidden="true">
          <span class="sg-gift-pct">10%</span>
          <span class="sg-gift-sub">OFF</span>
        </div>
        <h3 id="sg-title" class="sg-title">Get 10% off your first order</h3>
        <p class="sg-sub">Join the list for new flavors, restock alerts and a one-time code for your first order.</p>
        <form class="sg-form" id="sg-form" novalidate>${popupEmailHTML()}</form>
        <p class="sg-msg" id="sg-msg" role="status" aria-live="polite"></p>
        <p class="sg-fine">One email, no spam. Unsubscribe anytime.</p>
      </div>
    </div>`;
  }

  /* ---------------- 挂载弹窗 ---------------- */
  let mounted = false;
  function mountPopup() {
    if (mounted) return;
    mounted = true;
    const wrap = document.createElement('div');
    wrap.innerHTML = popupHTML();
    document.body.appendChild(wrap.firstElementChild);

    const mask = document.getElementById('sg-mask');
    const msgEl = document.getElementById('sg-msg');
    const form = document.getElementById('sg-form');

    const close = () => {
      mask.hidden = true;
      writeState({ dismissedAt: Date.now() });
    };
    document.getElementById('sg-close').addEventListener('click', close);
    // 点击遮罩（弹窗外围）关闭；点弹窗本体不关
    mask.addEventListener('click', e => { if (e.target === mask) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !mask.hidden) close(); });

    attachFlow({
      form: form,
      source: 'popup',
      meta: location.pathname,
      msgEl: msgEl,
      okCls: 'sg-msg ok',
      errCls: 'sg-msg err',
      inputClass: 'sg-input',
      btnClass: 'sg-submit',
      emailHTML: popupEmailHTML,
      onSuccess: () => {
        mask.hidden = true;
        window.Layout.toast('Welcome! Your code is ' + CODE);
        // 存下码，结算页自动填
        try { sessionStorage.setItem('uslatiao_welcome_code', CODE); } catch (e) {}
      }
    });
  }

  function canShow() {
    if (state.fired || state.shown) return false;
    if (shownThisSession()) return false;
    if (dismissedRecently()) return false;
    if (isSubscribed()) return false;
    if (excludedPage()) return false;
    return true;
  }

  function show() {
    if (!canShow()) return;
    state.fired = true;
    mountPopup();
    const mask = document.getElementById('sg-mask');
    if (!mask) return;
    mask.hidden = false;
    state.shown = true;
    markSessionShown();
    // 记录来源，供后台分析哪个入口转化好
    try { writeState({ lastShownAt: Date.now(), lastSource: 'scroll_or_dwell' }); } catch (e) {}
    const el = document.querySelector('#sg-form .sg-mail');
    if (el && !mobile()) setTimeout(() => el.focus(), 120);
  }

  /* ---------------- 触发器 ---------------- */
  function onScroll() {
    const doc = document.documentElement;
    const max = (doc.scrollHeight - window.innerHeight);
    if (max <= 0) return;
    const pct = (window.scrollY || doc.scrollTop) / max;
    if (pct >= SCROLL_TRIGGER) {
      show();
      cleanup();
    }
  }

  function onExitIntent(e) {
    // 鼠标移向浏览器顶部/关闭按钮方向 → 离开意图（桌面端信号）
    if (mobile()) return;
    if (e.clientY <= 0) {
      show();
      cleanup();
    }
  }

  function cleanup() {
    window.removeEventListener('scroll', onScroll);
    document.removeEventListener('mouseleave', onExitIntent);
    state.timers.forEach(clearTimeout);
    state.timers = [];
  }

  function start() {
    if (excludedPage()) return;
    if (!canShow()) return;
    // 已登录用户不打扰（他们已有账号，订单可查）
    if (window.Cloud && window.Cloud.getSession) {
      window.Cloud.getSession().then(sess => {
        if (sess && sess.user) return;
        arm();
      }).catch(() => arm());
    } else {
      arm();
    }
  }

  function arm() {
    if (!canShow()) return;
    // 主力：滚动 45%
    window.addEventListener('scroll', onScroll, { passive: true });
    // 补充：桌面端离开意图
    document.addEventListener('mouseleave', onExitIntent);
    // 补充：停留 35 秒
    state.timers.push(setTimeout(() => { show(); cleanup(); }, DWELL_SECONDS * 1000));
  }

  /* ---------------- 页脚常驻订阅条 ---------------- */
  function footerEmailHTML() {
    return '<input type="email" class="sg-foot-input sg-mail" placeholder="you@example.com" ' +
           'autocomplete="email" aria-label="Email address">' +
           '<button type="submit" class="btn red sg-foot-btn sg-go">Join</button>';
  }

  function footerBarHTML() {
    return `
    <div class="sg-foot" id="sg-foot">
      <div class="sg-foot-txt">
        <strong>Get 10% off your first order</strong>
        <span>New flavors, restock alerts, zero spam.</span>
      </div>
      <form class="sg-foot-form" id="sg-foot-form" novalidate>${footerEmailHTML()}</form>
      <p class="sg-foot-msg" id="sg-foot-msg" role="status" aria-live="polite"></p>
    </div>`;
  }

  function mountFooterBar(host) {
    if (!host) return;
    if (document.getElementById('sg-foot')) return;
    // 结账页不加订阅条：正在付钱的页面不该有营销干扰
    if (excludedPage()) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = footerBarHTML();
    host.appendChild(wrap.firstElementChild);

    const form = document.getElementById('sg-foot-form');
    const msgEl = document.getElementById('sg-foot-msg');

    attachFlow({
      form: form,
      source: 'footer',
      meta: location.pathname,
      msgEl: msgEl,
      okCls: 'sg-foot-msg ok',
      errCls: 'sg-foot-msg err',
      inputClass: 'sg-foot-input',
      btnClass: 'sg-foot-btn',
      emailHTML: footerEmailHTML,
      onSuccess: () => {
        msgEl.textContent = 'Welcome! Use code ' + CODE + ' at checkout.';
        msgEl.className = 'sg-foot-msg ok';
        form.innerHTML = footerEmailHTML();
        try { sessionStorage.setItem('uslatiao_welcome_code', CODE); } catch (er) {}
      }
    });
  }

  return { start, show, mountFooterBar, popupHTML, attachFlow, CODE, DISMISS_DAYS, SCROLL_TRIGGER, DWELL_SECONDS };
})();
