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
  @font-face { font-family: 'Outfit'; src: url('https://heykeo.com/fonts/outfit.woff2') format('woff2'); font-weight: 100 900; font-display: swap; }
  :root { color-scheme: dark; --bg: #050506; --glass: rgba(255,255,255,.035); --glass2: rgba(255,255,255,.06); --line: rgba(255,255,255,.08); --line2: rgba(255,255,255,.16); --text: #f4f4f2; --muted: #8f9097; --ash: #bcbfc7; --ok: #7ee2a8; --bad: #ff8a8a; --warn: #ffcf70; --chrome: linear-gradient(180deg,#ffffff 0%,#e4e6ea 38%,#9a9ea8 72%,#d7d9de 100%); --display: 'Outfit', 'Segoe UI', system-ui, sans-serif; --ease: cubic-bezier(.2,.7,.1,1); }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 "Segoe UI", system-ui, -apple-system, sans-serif; -webkit-font-smoothing: antialiased; }
  body::before { content: ''; position: fixed; inset: -20% -10% auto; height: 70vh; background: radial-gradient(50% 60% at 50% 0%, rgba(255,255,255,.09), transparent 70%); pointer-events: none; }
  .wrap { position: relative; max-width: 1180px; margin: 0 auto; padding: 28px 20px 56px; }
  header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 44px; }
  .logo { display: flex; align-items: center; gap: 10px; font: 700 21px/1 var(--display); letter-spacing: -.04em; text-decoration: none; color: var(--text); }
  .eyes { width: 30px; height: 30px; border-radius: 9px; background: #121219; box-shadow: inset 0 0 0 1px rgba(255,255,255,.12); display: flex; align-items: center; justify-content: center; gap: 4px; }
  .eyes i { width: 4px; height: 9px; border-radius: 3px; background: #fff; }
  .grow { flex: 1; }
  .seg { display: inline-flex; border: 1px solid var(--line2); border-radius: 999px; padding: 4px; background: var(--glass); backdrop-filter: blur(12px); }
  .seg button { border: 0; background: none; color: var(--muted); padding: 7px 16px; border-radius: 999px; font: 600 13px/1 var(--display); cursor: pointer; transition: color .2s, background .2s; }
  .seg button.on { background: #f4f4f2; color: #050506; }
  .hero { text-align: center; margin: 0 auto 34px; max-width: 720px; }
  .eyebrow { display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px; border-radius: 999px; border: 1px solid var(--line2); background: var(--glass); color: var(--ash); font-size: 12.5px; margin-bottom: 18px; }
  .eyebrow b { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 10px var(--ok); }
  h1 { font: 600 clamp(34px, 5.4vw, 56px)/1.02 var(--display); letter-spacing: -.045em; margin: 0 0 14px; }
  h1 .chrome, h2.section .chrome { background: var(--chrome); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .lead { color: var(--muted); margin: 0 auto; max-width: 600px; }
  .who { margin: 0 auto 26px; max-width: 760px; padding: 12px 16px; border: 1px solid var(--line); border-radius: 16px; background: var(--glass); color: var(--muted); text-align: center; font-size: 14px; }
  .who strong { color: var(--text); }
  .plans { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 14px; }
  #plans { grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); align-items: stretch; }
  .plan { position: relative; display: flex; flex-direction: column; padding: 24px 22px 22px; border: 1px solid var(--line); border-radius: 24px; background: linear-gradient(160deg, rgba(255,255,255,.05), rgba(255,255,255,.012)); box-shadow: inset 0 1px 0 rgba(255,255,255,.06); transition: transform .35s var(--ease), border-color .3s; }
  .plan:hover { transform: translateY(-3px); border-color: var(--line2); }
  .plan.best { border-color: transparent; background: linear-gradient(#0b0b0d, #0b0b0d) padding-box, linear-gradient(160deg, #fff, rgba(255,255,255,.15) 45%, rgba(255,255,255,.55)) border-box; box-shadow: 0 30px 90px rgba(255,255,255,.07), inset 0 1px 0 rgba(255,255,255,.1); }
  .tag { position: absolute; top: -12px; left: 22px; padding: 4px 11px; border-radius: 999px; background: #f4f4f2; color: #050506; font: 700 11.5px/1 var(--display); letter-spacing: .02em; }
  .tag.dim { background: #1a1a1e; color: var(--ash); border: 1px solid var(--line2); }
  .plan h2 { margin: 0; font: 600 19px/1.2 var(--display); letter-spacing: -.02em; }
  .sub { color: var(--muted); font-size: 13px; min-height: 20px; margin-top: 4px; }
  .price { font: 600 40px/1 var(--display); letter-spacing: -.045em; margin: 18px 0 2px; }
  .price small { font: 400 14px/1 "Segoe UI", system-ui, sans-serif; color: var(--muted); letter-spacing: 0; }
  .big { margin: 18px 0 4px; padding: 14px 14px; border-radius: 16px; background: rgba(255,255,255,.04); border: 1px solid var(--line); }
  .big b { display: block; font: 600 22px/1.1 var(--display); letter-spacing: -.03em; }
  .big span { font-size: 12.5px; color: var(--muted); }
  ul { list-style: none; padding: 0; margin: 14px 0 22px; flex: 1; }
  li { padding: 6px 0 6px 26px; position: relative; color: var(--ash); font-size: 13.5px; }
  li::before { content: ""; position: absolute; left: 2px; top: 10px; width: 15px; height: 15px; border-radius: 50%; background: rgba(255,255,255,.08); }
  li::after { content: ""; position: absolute; left: 7px; top: 14px; width: 6px; height: 3px; border-left: 1.6px solid #fff; border-bottom: 1.6px solid #fff; transform: rotate(-45deg); }
  li.no { color: #5c5d65; }
  li.no::after { border: 0; height: 1.6px; width: 6px; top: 17px; left: 7px; background: #5c5d65; transform: none; }
  .btn { width: 100%; height: 46px; padding: 0 16px; border-radius: 999px; border: 1px solid var(--line2); background: var(--glass); color: var(--text); font: 600 14.5px/1 "Segoe UI", system-ui, sans-serif; cursor: pointer; transition: transform .25s var(--ease), background .2s, box-shadow .25s; }
  .btn:hover:not(:disabled) { transform: translateY(-1px); background: var(--glass2); }
  .btn.primary { background: #f4f4f2; color: #050506; border-color: #fff; box-shadow: 0 10px 34px rgba(255,255,255,.12); }
  .btn.primary:hover:not(:disabled) { background: #fff; box-shadow: 0 14px 50px rgba(255,255,255,.22); }
  .btn:disabled { opacity: .5; cursor: default; }
  .how { margin: 18px 0 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
  .how div { padding: 16px 18px; border-radius: 18px; border: 1px solid var(--line); background: var(--glass); font-size: 13px; color: var(--muted); }
  .how strong { display: block; font: 600 14px/1.3 var(--display); color: var(--text); margin-bottom: 4px; letter-spacing: -.01em; }
  .manage { margin-top: 22px; padding: 16px 18px; border: 1px solid var(--line); border-radius: 18px; background: var(--glass); display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .manage .btn { width: auto; height: 38px; }
  h2.section { font: 600 clamp(26px, 3.6vw, 36px)/1.05 var(--display); letter-spacing: -.04em; margin: 64px 0 8px; }
  .section-lead { color: var(--muted); margin: 0 0 22px; max-width: 760px; }
  .pack { padding: 22px; }
  .pack .price { font-size: 32px; margin-top: 10px; }
  .pack .btn { margin-top: 18px; }
  .custom { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
  .custom input { flex: 1; min-width: 160px; height: 46px; padding: 0 16px; border-radius: 999px; border: 1px solid var(--line2); background: rgba(0,0,0,.35); color: var(--text); font: inherit; outline: none; }
  .custom input:focus { border-color: rgba(255,255,255,.5); }
  .custom .btn { width: auto; }
  .note { margin: 18px 0 0; padding: 12px 16px; border-radius: 16px; border: 1px solid var(--line); background: var(--glass); }
  .note.ok { border-color: #2f6b4b; color: var(--ok); } .note.bad { border-color: #6b2f2f; color: var(--bad); } .note.warn { border-color: #6b5a2f; color: var(--warn); }
  .fine { margin-top: 44px; padding-top: 22px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12.5px; }
  .fine a { color: var(--text); }
  .lock { display: inline-block; width: 10px; height: 8px; border: 2px solid var(--muted); border-radius: 2px; margin-right: 6px; position: relative; top: 1px; }
  .rise { animation: rise .6s var(--ease) both; }
  @keyframes rise { from { opacity: 0; transform: translateY(14px); } }
  @media (prefers-reduced-motion: reduce) { .rise, .plan { animation: none !important; transition: none !important; } }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <a class="logo" href="https://heykeo.com/"><span class="eyes"><i></i><i></i></span>Keo</a>
    <span class="grow"></span>
    <div class="seg" id="currencies" role="group" aria-label="Currency"></div>
  </header>
  <section class="hero">
    <div class="eyebrow"><b></b>Monthly plans · cancel any time</div>
    <h1>Choose your plan, <span class="chrome">create without limits.</span></h1>
    <p class="lead">One monthly AI allowance for chat, building and operating your computer — plus Studio credits for AI video.</p>
  </section>
  <p class="who" id="who" hidden></p>
  <div class="plans" id="plans"><p class="lead">Loading plans…</p></div>
  <div class="how">
    <div><strong>Lasts the whole month</strong>New work can use up to about a third of the allowance a day and 60% a week, so it never runs out on day one. A task already started always finishes.</div>
    <div><strong>Nothing is lost</strong>When an allowance is used up, Keo pauses and keeps your work. It carries on when it resets, or right away with a top-up.</div>
    <div><strong>Studio credits are separate</strong>AI clips, Clone a video and character voices use Studio credits, never your chat allowance.</div>
  </div>
  <div class="manage" id="manage" hidden>
    <span class="grow" id="manage-text"></span>
    <button class="btn" id="card">Update card</button>
    <button class="btn" id="cancel">Cancel renewal</button>
  </div>
  <div id="topup-wrap" hidden>
    <h2 class="section" id="topup">AI top-up</h2>
    <p class="section-lead">Used your allowance and want to keep going? Add more without changing plan. A top-up is used only after your plan’s allowance, works with your plan’s models, and never expires.</p>
    <div class="plans" id="topups"></div>
    <section class="plan" style="margin-top:14px">
      <h2>Your own amount</h2>
      <div class="sub" id="custom-sub"></div>
      <div class="custom"><input id="custom-amount" type="number" inputmode="decimal" aria-label="Top-up amount"><button class="btn primary" id="custom-buy">Top up</button></div>
    </section>
  </div>
  <div id="packs-wrap" hidden>
    <h2 class="section">Studio credits</h2>
    <p class="section-lead">Keo Studio’s AI (AI clips, Clone a video, same-face pictures, character voices) uses credits. Your plan’s credits renew every month; credits you buy never expire and are used after them.</p>
    <div class="plans" id="packs"></div>
  </div>
  <p class="note" id="note" hidden></p>
  <p class="fine"><span class="lock"></span>Payments are made securely with Paystack. Keo never sees or stores your card details. Plans renew every month; cancel any time and keep your plan until the end of the month you paid for. Your AI allowance renews each month from the day you paid; its daily and weekly shares reset at 00:00 UTC (weeks on Monday). Studio credits are separate and never pay for chat. Payments are not refunded. By upgrading you agree to Keo’s <a href="/terms">Terms</a>, <a href="/privacy">Privacy Policy</a> and <a href="/refunds">Refund Policy</a>.</p>
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
  var tier = { free: 'Keo Fast model', pro: 'Keo Fast and Keo Strong models', creator: 'Keo Fast and Keo Strong models', max: 'Keo Fast and Keo Strong, and Keo Best when you choose it' };

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
  var n = function (x) { return Number(x || 0).toLocaleString(); };
  /** The card's headline: what the monthly AI allowance is worth. */
  function headline(p) {
    var al = p.allowance || {};
    if (al.strongBuilds) return [n(al.strongBuilds) + ' builds a month', 'on Keo Strong, or ' + n(al.fastTasks) + ' tasks on Keo Fast'];
    if (al.fastTasks) return [n(al.fastTasks) + ' tasks a month', 'on Keo Fast'];
    return null;
  }
  function features(p) {
    var f = p.features || {}, al = p.allowance || {}, out = [];
    out.push([true, tier[p.id] || 'Keo models']);
    if (al.bestBuilds) out.push([true, 'Keo Best: about ' + n(al.bestBuilds) + ' builds (uses it twice as fast)']);
    out.push([f.web_search > 0, f.web_search > 0 ? n(f.web_search) + ' web searches a day' : 'Keo web search']);
    out.push([f.images > 0, f.images > 0 ? n(f.images) + ' AI pictures a day' : 'AI pictures']);
    out.push([f.voice_minutes > 0, f.voice_minutes > 0 ? n(f.voice_minutes) + ' minutes of Keo’s voice a day' : 'Keo’s voice']);
    out.push([true, (f.background_jobs || 1) + ' background job' + ((f.background_jobs || 1) > 1 ? 's' : '') + ' at once']);
    out.push([true, f.studio_credits > 0 ? n(f.studio_credits) + ' Studio credits a month' : n(P_trial) + ' Studio credits to try, once']);
    return out;
  }
  var P_trial = 150;

  function render() {
    var P = state.prices, me = state.me;
    if (!P) return;
    if (P.trialCredits !== undefined) P_trial = P.trialCredits;
    var cur = $('currencies'); cur.innerHTML = '';
    P.currencies.forEach(function (c) {
      var b = document.createElement('button'); b.textContent = c; b.className = c === state.currency ? 'on' : '';
      b.onclick = function () { state.currency = c; render(); }; cur.appendChild(b);
    });
    cur.hidden = P.currencies.length < 2;
    var current = me ? me.plan : null;
    var box = $('plans'); box.innerHTML = '';
    P.plans.forEach(function (p) {
      var el = document.createElement('section'); el.className = 'plan rise' + (p.id === 'pro' ? ' best' : '');
      el.style.animationDelay = (box.children.length * 70) + 'ms';
      var amount = p.prices[state.currency];
      el.innerHTML = (p.id === 'pro' ? '<span class="tag">Most popular</span>' : p.id === 'creator' ? '<span class="tag dim">For video</span>' : p.id === 'max' ? '<span class="tag dim">Most AI</span>' : '') + '<h2></h2><div class="sub"></div><div class="price"></div><div class="big"><b></b><span></span></div><ul></ul>';
      var hl = headline(p);
      if (hl) { el.querySelector('.big b').textContent = hl[0]; el.querySelector('.big span').textContent = hl[1]; } else el.querySelector('.big').remove();
      el.querySelector('h2').textContent = p.name;
      var priceEl = el.querySelector('.price');
      priceEl.appendChild(document.createTextNode(p.id === 'free' ? money(0, state.currency) : amount ? money(amount, state.currency) : '—'));
      if (p.id !== 'free') { var s = document.createElement('small'); s.textContent = ' / month'; priceEl.appendChild(s); }
      el.querySelector('.sub').textContent = p.id === 'free' ? 'For trying Keo' : p.id === 'pro' ? 'For everyday work' : p.id === 'creator' ? 'The most Studio credits, for AI video' : 'The biggest AI allowance, and Keo Best';
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
    // AI top-ups: three packs and an amount the user types.
    var T = P.topups;
    $('topup-wrap').hidden = !(T && T.packs && T.packs.length);
    var worth = function (w) { return 'About ' + w.strongBuilds + ' builds on Keo Strong, or ' + w.fastTasks.toLocaleString() + ' tasks on Keo Fast'; };
    var tbox = $('topups'); tbox.innerHTML = '';
    ((T && T.packs) || []).forEach(function (k) {
      var el = document.createElement('section'); el.className = 'plan pack';
      el.innerHTML = '<h2></h2><div class="price"></div><div class="sub"></div>';
      el.querySelector('h2').textContent = k.id.charAt(0).toUpperCase() + k.id.slice(1);
      var amount = k.prices[state.currency];
      el.querySelector('.price').textContent = amount ? money(amount, state.currency) : '—';
      el.querySelector('.sub').textContent = worth(k.worth);
      var b = document.createElement('button'); b.className = 'btn';
      if (!amount) { b.textContent = 'Not available in ' + state.currency; b.disabled = true; }
      else if (!ticket) { b.textContent = 'Top up from the Keo app'; b.disabled = true; }
      else if (!P.payments) { b.textContent = 'Coming soon'; b.disabled = true; }
      else { b.textContent = 'Top up ' + money(amount, state.currency); b.className = 'btn primary'; b.onclick = function () { topup({ pack: k.id }); }; }
      el.appendChild(b); tbox.appendChild(el);
    });
    if (T && T.custom) {
      var min = T.custom.min[state.currency], max = T.custom.max[state.currency];
      var input = $('custom-amount');
      input.min = min ? String(min / 100) : ''; input.max = max ? String(max / 100) : ''; input.step = state.currency === 'NGN' ? '500' : '1';
      input.placeholder = min ? 'From ' + money(min, state.currency) + ' to ' + money(max, state.currency) : 'Not available';
      var perUnit = function (minor) { var usd = state.currency === 'NGN' ? minor / 100 / T.custom.ngnPerUsd : minor / 100; return usd * T.custom.share; };
      var say = function () {
        var v = Math.round(Number(input.value) * 100);
        $('custom-sub').textContent = v && min && v >= min && v <= max
          ? 'About ' + Math.floor(perUnit(v) * T.custom.worthPerUsd.strongBuilds) + ' builds on Keo Strong, or ' + Math.floor(perUnit(v) * T.custom.worthPerUsd.fastTasks).toLocaleString() + ' tasks on Keo Fast'
          : min ? 'Type any amount from ' + money(min, state.currency) + ' to ' + money(max, state.currency) + '. It adds AI at the Small pack’s rate.' : 'Not available in ' + state.currency + '.';
      };
      input.oninput = say; say();
      var cb = $('custom-buy');
      cb.disabled = !min || !ticket || !P.payments;
      cb.textContent = !ticket ? 'Top up from the Keo app' : !P.payments ? 'Coming soon' : 'Top up';
      cb.onclick = function () {
        var v = Math.round(Number(input.value) * 100);
        if (!(v >= min && v <= max)) { note('Choose an amount from ' + money(min, state.currency) + ' to ' + money(max, state.currency) + '.', 'bad'); return; }
        topup({ amount: v });
      };
    }
    // Opened from Keo's "Buy an AI top-up": go straight to it (once).
    if (hash.get('go') === 'topup' && !state.wentToTopup && !$('topup-wrap').hidden) { state.wentToTopup = true; setTimeout(function () { $('topup').scrollIntoView({ behavior: 'smooth' }); }, 60); }
    // Studio credit packs: one payment each, the credits never expire.
    var packs = $('packs'); packs.innerHTML = '';
    $('packs-wrap').hidden = !(P.packs && P.packs.length);
    (P.packs || []).forEach(function (k) {
      var el = document.createElement('section'); el.className = 'plan pack';
      el.innerHTML = '<h2></h2><div class="price"></div><div class="sub"></div>';
      el.querySelector('h2').textContent = k.credits.toLocaleString() + ' credits';
      var amount = k.prices[state.currency];
      el.querySelector('.price').textContent = amount ? money(amount, state.currency) : '—';
      el.querySelector('.sub').textContent = 'About ' + Math.floor(k.credits / 168) + ' AI clips of 5 seconds with sound, or ' + Math.floor(k.credits / 30) + ' realistic pictures';
      var b = document.createElement('button'); b.className = 'btn';
      if (!amount) { b.textContent = 'Not available in ' + state.currency; b.disabled = true; }
      else if (!ticket) { b.textContent = 'Buy from the Keo app'; b.disabled = true; }
      else if (!P.payments) { b.textContent = 'Coming soon'; b.disabled = true; }
      else { b.textContent = 'Buy ' + k.credits.toLocaleString() + ' credits'; b.className = 'btn primary'; b.onclick = function () { buy(k); }; }
      el.appendChild(b); packs.appendChild(el);
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
      who.hidden = false; who.textContent = 'To upgrade, open Keo → Settings → Keo account → Upgrade. This page then opens signed in.';
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
          if (r.ok) { note(r.credits ? 'Done! ' + r.credits.toLocaleString() + ' Studio credits were added. Go back to Keo: they show within a minute.' : 'Done! Your plan is active. Go back to Keo — it updates within a minute (or click Refresh in Settings → Providers).', 'ok'); return load(); }
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

  function buy(k) {
    if (state.busy) return;
    state.busy = true; note('Opening secure checkout…', '');
    api('POST', '/v1/billing/credits', { pack: k.id, currency: state.currency })
      .then(function (c) { note('', ''); return popup(c); })
      .catch(function (e) { note(e.message, 'bad'); })
      .then(function () { state.busy = false; });
  }

  function topup(what) {
    if (state.busy) return;
    state.busy = true; note('Opening secure checkout…', '');
    api('POST', '/v1/billing/topup', Object.assign({ currency: state.currency }, what))
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
