/* =========================================================================
 * USLATIAO 新店门童（Workers 静态资产 + 同源动态转发）
 * -------------------------------------------------------------------------
 * 架构（2026-10-22 迁移）：
 *   - 静态页面/资源：Workers Assets 直接吐（永不休眠，不再有 530）
 *   - 动态请求：本 Worker 同源转发到云沙箱（/.cloud/*、/media/*、/api/stripe/*）
 *     → 前端 config.js 的 endpoint=同源 继续成立，零前端改动
 *   - Stripe 收单逻辑原样自旧 Worker 搬入；密钥存本项目环境变量
 *     （Settings → Variables and Secrets：STRIPE_SECRET_KEY 等）
 *     未配密钥时 /api/stripe/config 返回 not_configured，前端优雅降级预览模式。
 * ========================================================================= */

const ORIGIN_HOST = 'uslatiao-store.app.workbuddy.host';
const ORIGIN = 'https://' + ORIGIN_HOST;
const STRIPE_API = 'https://api.stripe.com/v1';

const WB_PK_DEFAULT = 'wbpk_E5UkpYFI7u0l7bJ2yFfhLz_s1kqYI3IdfvwtnXBeTPRWNQIO1vZvg6m';

// 州销售税率（必须与 checkout.html 里的 TAX_RATES 完全一致）
const TAX_RATES = { TX: 0.0625, CA: 0.0725, NY: 0.08875, FL: 0.06, WA: 0.065, IL: 0.0625, PA: 0.06, OH: 0.0575, GA: 0.04, NC: 0.0475 };

function corsHeaders(requestOrigin) {
  const h = new Headers();
  h.set('Access-Control-Allow-Origin', requestOrigin || '*');
  h.set('Access-Control-Allow-Credentials', 'true');
  h.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  h.set('Access-Control-Allow-Headers',
    'content-type,authorization,apikey,x-wb-webapp-access-key,accept,accept-profile,content-profile,prefer,x-client-info,x-retry-count');
  h.set('Access-Control-Expose-Headers', 'content-range,content-profile,x-retry-count');
  h.set('Access-Control-Max-Age', '86400');
  return h;
}

function json(obj, status, requestOrigin) {
  const h = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  if (requestOrigin) corsHeaders(requestOrigin).forEach((v, k) => { h[k] = v; });
  return new Response(JSON.stringify(obj), { status: status || 200, headers: h });
}

/* ---------- 商品价格基准：源站 products.json 为权威价（缓存 5 分钟） ---------- */
let PRICE_CACHE = { at: 0, map: null };
async function priceMap() {
  const now = Date.now();
  if (PRICE_CACHE.map && now - PRICE_CACHE.at < 5 * 60 * 1000) return PRICE_CACHE.map;
  try {
    const r = await fetch(ORIGIN + '/products.json');
    if (!r.ok) return PRICE_CACHE.map || {};
    const list = await r.json();
    const map = {};
    (Array.isArray(list) ? list : []).forEach(p => {
      const v = parseFloat(p && p.price);
      if (p && p.slug && v > 0) map[p.slug] = v;
      (Array.isArray(p && p.variants) ? p.variants : []).forEach(va => {
        const vv = parseFloat(va && va.price);
        if (va && va.sku && vv > 0) map[p.slug + '::' + String(va.sku)] = vv;
      });
    });
    PRICE_CACHE = { at: now, map };
    return map;
  } catch (e) {
    return PRICE_CACHE.map || {};
  }
}

