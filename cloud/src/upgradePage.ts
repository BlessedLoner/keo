/**
 * Keo's plans and payment page. Card details are typed only into Paystack's secure checkout,
 * which opens on top of this page; the page itself talks only to Keo Cloud (prices, checkout,
 * cancelling) with a short-lived ticket from the Keo app.
 */
export function upgradePage(): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Keo plans</title>
<style>
  :root { color-scheme: dark; --bg: #050505; --card: #0f0f0f; --line: #262626; --line2: #3a3a3a; --text: #f4f4f4; --muted: #9b9b9b; --ok: #7ee2a8; --bad: #ff8a8a; --warn: #ffcf70; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 "Segoe UI", system-ui, sans-serif; }
  .wrap { max-width: 1040px; margin: 0 auto; padding: 32px 16px 48px; }
  header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 28px; }
  .logo { display: flex; align-items: center; gap: 10px; font-weight: 700; letter-spacing: 0.14em; }
  .eyes { width: 34px; height: 34px; border-radius: 10px; background: #fff; display: flex; align-items: center; justify-content: center; gap: 5px; }
  .eyes i { width: 6px; height: 9px; border-radius: 3px; background: #050505; }
  .grow { flex: 1; }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 999px; padding: 3px; }
  .seg button { border: 0; background: none; color: var(--muted); padding: 6px 14px; border-radius: 999px; font: inherit; cursor: pointer; }
  .seg button.on { background: #fff; color: #000; font-weight: 600; }
  h1 { font-size: 30px; margin: 0 0 6px; letter-spacing: -0.01em; }
  .lead { color: var(--muted); margin: 0 0 24px; }
  .who { margin: 0 0 22px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px; color: var(--muted); }
  .who strong { color: var(--text); }
  .plans { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
  .plan { position: relative; display: flex; flex-direction: column; padding: 22px; border: 1px solid var(--line); border-radius: 16px; background: var(--card); }
  .plan.best { border-color: #fff; }
  .tag { position: absolute; top: -11px; left: 18px; padding: 2px 10px; border-radius: 999px; background: #fff; color: #000; font-size: 12px; font-weight: 700; }
  .plan h2 { margin: 0 0 4px; font-size: 20px; }
  .price { font-size: 32px; font-weight: 700; margin: 8px 0 2px; }
  .price small { font-size: 14px; color: var(--muted); font-weight: 400; }
  .sub { color: var(--muted); font-size: 13px; min-height: 20px; }
  ul { list-style: none; padding: 0; margin: 16px 0 20px; flex: 1; }
  li { padding: 5px 0 5px 24px; position: relative; color: #d6d6d6; }
  li::before { content: ""; position: absolute; left: 4px; top: 12px; width: 9px; height: 5px; border-left: 2px solid var(--ok); border-bottom: 2px solid var(--ok); transform: rotate(-45deg); }
  li.no { color: var(--muted); }
  li.no::before { border: 0; height: 2px; width: 10px; top: 14px; background: var(--line2); transform: none; }
  .btn { width: 100%; padding: 12px; border-radius: 10px; border: 1px solid var(--line2); background: transparent; color: var(--text); font: inherit; font-weight: 600; cursor: pointer; }
  .btn.primary { background: #fff; color: #000; border-color: #fff; }
  .btn:disabled { opacity: 0.55; cursor: default; }
  .manage { margin-top: 22px; padding: 18px; border: 1px solid var(--line); border-radius: 14px; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .manage .btn { width: auto; padding: 9px 14px; }
  .note { margin: 18px 0 0; padding: 12px 14px; border-radius: 12px; border: 1px solid var(--line); }
  .note.ok { border-color: #2f6b4b; color: var(--ok); } .note.bad { border-color: #6b2f2f; color: var(--bad); } .note.warn { border-color: #6b5a2f; color: var(--warn); }
  .fine { margin-top: 26px; color: var(--muted); font-size: 13px; }
  .lock { display: inline-block; width: 10px; height: 8px; border: 2px solid var(--muted); border-radius: 2px; margin-right: 6px; position: relative; top: 1px; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo"><span class="eyes"><i></i><i></i></span>KEO</div>
    <span class="grow"></span>
    <div class="seg" id="currencies" role="group" aria-label="Currency"></div>
  </header>
  <h1>Choose your plan</h1>
  <p class="lead">More AI steps, stronger models, pictures and longer voice — on your own computer.</p>
  <p class="who" id="who" hidden></p>
  <div class="plans" id="plans"><p class="lead">Loading plans…</p></div>
  <div class="manage" id="manage" hidden>
    <span class="grow" id="manage-text"></span>
    <button class="btn" id="card">Update card</button>
    <button class="btn" id="cancel">Cancel renewal</button>
  </div>
  <p class="note" id="note" hidden></p>
  <p class="fine"><span class="lock"></span>Payments are made securely with Paystack. Keo never sees or stores your card details. Plans renew every month; cancel any time and keep your plan until the end of the month you paid for. Daily allowances reset at midnight UTC.</p>
</div>
<script>
(function () {
  var hash = new URLSearchParams(location.hash.slice(1));
  var query = new URLSearchParams(location.search);
  // The ticket from the Keo app stays out of the address bar and the history.
  try { if (hash.get('t')) sessionStorage.setItem('keo-ticket', hash.get('t')); } catch (e) {}
  var ticket = hash.get('t') || (function () { try { return sessionStorage.getItem('keo-ticket'); } catch (e) { return null; } })();
  history.replaceState(null, '', location.pathname);
  var $ = function (id) { return document.getElementById(id); };
  var state = { prices: null, me: null, currency: 'USD', busy: false };
  var tier = { free: 'Keo Fast model', pro: 'Keo Fast and Keo Strong models', max: 'All models, including Keo Best' };

  function note(text, kind) { var n = $('note'); n.hidden = !text; n.className = 'note ' + (kind || ''); n.textContent = text || ''; }
  function api(method, path, body) {
    return fetch(path, { method: method, headers: Object.assign({ 'content-type': 'application/json' }, ticket ? { authorization: 'Bearer ' + ticket } : {}), body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error((j.error && j.error.message) || ('Keo Cloud answered ' + r.status)); return j; }); });
  }
  function money(amount, currency) {
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency, maximumFractionDigits: amount % 100 ? 2 : 0 }).format(amount / 100); }
    catch (e) { return currency + ' ' + (amount / 100).toLocaleString(); }
  }
  function day(iso) { try { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }); } catch (e) { return iso; } }
  function features(p) {
    var f = p.features || {}, out = [];
    out.push([true, p.dailyRequests.toLocaleString() + ' AI steps a day']);
    out.push([true, tier[p.id] || 'Keo models']);
    out.push([f.web_search > 0, f.web_search > 0 ? f.web_search + ' Keo web searches a day' : 'Keo web search']);
    out.push([f.images > 0, f.images > 0 ? f.images + ' AI pictures a day' : 'AI pictures']);
    out.push([f.voice_minutes > 0, f.voice_minutes > 0 ? f.voice_minutes + ' minutes of Keo’s voice a day' : 'Keo’s voice']);
    out.push([!!f.video, 'Video making']);
    return out;
  }

  function render() {
    var P = state.prices, me = state.me;
    if (!P) return;
    var cur = $('currencies'); cur.innerHTML = '';
    P.currencies.forEach(function (c) {
      var b = document.createElement('button'); b.textContent = c; b.className = c === state.currency ? 'on' : '';
      b.onclick = function () { state.currency = c; render(); }; cur.appendChild(b);
    });
    cur.hidden = P.currencies.length < 2;
    var current = me ? me.plan : null;
    var box = $('plans'); box.innerHTML = '';
    P.plans.forEach(function (p) {
      var el = document.createElement('section'); el.className = 'plan' + (p.id === 'pro' ? ' best' : '');
      var amount = p.prices[state.currency];
      el.innerHTML = (p.id === 'pro' ? '<span class="tag">Most popular</span>' : '') + '<h2></h2><div class="price"></div><div class="sub"></div><ul></ul>';
      el.querySelector('h2').textContent = p.name;
      var priceEl = el.querySelector('.price');
      priceEl.appendChild(document.createTextNode(p.id === 'free' ? money(0, state.currency) : amount ? money(amount, state.currency) : '—'));
      if (p.id !== 'free') { var s = document.createElement('small'); s.textContent = ' / month'; priceEl.appendChild(s); }
      el.querySelector('.sub').textContent = p.id === 'free' ? 'For trying Keo' : p.id === 'pro' ? 'For everyday work' : 'For heavy use';
      var ul = el.querySelector('ul');
      features(p).forEach(function (f) { var li = document.createElement('li'); li.textContent = f[1]; if (!f[0]) li.className = 'no'; ul.appendChild(li); });
      var b = document.createElement('button'); b.className = 'btn';
      var renewing = me && me.status !== 'non-renewing';
      if (p.id === current && (p.id === 'free' || renewing)) { b.textContent = 'Your current plan'; b.disabled = true; }
      else if (p.id === 'free') { b.textContent = 'Free'; b.disabled = true; }
      else if (!amount) { b.textContent = 'Not available in ' + state.currency; b.disabled = true; }
      else if (!ticket) { b.textContent = 'Upgrade from the Keo app'; b.disabled = true; }
      else if (!P.payments) { b.textContent = 'Coming soon'; b.disabled = true; }
      else {
        b.textContent = p.id === current ? 'Renew ' + p.name : (current && current !== 'free' ? 'Switch to ' : 'Upgrade to ') + p.name;
        b.className = 'btn primary'; b.onclick = function () { pay(p); };
      }
      el.appendChild(b); box.appendChild(el);
    });
    var who = $('who');
    if (me) {
      who.hidden = false;
      who.innerHTML = 'Signed in as <strong></strong> · ';
      who.querySelector('strong').textContent = me.email || 'your Keo account';
      var planName = (P.plans.filter(function (p) { return p.id === me.plan; })[0] || { name: me.plan }).name;
      who.appendChild(document.createTextNode(planName + ' plan' + (me.planUntil ? (me.status === 'non-renewing' || me.status === 'cancelled' ? ' · ends ' + day(me.planUntil) : ' · renews around ' + day(me.planUntil)) : '')));
      if (me.status === 'attention') note('Your last renewal payment did not go through. Update your card to keep your plan.', 'warn');
    } else if (!ticket) {
      who.hidden = false; who.textContent = 'To upgrade, open Keo → Settings → Providers → Keo account → Upgrade. This page then opens signed in.';
    }
    $('manage').hidden = !(me && me.canManage);
    if (me && me.canManage) $('manage-text').textContent = me.status === 'non-renewing' ? 'Your plan will not renew. You keep it until ' + day(me.planUntil) + '.' : 'Manage your subscription';
    $('cancel').hidden = !(me && me.canManage && me.status !== 'non-renewing');
  }

  function load() {
    return Promise.all([api('GET', '/v1/billing/prices'), ticket ? api('GET', '/v1/billing').catch(function (e) { note(e.message, 'bad'); return null; }) : null])
      .then(function (r) {
        state.prices = r[0]; state.me = r[1];
        state.currency = (state.me && state.me.currency && r[0].currencies.indexOf(state.me.currency) >= 0) ? state.me.currency : r[0].currency;
        render();
      })
      .catch(function (e) { $('plans').innerHTML = ''; note('Could not load the plans: ' + e.message, 'bad'); });
  }

  function confirmPaid(reference) {
    note('Payment received — switching your plan…', 'ok');
    var tries = 0;
    (function again() {
      api('POST', '/v1/billing/confirm', { reference: reference })
        .then(function (r) {
          if (r.ok) { note('Done! Your plan is active. Go back to Keo — it updates within a minute (or click Refresh in Settings → Providers).', 'ok'); return load(); }
          if (++tries < 5) return setTimeout(again, 3000);
          note('Paystack has not confirmed the payment yet. If you were charged, your plan switches within a few minutes.', 'warn');
        })
        .catch(function (e) { if (++tries < 5) return setTimeout(again, 3000); note(e.message, 'bad'); });
    })();
  }

  function popup(checkout) {
    return new Promise(function (resolve, reject) {
      if (window.PaystackPop) return resolve();
      var s = document.createElement('script'); s.src = 'https://js.paystack.co/v2/inline.js';
      s.onload = function () { resolve(); }; s.onerror = function () { reject(new Error('popup')); };
      document.head.appendChild(s);
    }).then(function () {
      new window.PaystackPop().resumeTransaction(checkout.accessCode, {
        onSuccess: function (t) { confirmPaid((t && (t.reference || t.trxref)) || checkout.reference); },
        onCancel: function () { note('Payment cancelled. Nothing was charged.', ''); },
        onError: function () { location.href = checkout.url; }
      });
    }).catch(function () { location.href = checkout.url; });
  }

  function pay(p) {
    if (state.busy) return;
    state.busy = true; note('Opening secure checkout…', '');
    api('POST', '/v1/billing/checkout', { plan: p.id, currency: state.currency })
      .then(function (c) { note('', ''); return popup(c); })
      .catch(function (e) { note(e.message, 'bad'); })
      .then(function () { state.busy = false; });
  }

  $('card').onclick = function () {
    api('GET', '/v1/billing/manage').then(function (r) { window.open(r.link, '_blank', 'noopener'); }).catch(function (e) { note(e.message, 'bad'); });
  };
  $('cancel').onclick = function () {
    if (!window.confirm('Stop your plan from renewing? You keep it until the end of the month you paid for.')) return;
    api('POST', '/v1/billing/cancel').then(function () { note('Done. Your plan will not renew; you keep it until the end of this month.', 'ok'); return load(); }).catch(function (e) { note(e.message, 'bad'); });
  };

  load().then(function () { var ref = query.get('reference') || query.get('trxref'); if (ref && ticket) confirmPaid(ref); });
})();
</script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline' https://*.paystack.co https://*.paystack.com; script-src 'unsafe-inline' https://js.paystack.co; connect-src 'self' https://*.paystack.co https://*.paystack.com; frame-src https://*.paystack.co https://*.paystack.com; img-src 'self' data: https:; font-src https: data:; form-action 'self' https://*.paystack.com; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}
