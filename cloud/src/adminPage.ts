/**
 * The admin page (/admin): sign in with a Keo account (Supabase email and password, in the
 * browser), then the overview, users, problem reports, Studio jobs and the admin log, read from
 * /v1/admin/*. Everything users wrote is put on the page as text (never as HTML), and the page
 * runs only its own script (a fresh nonce each time) and talks only to this gateway and Supabase.
 */
export function adminPage(env: { SUPABASE_URL: string; SUPABASE_ANON_KEY: string }): Response {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const cfg = JSON.stringify({ supabase: env.SUPABASE_URL, anon: env.SUPABASE_ANON_KEY }).replace(/</g, '\\u003c');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>Keo admin</title>
<style nonce="${nonce}">
  :root { color-scheme: dark; --bg: #050505; --card: #0f0f12; --line: #26262c; --text: #f2f2f2; --muted: #9a9aa6; --ok: #7ee2a8; --bad: #ff8a8a; --warn: #ffd27a; --accent: #8b6bff; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 "Segoe UI", system-ui, sans-serif; }
  header { display: flex; align-items: center; gap: 16px; padding: 14px 20px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--bg); z-index: 2; }
  .logo { font-weight: 700; letter-spacing: 0.12em; }
  nav { display: flex; gap: 4px; flex-wrap: wrap; }
  nav button { background: none; border: 1px solid transparent; color: var(--muted); padding: 6px 12px; border-radius: 8px; cursor: pointer; font: inherit; }
  nav button.on { color: var(--text); border-color: var(--line); background: var(--card); }
  .me { margin-left: auto; color: var(--muted); font-size: 13px; display: flex; gap: 10px; align-items: center; }
  main { padding: 20px; max-width: 1200px; margin: 0 auto; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin-bottom: 14px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; }
  .stat .n { font-size: 26px; font-weight: 700; }
  .stat .l { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
  tr.click { cursor: pointer; } tr.click:hover td { background: #16161b; }
  input, select, textarea { background: #000; color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font: inherit; }
  button.btn { background: #fff; color: #000; border: 0; border-radius: 8px; padding: 8px 14px; font: inherit; font-weight: 600; cursor: pointer; }
  button.ghost { background: none; color: var(--text); border: 1px solid var(--line); }
  button.danger { background: var(--bad); color: #000; }
  button:disabled { opacity: 0.5; cursor: default; }
  .muted { color: var(--muted); } .ok { color: var(--ok); } .bad { color: var(--bad); } .warn { color: var(--warn); }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .chip { display: inline-block; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); font-size: 12px; }
  pre { white-space: pre-wrap; word-break: break-word; background: #000; border: 1px solid var(--line); border-radius: 8px; padding: 12px; max-height: 480px; overflow: auto; font: 12px/1.45 Consolas, monospace; }
  #signin { max-width: 380px; margin: 80px auto; }
  #signin input { width: 100%; margin: 6px 0 12px; }
  #signin button { width: 100%; }
  .err { color: var(--bad); margin-top: 8px; }
  [hidden] { display: none !important; }
  h2 { font-size: 16px; margin: 0 0 12px; }
  .card { overflow-x: auto; }
  /* Phones and narrow windows: the header does not stick (it would cover the page) and the tabs scroll sideways. */
  @media (max-width: 760px) {
    header { position: static; flex-wrap: wrap; gap: 8px; padding: 12px 16px; }
    nav { order: 3; width: 100%; flex-wrap: nowrap; overflow-x: auto; }
    nav button { white-space: nowrap; }
    main { padding: 16px; }
    .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .stat .n { font-size: 20px; }
  }
</style>
</head>
<body>
<header>
  <span class="logo">KEO ADMIN</span>
  <nav id="tabs" hidden>
    <button data-tab="overview" class="on">Overview</button>
    <button data-tab="finance">Money</button>
    <button data-tab="users">Users</button>
    <button data-tab="reports">Problem reports</button>
    <button data-tab="jobs">Studio jobs</button>
    <button data-tab="actions">Admin log</button>
  </nav>
  <span class="me" id="me" hidden><span id="me-email"></span><button class="btn ghost" id="signout">Sign out</button></span>
</header>
<main>
  <section id="signin" class="card">
    <h2>Sign in</h2>
    <p class="muted">With your Keo account. Only Keo admins get in.</p>
    <form id="signin-form">
      <input id="email" type="email" autocomplete="username" placeholder="Email" required>
      <input id="password" type="password" autocomplete="current-password" placeholder="Password" required>
      <button class="btn" type="submit" id="signin-btn">Sign in</button>
    </form>
    <p class="err" id="signin-err" hidden></p>
  </section>
  <section id="view" hidden></section>
</main>
<script nonce="${nonce}">
(() => {
  const CFG = ${cfg};
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) n.append(kid instanceof Node ? kid : document.createTextNode(kid === undefined || kid === null ? '' : String(kid)));
    return n;
  };
  const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
  const money = (rev) => Object.entries(rev || {}).map(([c, a]) => c + ' ' + (a / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })).join(' · ') || '—';
  const store = { get: () => { try { return JSON.parse(sessionStorage.getItem('keo-admin') || 'null'); } catch { return null; } }, set: (v) => { try { v ? sessionStorage.setItem('keo-admin', JSON.stringify(v)) : sessionStorage.removeItem('keo-admin'); } catch {} } };
  let session = store.get();

  async function auth(grant, body) {
    const r = await fetch(CFG.supabase + '/auth/v1/token?grant_type=' + grant, { method: 'POST', headers: { apikey: CFG.anon, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(j.error_description || j.msg || 'Sign-in failed.');
    session = { access: j.access_token, refresh: j.refresh_token, until: Date.now() + (j.expires_in || 3600) * 1000 - 60000 };
    store.set(session);
  }
  async function api(path, opts) {
    if (!session) throw new Error('Sign in first.');
    if (Date.now() > session.until && session.refresh) await auth('refresh_token', { refresh_token: session.refresh }).catch(() => { session = null; store.set(null); });
    if (!session) { showSignin(); throw new Error('Your sign-in expired. Sign in again.'); }
    const r = await fetch('/v1/admin/' + path, { ...(opts || {}), headers: { authorization: 'Bearer ' + session.access, 'content-type': 'application/json' } });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { session = null; store.set(null); showSignin(); }
    if (!r.ok) throw new Error((j.error && j.error.message) || ('Error ' + r.status));
    return j;
  }
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });

  function showSignin(msg) {
    $('signin').hidden = false; $('view').hidden = true; $('tabs').hidden = true; $('me').hidden = true;
    if (msg) { $('signin-err').textContent = msg; $('signin-err').hidden = false; }
  }
  async function start() {
    try {
      const me = await api('me');
      $('me-email').textContent = me.email;
      $('signin').hidden = true; $('view').hidden = false; $('tabs').hidden = false; $('me').hidden = false;
      show('overview');
    } catch (e) {
      showSignin(e.message);
    }
  }
  $('signin-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('signin-btn').disabled = true; $('signin-err').hidden = true;
    try { await auth('password', { email: $('email').value.trim(), password: $('password').value }); $('password').value = ''; await start(); }
    catch (e) { showSignin(e.message); }
    finally { $('signin-btn').disabled = false; }
  });
  $('signout').addEventListener('click', () => { session = null; store.set(null); showSignin(); });
  document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));

  function view(...kids) { const v = $('view'); v.replaceChildren(...kids); }
  function failed(e) { view(el('div', { class: 'card bad' }, e.message)); }
  function show(tab, arg) {
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    view(el('p', { class: 'muted' }, 'Loading…'));
    ({ overview, finance, users, user, reports, report, jobs, actions })[tab](arg).catch(failed);
  }
  const stat = (n, l, cls) => el('div', { class: 'card stat' }, el('div', { class: 'n ' + (cls || '') }, n), el('div', { class: 'l' }, l));

  async function overview() {
    const o = await api('overview');
    view(
      el('div', { class: 'grid' },
        stat(o.users, 'Users'), stat(o.newUsers7d, 'New this week'), stat(o.today.activeUsers, 'Active today'),
        stat(o.today.requests, 'AI requests today'), stat('$' + o.today.costUsd, 'AI cost today'), stat('$' + o.month.aiCostUsd, 'AI cost this month'),
        stat(o.month.studioCredits.toLocaleString(), 'Studio credits used this month'), stat('$' + o.month.falCostUsd, 'fal.ai cost this month (about)'),
        stat(o.month.payments, 'Payments this month'), stat(money(o.month.revenue), 'Revenue this month'),
        stat(o.reportsNew, 'New problem reports', o.reportsNew ? 'warn' : ''), stat(o.blocked, 'Blocked accounts')),
      el('div', { class: 'card' }, el('h2', {}, 'Plans'), el('table', {}, el('tr', {}, el('th', {}, 'Plan'), el('th', {}, 'Users')), o.plans.map((p) => el('tr', {}, el('td', {}, p.name), el('td', {}, p.users))))),
    );
  }

  // Money: revenue, provider costs and gross margin per plan; what Keo owes in credits; safety limits; alerts.
  async function finance(m) {
    const f = await api('finance' + (m ? '?month=' + encodeURIComponent(m) : ''));
    const usd = (n) => '$' + Number(n || 0).toFixed(2);
    const pct = (n) => (n === null || n === undefined ? '—' : n + '%');
    const tone = (n) => (n === null || n === undefined ? '' : n < 20 ? 'bad' : n < 35 ? 'warn' : 'ok');
    const pick = el('input', { type: 'month', value: f.month });
    pick.addEventListener('change', () => finance(pick.value).catch(failed));
    view(
      el('div', { class: 'card row' }, el('span', { class: 'muted' }, 'Month'), pick, el('span', { class: 'muted' }, 'Naira converted at ₦' + f.ngnPerUsd + ' to $1 (keo_settings → ngn_per_usd)')),
      el('div', { class: 'grid' },
        stat(usd(f.total.revenueUsd), 'Revenue'), stat(usd(f.total.feesUsd), 'Payment fees (about)'),
        stat(usd(f.total.aiUsd), 'AI cost (OpenRouter)'), stat(usd(f.total.falUsd), 'Studio cost (fal.ai, about)'),
        stat(usd(f.total.marginUsd), 'Gross margin', tone(f.total.marginPct)), stat(pct(f.total.marginPct), 'Gross margin %', tone(f.total.marginPct)),
        stat(usd(f.liabilities.falCostUsd), 'Owed in Studio credits (fal.ai cost)'), stat(f.liabilities.boughtCredits.toLocaleString(), 'Bought and gift credits not used'),
        stat(f.liabilities.monthlyCreditsLeft.toLocaleString(), 'Monthly credits left this month'),
        stat(usd(f.liabilities.topupUsd), 'Owed in unused AI top-ups (AI cost)')),
      el('div', { class: 'card' }, el('h2', {}, 'By plan'), el('table', {},
        el('tr', {}, ['Plan', 'Users', 'Payments', 'Revenue', 'Fees', 'AI cost', 'Studio cost', 'Margin', 'Margin %'].map((h) => el('th', {}, h))),
        f.byPlan.map((r) => el('tr', {}, el('td', {}, r.plan), el('td', {}, r.users), el('td', {}, r.payers), el('td', {}, usd(r.revenueUsd)), el('td', {}, usd(r.feesUsd)),
          el('td', {}, usd(r.aiUsd)), el('td', {}, usd(r.falUsd)), el('td', {}, usd(r.marginUsd)), el('td', { class: tone(r.marginPct) }, pct(r.marginPct)))))),
      el('div', { class: 'card' }, el('h2', {}, 'Safety limits today'), el('table', {},
        el('tr', {}, ['Provider', 'Spent today', 'Daily limit'].map((h) => el('th', {}, h))),
        f.breakers.map((b) => el('tr', {}, el('td', {}, b.provider), el('td', { class: b.limitUsd && b.todayUsd >= b.limitUsd * 0.8 ? 'warn' : '' }, usd(b.todayUsd)), el('td', {}, b.limitUsd ? usd(b.limitUsd) : 'not set')))),
        el('p', { class: 'muted' }, 'Provider spend this month: OpenRouter ' + usd(f.providerSpend.openrouterUsd) + ', fal.ai ' + usd(f.providerSpend.falUsd) + '. Change the limits in Table Editor → keo_settings.')),
      el('div', { class: 'card' }, el('h2', {}, 'Alerts'), f.alerts.length
        ? el('table', {}, f.alerts.map((a) => el('tr', {}, el('td', { class: 'muted' }, new Date(a.created_at).toLocaleString()), el('td', { class: a.kind.startsWith('breaker') ? 'bad' : 'warn' }, a.message))))
        : el('p', { class: 'muted' }, 'No alerts.')),
    );
  }

  async function users(q) {
    const search = el('input', { type: 'search', placeholder: 'Find by email…', value: q || '' });
    const go = () => show('users', search.value.trim());
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    const r = await api('users' + (q ? '?q=' + encodeURIComponent(q) : ''));
    view(
      el('div', { class: 'row', style: 'margin-bottom:12px' }, search, el('button', { class: 'btn ghost', onclick: go }, 'Search')),
      el('div', { class: 'card' }, el('table', {},
        el('tr', {}, el('th', {}, 'Email'), el('th', {}, 'Plan'), el('th', {}, 'Signed up'), el('th', {}, 'Today'), el('th', {}, 'Credits used / bought')),
        r.users.length ? r.users.map((u) => el('tr', { class: 'click', onclick: () => show('user', u.id) },
          el('td', {}, u.email || '(no email)', u.blocked ? el('span', { class: 'chip bad', style: 'margin-left:6px' }, 'blocked') : ''),
          el('td', {}, u.plan, u.plan_until ? el('span', { class: 'muted' }, ' until ' + new Date(u.plan_until).toLocaleDateString()) : ''),
          el('td', { class: 'muted' }, when(u.created_at)),
          el('td', {}, u.today.requests + ' req · $' + u.today.costUsd),
          el('td', {}, u.credits.usedThisMonth + ' / ' + u.credits.bought))) : el('tr', {}, el('td', { class: 'muted' }, 'No users found.')))),
    );
  }

  async function user(id) {
    const d = await api('users/' + id);
    const p = d.profile;
    const note = (msg) => { const n = el('p', { class: 'ok' }, msg); setTimeout(() => n.remove(), 4000); return n; };
    const credits = el('input', { type: 'number', min: 1, max: 100000, placeholder: 'Credits', style: 'width:110px' });
    const creditNote = el('input', { placeholder: 'Why (for the log)', style: 'flex:1;min-width:160px' });
    const topupBuilds = el('input', { type: 'number', min: 1, max: 1000, placeholder: 'Builds', style: 'width:110px' });
    const topupNote = el('input', { placeholder: 'Why (for the log)', style: 'flex:1;min-width:160px' });
    const planSel = el('select', {}, ['free', 'pro', 'creator', 'max'].map((x) => el('option', { value: x, selected: x === p.plan }, x)));
    const until = el('input', { type: 'date', value: p.plan_until ? p.plan_until.slice(0, 10) : '' });
    const actions = el('div', {});
    const act = async (fn, done) => { try { await fn(); actions.append(note(done)); setTimeout(() => show('user', id), 900); } catch (e) { actions.append(el('p', { class: 'bad' }, e.message)); } };
    view(
      el('p', {}, el('button', { class: 'btn ghost', onclick: () => show('users') }, '← Users')),
      el('div', { class: 'card' },
        el('h2', {}, p.email || '(no email)'),
        el('p', { class: 'muted' }, 'Signed up ' + when(p.created_at) + ' · plan ' + p.plan + (p.plan_until ? ' until ' + when(p.plan_until) : '') + (p.blocked ? ' · BLOCKED' : '')),
        el('p', {}, 'Studio credits: ' + d.credits.usedThisMonth + ' used this month · ' + d.credits.bought + ' bought (left over)'),
        el('div', { class: 'row' }, credits, creditNote, el('button', { class: 'btn', onclick: () => act(() => post('users/' + id + '/credits', { amount: Number(credits.value), note: creditNote.value }), 'Credits given.') }, 'Give credits')),
        el('div', { class: 'row', style: 'margin-top:10px' }, topupBuilds, topupNote, el('button', { class: 'btn', title: 'Extra AI allowance, measured in builds on Keo Strong; used after the plan’s allowance', onclick: () => act(() => post('users/' + id + '/topup', { builds: Number(topupBuilds.value), note: topupNote.value }), 'AI top-up given.') }, 'Give AI top-up')),
        el('div', { class: 'row', style: 'margin-top:10px' }, el('span', {}, 'Plan'), planSel, el('span', {}, 'until'), until,
          el('button', { class: 'btn ghost', onclick: () => act(() => post('users/' + id + '/plan', { plan: planSel.value, until: until.value ? until.value + 'T23:59:59Z' : null }), 'Plan changed.') }, 'Set plan')),
        el('div', { class: 'row', style: 'margin-top:10px' },
          p.blocked
            ? el('button', { class: 'btn ghost', onclick: () => act(() => post('users/' + id + '/block', { blocked: false }), 'Unblocked.') }, 'Unblock')
            : el('button', { class: 'btn danger', onclick: () => confirm('Block ' + (p.email || 'this user') + '? They cannot use Keo’s AI until unblocked.') && act(() => post('users/' + id + '/block', { blocked: true }), 'Blocked.') }, 'Block account')),
        actions),
      el('div', { class: 'card' }, el('h2', {}, 'Usage (last 30 days)'), el('table', {}, el('tr', {}, ['Day', 'Requests', 'Tokens in / out', 'Cost', 'Searches', 'Pictures'].map((h) => el('th', {}, h))),
        d.usage.map((x) => el('tr', {}, el('td', {}, x.day), el('td', {}, x.requests), el('td', {}, x.input_tokens + ' / ' + x.output_tokens), el('td', {}, '$' + Number(x.cost_usd).toFixed(3)), el('td', {}, x.web_searches), el('td', {}, x.images))))),
      el('div', { class: 'card' }, el('h2', {}, 'Studio jobs'), el('table', {}, el('tr', {}, ['When', 'Model', 'Credits', 'Status'].map((h) => el('th', {}, h))),
        d.jobs.map((j) => el('tr', {}, el('td', { class: 'muted' }, when(j.created_at)), el('td', {}, j.endpoint), el('td', {}, j.credits), el('td', {}, j.status))))),
      el('div', { class: 'card' }, el('h2', {}, 'Payments'), el('table', {}, el('tr', {}, ['When', 'What', 'Amount', 'Status'].map((h) => el('th', {}, h))),
        d.payments.map((x) => el('tr', {}, el('td', { class: 'muted' }, when(x.paid_at || x.created_at)), el('td', {}, x.plan || (x.credits ? x.credits + ' credits' : '—')), el('td', {}, x.currency + ' ' + (x.amount / 100).toLocaleString()), el('td', {}, x.status))))),
      el('div', { class: 'card' }, el('h2', {}, 'Problem reports'), d.reports.length ? el('table', {}, d.reports.map((x) => el('tr', { class: 'click', onclick: () => show('report', x.id) }, el('td', { class: 'muted' }, when(x.created_at)), el('td', {}, x.message.slice(0, 120)), el('td', {}, x.status)))) : el('p', { class: 'muted' }, 'None.')),
    );
  }

  async function reports(status) {
    const s = status || 'new';
    const r = await api('reports?status=' + s);
    view(
      el('div', { class: 'row', style: 'margin-bottom:12px' }, ['new', 'seen', 'fixed', 'closed', 'all'].map((x) => el('button', { class: 'btn ' + (x === s ? '' : 'ghost'), onclick: () => show('reports', x) }, x))),
      el('div', { class: 'card' }, r.reports.length ? el('table', {}, el('tr', {}, ['When', 'Who', 'Keo', 'What happened', 'Status'].map((h) => el('th', {}, h))),
        r.reports.map((x) => el('tr', { class: 'click', onclick: () => show('report', x.id) }, el('td', { class: 'muted' }, when(x.created_at)), el('td', {}, x.email || '—'), el('td', {}, x.version), el('td', {}, x.message.slice(0, 140)), el('td', {}, x.status)))) : el('p', { class: 'muted' }, 'No ' + (s === 'all' ? '' : s + ' ') + 'reports.')),
    );
  }

  async function report(id) {
    const x = await api('reports/' + id);
    const set = async (status) => { await post('reports/' + id, { status }); show('report', id); };
    view(
      el('p', {}, el('button', { class: 'btn ghost', onclick: () => show('reports') }, '← Reports')),
      el('div', { class: 'card' },
        el('h2', {}, 'From ' + (x.email || 'unknown') + ' · Keo ' + x.version),
        el('p', { class: 'muted' }, when(x.created_at) + ' · status: ' + x.status),
        el('p', {}, x.message),
        el('div', { class: 'row', style: 'margin:10px 0' }, ['seen', 'fixed', 'closed', 'new'].map((st) => el('button', { class: 'btn ' + (st === x.status ? '' : 'ghost'), disabled: st === x.status, onclick: () => set(st).catch(failed) }, 'Mark ' + st))),
        el('pre', {}, x.report)),
    );
  }

  async function jobs() {
    const r = await api('jobs');
    view(el('div', { class: 'card' }, el('table', {}, el('tr', {}, ['When', 'Who', 'Model', 'Credits', 'Status'].map((h) => el('th', {}, h))),
      r.jobs.map((j) => el('tr', {}, el('td', { class: 'muted' }, when(j.created_at)), el('td', {}, j.email || '—'), el('td', {}, j.endpoint), el('td', {}, j.credits), el('td', { class: j.status === 'refunded' ? 'warn' : '' }, j.status))))));
  }

  async function actions() {
    const r = await api('actions');
    view(el('div', { class: 'card' }, r.actions.length ? el('table', {}, el('tr', {}, ['When', 'Admin', 'Action', 'User', 'Detail'].map((h) => el('th', {}, h))),
      r.actions.map((a) => el('tr', {}, el('td', { class: 'muted' }, when(a.at)), el('td', {}, a.admin_email), el('td', {}, a.action), el('td', {}, a.target_email || '—'), el('td', { class: 'muted' }, JSON.stringify(a.detail))))) : el('p', { class: 'muted' }, 'Nothing changed yet.')));
  }

  if (session) start(); else showSignin();
})();
</script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; connect-src 'self' ${env.SUPABASE_URL}; img-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
    },
  });
}