/* ---------- Stripe REST 封装 ---------- */
function buildForm(obj, prefix, out) {
  out = out || [];
  Object.keys(obj).forEach(k => {
    const v = obj[k];
    if (v === undefined || v === null || v === '') return;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === 'object') buildForm(item, `${key}[${i}]`, out);
        else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`);
      });
    } else if (typeof v === 'object') {
      buildForm(v, key, out);
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
    }
  });
  return out.join('&');
}

async function stripeRequest(env, path, method, formObj) {
  let body;
  if (formObj) {
    body = buildForm(formObj).replace(/%7BCHECKOUT_SESSION_ID%7D/gi, '{CHECKOUT_SESSION_ID}');
  }
  const res = await fetch(STRIPE_API + path, {
    method: method || 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': '2024-06-20'
    },
    body
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || ('stripe_http_' + res.status);
    const err = new Error(msg);
    err.status = res.status;
    err.detail = data && data.error;
    throw err;
  }
  return data;
}

/* ---------- POST /api/stripe/checkout ---------- */
async function handleCheckout(request, env, url, reqOrigin) {
  if (!env.STRIPE_SECRET_KEY) {
    return json({ ok: false, reason: 'not_configured' }, 200, reqOrigin);
  }

  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'bad_json' }, 400, reqOrigin); }

  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (!rawItems.length) return json({ ok: false, error: 'empty_cart' }, 400, reqOrigin);
  if (rawItems.length > 40) return json({ ok: false, error: 'too_many_items' }, 400, reqOrigin);

  const prices = await priceMap();

  const items = [];
  let rewritten = false;
  for (const it of rawItems) {
    const slug = String(it.slug || '').slice(0, 120);
    const vsku = String(it.variant_sku || '').slice(0, 120);
    const qty = Math.max(1, Math.min(99, parseInt(it.qty, 10) || 1));
    const claimed = parseFloat(it.price);
    const auth = vsku ? prices[slug + '::' + vsku] : prices[slug];
    let price;
    if (auth !== undefined && auth > 0) {
      price = auth;
      if (!(claimed > 0) || Math.abs(claimed - auth) > 0.005) rewritten = true;
    } else {
      if (!(claimed > 0)) return json({ ok: false, error: 'bad_price', slug }, 400, reqOrigin);
      price = claimed;
    }
    if (price > 2000) return json({ ok: false, error: 'price_too_high', slug }, 400, reqOrigin);
    const vlabel = String(it.variant_label || '').slice(0, 80);
    items.push({
      slug, name: String(it.name || slug).slice(0, 150), price, qty,
      variant_sku: vsku || null, variant_label: vlabel || null
    });
  }

  const round2 = (n) => Math.round(n * 100) / 100;
  const subtotal = round2(items.reduce((s, l) => s + l.price * l.qty, 0));
  let discount = round2(Math.max(0, Math.min(parseFloat(body.discount_amount) || 0, subtotal)));
  const discountCode = body.discount_code ? String(body.discount_code).slice(0, 40) : '';
  let shipping = round2(Math.max(0, Math.min(parseFloat(body.shipping) || 0, 200)));

  const TAX_ON = String(env.TAX_ENABLED || '').toLowerCase() === 'true';
  const state = String(body.state || '').toUpperCase().slice(0, 2);
  const rate = TAX_ON ? (TAX_RATES[state] || 0) : 0;
  const tax = round2(Math.max(0, subtotal - discount) * rate);

  const total = round2(subtotal - discount + shipping + tax);
  if (!(total > 0)) return json({ ok: false, error: 'zero_total', message: 'Order total is $0.00 — nothing to charge.' }, 400, reqOrigin);

  const orderId = String(body.order_id || '').slice(0, 64);
  const email = String(body.email || '').slice(0, 200);
  const siteUrl = (env.SITE_URL || 'https://www.uslatiao.com').replace(/\/+$/, '');

  const scale = subtotal > 0 ? (subtotal - discount) / subtotal : 1;
  const lineItems = [];
  const centsEach = items.map(l => Math.round(l.price * l.qty * scale * 100));
  const targetCents = Math.round((subtotal - discount) * 100);
  const drift = targetCents - centsEach.reduce((a, b) => a + b, 0);
  if (drift !== 0 && centsEach.length) centsEach[centsEach.length - 1] += drift;

  items.forEach((l, i) => {
    const cents = Math.max(0, centsEach[i]);
    if (cents <= 0) return;
    const displayName = `${l.qty}× ${l.name}${l.variant_label ? ' (' + l.variant_label + ')' : (l.variant_sku ? ' (' + l.variant_sku + ')' : '')}`.slice(0, 250);
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: { name: displayName },
        unit_amount: cents
      },
      quantity: 1
    });
  });
  if (shipping > 0) {
    lineItems.push({ price_data: { currency: 'usd', product_data: { name: 'Shipping' }, unit_amount: Math.round(shipping * 100) }, quantity: 1 });
  }
  if (tax > 0) {
    lineItems.push({ price_data: { currency: 'usd', product_data: { name: `Estimated sales tax (${state})` }, unit_amount: Math.round(tax * 100) }, quantity: 1 });
  }

  const form = {
    mode: 'payment',
    success_url: `${siteUrl}/checkout.html?paid=1&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteUrl}/checkout.html?canceled=1`,
    customer_email: email || undefined,
    client_reference_id: orderId || undefined,
    billing_address_collection: 'auto',
    phone_number_collection: { enabled: 'true' },
    line_items: lineItems,
    metadata: {
      order_id: orderId,
      discount_code: discountCode,
      subtotal: String(subtotal),
      discount: String(discount),
      shipping: String(shipping),
      tax: String(tax),
      total: String(total),
      ship_state: state,
      price_rewritten: rewritten ? 'yes' : 'no'
    },
    payment_intent_data: { metadata: { order_id: orderId } }
  };

  let session;
  try {
    session = await stripeRequest(env, '/checkout/sessions', 'POST', form);
  } catch (e) {
    return json({ ok: false, error: 'stripe_error', message: e.message, detail: e.detail || null }, 502, reqOrigin);
  }

  return json({
    ok: true,
    id: session.id,
    url: session.url,
    total, subtotal, discount, shipping, tax
  }, 200, reqOrigin);
}

/* ---------- GET /api/stripe/session ---------- */
async function handleSessionStatus(request, env, url, reqOrigin) {
  if (!env.STRIPE_SECRET_KEY) return json({ ok: false, reason: 'not_configured' }, 200, reqOrigin);
  const id = String(url.searchParams.get('id') || '');
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return json({ ok: false, error: 'bad_id' }, 400, reqOrigin);

  let s;
  try {
    s = await stripeRequest(env, `/checkout/sessions/${encodeURIComponent(id)}`, 'GET');
  } catch (e) {
    return json({ ok: false, error: 'stripe_error', message: e.message }, 502, reqOrigin);
  }

  return json({
    ok: true,
    paid: s.payment_status === 'paid' || s.status === 'complete',
    payment_status: s.payment_status,
    status: s.status,
    amount_total: (s.amount_total || 0) / 100,
    currency: s.currency,
    email: (s.customer_details && s.customer_details.email) || s.customer_email || '',
    phone: (s.customer_details && s.customer_details.phone) || '',
    ship_name: (s.customer_details && s.customer_details.address && s.customer_details.address.name) || '',
    ship_addr: (s.customer_details && s.customer_details.address && s.customer_details.address.line1) || '',
    ship_city: (s.customer_details && s.customer_details.address && s.customer_details.address.city) || '',
    ship_state: (s.customer_details && s.customer_details.address && s.customer_details.address.state) || '',
    ship_zip: (s.customer_details && s.customer_details.address && s.customer_details.address.postal_code) || '',
    order_id: (s.metadata && s.metadata.order_id) || s.client_reference_id || '',
    metadata: s.metadata || {}
  }, 200, reqOrigin);
}

/* ---------- POST /api/stripe/webhook ---------- */
function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyStripeSignature(raw, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = {};
  sigHeader.split(',').forEach(kv => {
    const i = kv.indexOf('=');
    if (i < 0) return;
    const k = kv.slice(0, i).trim();
    const v = kv.slice(i + 1).trim();
    if (k === 'v1') { (parts.v1 = parts.v1 || []).push(v); }
    else parts[k] = v;
  });
  const t = parseInt(parts.t, 10);
  if (!t || !parts.v1 || !parts.v1.length) return false;
  if (Math.abs(Date.now() / 1000 - t) > 300) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${raw}`));
  const hex = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');
  return parts.v1.some(v => timingSafeEqualHex(v, hex));
}

