/**
 * Keo's Terms of Service, Privacy Policy and Refund Policy, served by Keo Cloud (/terms, /privacy,
 * /refunds). The support address comes from KEO_SUPPORT_EMAIL (wrangler.toml or Cloudflare →
 * Settings → Variables); until it is set the pages say it is coming soon.
 */

const UPDATED = '26 November 2026';

type Kind = 'terms' | 'privacy' | 'refunds';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function contact(email: string | undefined): string {
  return email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
    ? `<a href="mailto:${esc(email)}">${esc(email)}</a>`
    : 'Keo support (the support email address is coming soon)';
}

function body(kind: Kind, email: string | undefined): { title: string; html: string } {
  const mail = contact(email);
  if (kind === 'refunds')
    return {
      title: 'Refund and Cancellation Policy',
      html: `
<p>Keo’s paid plans (Pro, Creator and Max) are monthly subscriptions paid with Paystack. AI top-ups and Studio credit packs are one-off payments.</p>
<h2>Cancelling</h2>
<ul>
  <li>You can cancel any time: Keo → Settings → Providers → Keo account → <strong>Manage plan</strong> → <strong>Cancel renewal</strong>.</li>
  <li>After you cancel, your plan is not charged again. You keep it until the end of the month you already paid for, then your account moves to the Free plan. Your conversations and data on your computer are not affected.</li>
</ul>
<h2>Refunds</h2>
<ul>
  <li><strong>Payments are not refunded</strong>, including for unused time, unused allowances, unused top-ups or credits, or the rest of a month after you cancel.</li>
  <li>If you were charged by mistake — for example charged twice for the same month, or charged after you cancelled — tell us at ${mail} with the payment date and amount, and we will correct it and return the wrong charge.</li>
  <li>This policy does not take away any rights you have under the consumer protection law that applies to you (for example Nigeria’s Federal Competition and Consumer Protection Act). Where the law requires a refund, we will give it.</li>
</ul>
<h2>Failed payments</h2>
<p>If a monthly payment fails (for example an expired card), Keo shows it in the app and on the plans page. Update your card with <strong>Manage plan</strong> → <strong>Update card</strong>. If it is not paid, your plan ends when the paid month runs out.</p>
<h2>Price changes</h2>
<p>We may change plan prices. A new price applies from your next renewal after we have told you about it, and you can cancel before then.</p>`,
    };
  if (kind === 'privacy')
    return {
      title: 'Privacy Policy',
      html: `
<p>Keo is an AI assistant that runs on your Windows computer. This policy explains what stays on your computer, what passes through Keo’s online service (“Keo Cloud”), and who else is involved.</p>
<h2>What stays on your computer</h2>
<ul>
  <li>Your conversations, Keo’s memory of you, projects, tasks, files Keo works with, and your settings are stored on your PC, not on Keo’s servers.</li>
  <li>Passwords and keys you give Keo (email app passwords, your own AI provider keys, connected accounts) are encrypted with Windows and stay on your PC.</li>
  <li>Keo only works in your apps, reads your screen or files, or sends messages when you have turned that on, and it asks before actions unless you chose otherwise.</li>
</ul>
<h2>Your Keo account</h2>
<p>When you create a Keo account we store, in our account database (Supabase):</p>
<ul>
  <li>your email address and a securely hashed password (we never see your password);</li>
  <li>your plan, until when it is paid, and its renewal status;</li>
  <li>daily usage counts: number of AI requests, tokens, web searches, pictures and voice seconds, and what the AI service charged us — so we can apply your plan’s limits;</li>
  <li>payment records: plan, amount, currency, date and Paystack’s references for the payment, customer and subscription.</li>
</ul>
<p>We do <strong>not</strong> store the content of your conversations, searches, pictures or recordings.</p>
<h2>What passes through Keo Cloud</h2>
<p>When you use Keo’s AI with your Keo account, what Keo needs to answer you passes through Keo Cloud (hosted by Cloudflare) to the AI model, and back:</p>
<ul>
  <li><strong>Messages</strong> you send, the conversation so far, and things you or Keo add to them (attached pictures or document text, results from Keo’s tools, web pages Keo read for you). These go through OpenRouter to the company that runs the chosen AI model (for example OpenAI, Google or Anthropic).</li>
  <li><strong>Web searches</strong> through Keo Search go through OpenRouter to its search partner (for example Exa).</li>
  <li><strong>Pictures, video, music, sound and 3D models</strong> you ask Keo to make or change, with your description and the pictures or clips being changed. These go to fal.ai and the model it runs.</li>
  <li><strong>Voice</strong>: text Keo reads aloud with Keo’s voice, and recordings you choose to send for speech-to-text.</li>
</ul>
<p>Keo Cloud passes these on and does not keep them. OpenRouter and the AI companies handle them under their own privacy terms and may keep them for a limited time, for example for safety and abuse monitoring.</p>
<p>If you use your own AI provider key instead of a Keo account, your messages go directly from your computer to that provider, not through Keo Cloud.</p>
<h2>Payments</h2>
<p>Payments are handled by Paystack. You type your card details into Paystack’s secure checkout; Keo never sees or stores your card number. Paystack tells us whether a payment succeeded, the amount and plan, and its references.</p>
<h2>Who we work with</h2>
<ul>
  <li><strong>Supabase</strong> — Keo accounts and the account database.</li>
  <li><strong>Cloudflare</strong> — hosts Keo Cloud.</li>
  <li><strong>OpenRouter</strong> and the AI model companies it connects to — AI answers, search, pictures and voice.</li>
  <li><strong>fal.ai</strong> and the models it runs — pictures, video, music, sound and 3D.</li>
  <li><strong>Paystack</strong> — payments.</li>
  <li><strong>Resend</strong> — sends Keo’s account emails.</li>
  <li><strong>Google, Microsoft and others</strong> — only if you connect your own email or calendar to Keo; those connections run from your computer.</li>
</ul>
<p>We do not sell your personal information, and we do not use your conversations to train AI models.</p>
<h2>How long we keep it</h2>
<p>We keep your account details while you have an account. Usage and payment records are kept as long as needed for billing, accounting and the law. When you ask us to delete your account, we delete your account details; payment records the law requires us to keep are kept for that time only.</p>
<h2>Your rights</h2>
<p>You can ask to see, correct or delete the personal information we hold about you, or object to how we use it — including under Nigeria’s Data Protection Act 2023 and, where it applies, the GDPR. Contact ${mail}.</p>
<h2>Children</h2>
<p>Keo is not meant for children under 13, and paid plans are for adults (or with a parent’s or guardian’s permission).</p>
<h2>Security</h2>
<p>Connections to Keo Cloud are encrypted, keys that let Keo Cloud work stay in Cloudflare and are never sent to the app, and only Keo Cloud can change plans or usage in the account database.</p>
<h2>Changes</h2>
<p>If we change this policy, we update this page and its date; for important changes we tell you in Keo.</p>`,
    };
  return {
    title: 'Terms of Service',
    html: `
<p>These terms apply when you use Keo — the desktop app and its online service, Keo Cloud — and when you create a Keo account. By using Keo you agree to them.</p>
<h2>1. What Keo is</h2>
<p>Keo is an AI assistant for your Windows computer. It can chat, research, remember what you tell it, and — only when you allow it — work in your apps and files. Its answers come from AI models provided by other companies through Keo Cloud, or through your own AI provider key.</p>
<h2>2. Your account</h2>
<ul>
  <li>Give a real email address you can access, keep your password safe, and use your account only for yourself.</li>
  <li>You are responsible for what happens with your account. Tell us at ${mail} if you think someone else is using it.</li>
</ul>
<h2>3. Plans and payment</h2>
<ul>
  <li>Keo has a Free plan and paid monthly plans (Pro, Creator and Max). Each plan has a monthly AI allowance, Studio credits and a set of AI models, shown on the plans page.</li>
  <li>The AI allowance renews each month from the day you paid. So that it lasts the whole month, at most part of it can be used in one day or one week; those daily and weekly shares reset at 00:00 UTC (weeks start on Monday). A task that is already under way is allowed to finish within the month’s allowance even if today’s or this week’s share runs out on the way.</li>
  <li>When an allowance is used up, Keo pauses and keeps your work; it continues when the allowance renews, or straight away with an AI top-up or a higher plan.</li>
  <li>AI top-ups add more AI allowance without changing plan. A top-up is used only after your plan’s allowance, works with the models your plan includes, and never expires.</li>
  <li>Studio credits pay for Keo Studio’s AI (for example AI clips and character voices) and never pay for chat. Your plan’s credits renew every month and unused ones do not carry over; credits you buy never expire and are used after your plan’s credits.</li>
  <li>Paid plans renew automatically every month and are charged to your card through Paystack until you cancel. AI top-ups and credit packs are one-off payments. Prices are shown in your currency before you pay.</li>
  <li>You can cancel any time; you keep your plan until the end of the month you paid for. Payments are not refunded — see the <a href="/refunds">Refund Policy</a>.</li>
  <li>We may change plans, allowances or prices; changes to what you pay apply from your next renewal after we have told you.</li>
</ul>
<h2>4. Fair use</h2>
<p>Don’t use Keo to break the law or hurt others; to send spam or harass people; to get around plan limits or security (for example by sharing, reselling or automating access to your account); to attack or overload Keo Cloud; or to produce content that sexualises minors, promotes violence, or infringes others’ rights. The AI model companies’ own usage rules also apply. We may limit, suspend or close an account that breaks these rules.</p>
<h2>5. Actions on your computer</h2>
<p>Keo can work in your apps, send messages or change files only with the permissions you give it, and it asks before actions unless you chose a setting that lets it act on its own. You are responsible for the actions you approve or allow. Keep your own backups of important files.</p>
<h2>6. AI answers</h2>
<p>AI can be wrong, out of date or incomplete. Check important information yourself — especially anything about health, money, law or safety. Keo’s answers are not professional advice.</p>
<h2>7. Your content</h2>
<p>What you write and create with Keo is yours. You give us only the permission needed to pass it to the AI services that answer you, as described in the <a href="/privacy">Privacy Policy</a>.</p>
<h2>8. Other services</h2>
<p>Keo works with other services (AI models, web search, Paystack, your email or calendar provider, websites Keo visits for you). Their own terms apply, and we are not responsible for them.</p>
<h2>9. Availability and changes</h2>
<p>We work to keep Keo running well, but it is provided “as is” and may sometimes be unavailable or change. We may update features and these terms; if we make important changes we tell you in Keo, and continuing to use Keo means you accept them.</p>
<h2>10. Liability</h2>
<p>As far as the law allows, Keo is not liable for indirect or consequential losses, lost data or lost profits, and our total liability to you is limited to what you paid us in the three months before the claim. Nothing in these terms limits rights you have under consumer protection law that cannot be limited.</p>
<h2>11. Ending</h2>
<p>You can stop using Keo and ask us to delete your account at any time. We may close accounts that break these terms; if we close a paid account without a good reason, we refund the unused part of the month.</p>
<h2>12. Law</h2>
<p>These terms are governed by the laws of the Federal Republic of Nigeria, without affecting the mandatory consumer rights of the country you live in.</p>
<h2>13. Contact</h2>
<p>Questions about these terms: ${mail}.</p>`,
  };
}

