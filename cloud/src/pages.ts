/**
 * The page Keo's account emails open (Supabase's Site URL points here): "email confirmed", an
 * expired link, or choosing a new password after "Forgot password?". Supabase puts the result in
 * the address after '#', which never reaches this server; the page reads it, clears it from the
 * address bar, and (for a new password) talks to Supabase directly with the user's one-time sign-in.
 */
export function accountPage(env: { SUPABASE_URL: string; SUPABASE_ANON_KEY: string }): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Keo account</title>
<style>
  :root { color-scheme: dark; --bg: #050505; --card: #101010; --line: #2a2a2a; --text: #f2f2f2; --muted: #9a9a9a; --ok: #7ee2a8; --bad: #ff8a8a; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text); font: 16px/1.5 "Segoe UI", system-ui, sans-serif; }
  main { width: min(440px, 100%); padding: 28px; border: 1px solid var(--line); border-radius: 16px; background: var(--card); }
  .logo { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; font-weight: 700; letter-spacing: 0.12em; }
  .eyes { width: 34px; height: 34px; border-radius: 10px; background: #fff; display: flex; align-items: center; justify-content: center; gap: 5px; }
  .eyes i { width: 6px; height: 9px; border-radius: 3px; background: #050505; }
  h1 { margin: 0 0 8px; font-size: 22px; }
  p { margin: 0 0 12px; color: var(--muted); }
  .ok { color: var(--ok); } .bad { color: var(--bad); }
  input { width: 100%; margin: 6px 0 12px; padding: 11px 12px; border: 1px solid var(--line); border-radius: 10px; background: #000; color: var(--text); font: inherit; }
  button { width: 100%; padding: 11px; border: 0; border-radius: 10px; background: #fff; color: #000; font: inherit; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <div class="logo"><span class="eyes"><i></i><i></i></span>KEO</div>
  <section id="done" hidden>
    <h1 class="ok">Your email is confirmed</h1>
    <p>Go back to Keo and sign in with your email and password. You can close this page.</p>
  </section>
  <section id="expired" hidden>
    <h1 class="bad">This link has expired</h1>
    <p id="expired-why">Links in Keo’s emails work once and only for a while.</p>
    <p>In Keo, try signing in. If Keo says to confirm your email first, create the account again with the same email to get a new link — or use “Forgot password?” for a new password link.</p>
  </section>
  <section id="reset" hidden>
    <h1>Choose a new password</h1>
    <p>For your Keo account. At least 8 characters.</p>
    <form id="reset-form">
      <input id="pw1" type="password" autocomplete="new-password" placeholder="New password" minlength="8" required>
      <input id="pw2" type="password" autocomplete="new-password" placeholder="The same password again" minlength="8" required>
      <button id="save" type="submit">Save new password</button>
    </form>
    <p id="reset-note" hidden></p>
  </section>
  <section id="plain" hidden>
    <h1>Keo account</h1>
    <p>This page opens from the links in Keo’s emails. To sign in or create an account, open the Keo app.</p>
  </section>
  <p style="margin-top:18px;font-size:13px"><a href="/terms" style="color:#9a9a9a">Terms</a> · <a href="/privacy" style="color:#9a9a9a">Privacy</a> · <a href="/refunds" style="color:#9a9a9a">Refunds</a></p>
</main>
<script>
(function () {
  var SUPABASE = ${JSON.stringify(env.SUPABASE_URL)};
  var ANON = ${JSON.stringify(env.SUPABASE_ANON_KEY)};
  var q = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
  // The one-time sign-in must not stay in the address bar or the history.
  history.replaceState(null, '', location.pathname);
  var show = function (id) { document.getElementById(id).hidden = false; };
  var error = q.get('error_description') || q.get('error');
  if (error) {
    document.getElementById('expired-why').textContent = 'Keo’s account service said: ' + error.replace(/\\+/g, ' ') + '.';
    return show('expired');
  }
  var token = q.get('access_token');
  if (token && q.get('type') === 'recovery') {
    show('reset');
    var form = document.getElementById('reset-form');
    var note = document.getElementById('reset-note');
    var say = function (text, ok) { note.hidden = false; note.className = ok ? 'ok' : 'bad'; note.textContent = text; };
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var a = document.getElementById('pw1').value, b = document.getElementById('pw2').value;
      if (a.length < 8) return say('Choose at least 8 characters.', false);
      if (a !== b) return say('The two passwords are not the same.', false);
      var btn = document.getElementById('save');
      btn.disabled = true;
      fetch(SUPABASE + '/auth/v1/user', { method: 'PUT', headers: { apikey: ANON, authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ password: a }) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (r) {
          if (r.ok) { form.hidden = true; return say('Saved. Go back to Keo and sign in with your new password.', true); }
          btn.disabled = false;
          say((r.j && (r.j.msg || r.j.message)) || 'That did not work. Ask Keo for a new link with “Forgot password?”.', false);
        })
        .catch(function () { btn.disabled = false; say('Could not reach Keo’s account service. Check your internet connection and try again.', false); });
    });
    return;
  }
  if (token || q.get('type') === 'signup' || q.get('type') === 'email_change') return show('done');
  show('plain');
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
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src ${env.SUPABASE_URL}; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
    },
  });
}