async function handleWebhook(request, env, reqOrigin) {
  const raw = await request.text();

  if (env.STRIPE_WEBHOOK_SECRET) {
    const ok = await verifyStripeSignature(raw, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET);
    if (!ok) return json({ ok: false, error: 'invalid_signature' }, 400, reqOrigin);
  }

  let event;
  try { event = JSON.parse(raw); } catch (e) { return json({ ok: false, error: 'bad_json' }, 400, reqOrigin); }

  const type = event.type || '';
  const obj = (event.data && event.data.object) || {};

  if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') {
    const orderId = (obj.metadata && obj.metadata.order_id) || obj.client_reference_id || '';
    const paid = obj.payment_status === 'paid';

    if (env.CLOUD_SERVICE_KEY && orderId && paid) {
      try {
        await fetch(`${ORIGIN}/.cloud/database/rest/orders?id=eq.${encodeURIComponent(orderId)}`, {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            'apikey': env.CLOUD_SERVICE_KEY,
            'Authorization': 'Bearer ' + env.CLOUD_SERVICE_KEY,
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({
            status: 'paid',
            payment_status: 'paid',
            payment_provider: 'stripe',
            payment_ref: obj.payment_intent || obj.id,
            paid_at: new Date().toISOString()
          })
        });
      } catch (e) { /* webhook 失败由 Stripe 自动重试 */ }
    }
  }

  return json({ received: true }, 200, reqOrigin);
}

/* ---------- 图片图床：/media/<uuid> 公开读图 ---------- */
async function mediaFetchRow(env, id) {
  const pk = env.WB_PK || WB_PK_DEFAULT;
  const u = `${ORIGIN}/.cloud/database/rest/media?id=eq.${encodeURIComponent(id)}&select=data,content_type`;
  const res = await fetch(u, { headers: { 'x-wb-webapp-access-key': pk } });
  if (!res.ok) throw new Error('media_db_' + res.status);
  const rows = await res.json().catch(() => []);
  return rows && rows[0];
}