export function legalPage(kind: Kind, env: { KEO_SUPPORT_EMAIL?: string }): Response {
  const { title, html } = body(kind, env.KEO_SUPPORT_EMAIL);
  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Keo ${esc(title)}</title>
<style>
  :root { color-scheme: dark; --bg: #050505; --line: #262626; --text: #ececec; --muted: #9b9b9b; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.65 "Segoe UI", system-ui, sans-serif; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 32px 16px 64px; }
  .logo { display: flex; align-items: center; gap: 10px; font-weight: 700; letter-spacing: 0.14em; margin-bottom: 28px; }
  .eyes { width: 34px; height: 34px; border-radius: 10px; background: #fff; display: flex; align-items: center; justify-content: center; gap: 5px; }
  .eyes i { width: 6px; height: 9px; border-radius: 3px; background: #050505; }
  h1 { font-size: 30px; margin: 0 0 4px; }
  .date { color: var(--muted); margin: 0 0 28px; }
  h2 { font-size: 19px; margin: 30px 0 8px; }
  p, li { color: #d4d4d4; }
  ul { padding-left: 22px; }
  a { color: #fff; }
  nav { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 40px; padding-top: 18px; border-top: 1px solid var(--line); color: var(--muted); font-size: 14px; }
  nav a { color: var(--muted); }
</style>
</head>
<body>
<div class="wrap">
  <div class="logo"><span class="eyes"><i></i><i></i></span>KEO</div>
  <h1>${esc(title)}</h1>
  <p class="date">Last updated ${UPDATED}</p>
  ${html}
  <nav><a href="/terms">Terms of Service</a><a href="/privacy">Privacy Policy</a><a href="/refunds">Refund Policy</a><a href="/upgrade">Plans</a></nav>
</div>
</body>
</html>`;
  return new Response(page, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}