async function handleMediaGet(request, env, url, reqOrigin) {
  const id = url.pathname.replace(/^\/media\//, '').replace(/\/+$/, '');
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
    return new Response('bad media id', { status: 400 });
  }
  let row;
  try {
    row = await mediaFetchRow(env, id);
  } catch (e) {
    return new Response('media read failed: ' + e.message, { status: 502 });
  }
  if (!row || !row.data) return new Response('media not found', { status: 404 });
  const bytes = Uint8Array.from(atob(row.data), c => c.charCodeAt(0));
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': row.content_type || 'image/jpeg',
      'cache-control': 'public, max-age=31536000, immutable',
      'access-control-allow-origin': '*'
    }
  });
}

/* =========================================================================
 * 主入口
 * ========================================================================= */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const reqOrigin = request.headers.get('Origin') || url.origin;
    const dynamic = url.pathname.startsWith('/.cloud/');

    // —— 图片读取 ——
    if (url.pathname.startsWith('/media/')) {
      if (request.method === 'GET' || request.method === 'HEAD') {
        return await handleMediaGet(request, env, url, reqOrigin);
      }
      return new Response(null, { status: 405 });
    }

    // —— Stripe 服务端接口 ——
    if (url.pathname.startsWith('/api/stripe/')) {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(reqOrigin) });
      }
      const route = url.pathname.slice('/api/stripe/'.length);
      try {
        if (route === 'config' && request.method === 'GET') {
          return json({ ok: true, live: !!env.STRIPE_SECRET_KEY }, 200, reqOrigin);
        }
        if (route === 'checkout' && request.method === 'POST') return await handleCheckout(request, env, url, reqOrigin);
        if (route === 'session' && request.method === 'GET') return await handleSessionStatus(request, env, url, reqOrigin);
        if (route === 'webhook' && request.method === 'POST') return await handleWebhook(request, env, reqOrigin);
        return json({ ok: false, error: 'not_found' }, 404, reqOrigin);
      } catch (e) {
        return json({ ok: false, error: 'server_error', message: String((e && e.message) || e) }, 500, reqOrigin);
      }
    }

    // —— /.cloud/* 动态转发到云沙箱 ——
    if (dynamic) {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(reqOrigin) });
      }

      const target = ORIGIN + url.pathname + url.search;
      const headers = new Headers(request.headers);
      headers.delete('Host');
      headers.delete('cf-connecting-ip');
      headers.delete('cf-ipcountry');
      headers.delete('cf-ray');
      headers.delete('cf-visitor');
      headers.delete('x-forwarded-proto');
      // 关键：云后端按 Origin 白名单放行，改写回源站域名
      headers.set('Origin', ORIGIN);
      headers.set('Referer', ORIGIN + '/');

      // 埋点地理注入：page_views 补上边缘判定的国家/州
      let geoBody = null;
      if (request.method === 'POST' && url.pathname === '/.cloud/database/rest/page_views') {
        try {
          const raw = await request.text();
          if (raw) {
            const cf = request.cf || {};
            const country = String(cf.country || '').toUpperCase().slice(0, 2);
            const region = String(cf.region || '').toUpperCase().slice(0, 24);
            let rows = null;
            try { rows = JSON.parse(raw); } catch (e) {}
            if (rows && typeof rows === 'object') {
              const arr = Array.isArray(rows) ? rows : [rows];
              for (const r of arr) {
                if (!r || typeof r !== 'object') continue;
                if (country && !r.country) r.country = country;
                if (region && !r.region) r.region = region;
              }
              geoBody = JSON.stringify(Array.isArray(rows) ? arr : arr[0]);
            } else {
              geoBody = raw;
            }
          }
        } catch (e) { geoBody = null; }
      }

      const init = { method: request.method, headers, redirect: 'manual' };
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = geoBody != null ? geoBody : request.body;
        try { init.duplex = 'half'; } catch (e) {}
      }

      let upstream;
      try {
        upstream = await fetch(target, init);
      } catch (e) {
        return new Response(JSON.stringify({
          error: 'upstream_unreachable',
          message: String((e && e.message) || e)
        }), {
          status: 502,
          headers: Object.assign({ 'content-type': 'application/json' }, Object.fromEntries(corsHeaders(reqOrigin)))
        });
      }

      const out = new Headers(upstream.headers);
      out.delete('access-control-allow-origin');
      out.delete('access-control-allow-credentials');
      out.delete('access-control-allow-methods');
      out.delete('access-control-allow-headers');
      corsHeaders(reqOrigin).forEach((v, k) => out.set(k, v));
      out.set('Cache-Control', 'no-store');

      return new Response(upstream.body, { status: upstream.status, headers: out });
    }

    // —— 其余一切：静态资产（永不休眠的货架）——
    return env.ASSETS.fetch(request);
  }
};
