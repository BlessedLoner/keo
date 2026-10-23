# Email and calendar in Keo

Keo works with your mail and calendar **directly**, through your mail server and Google's Calendar API, not by clicking around Gmail or Outlook in a browser. Both are set up in **Settings → Email & calendar** and both are optional.

| You want Keo to… | You need |
|---|---|
| Check new mail, search, read and summarise conversations, write drafts, reply and send | An **email account** connected with an **app password** (part 1) |
| Book appointments and meetings in Google Calendar, find free time, add Google Meet links | **Sign in with Google** for Google Calendar (part 2) |
| Set a meeting without Google Calendar | Only the email account: Keo emails a standard calendar invitation (`.ics`) |

What always asks you first, whatever your approval level: **sending, replying, email invitations, inviting people to calendar events and deleting events**. The approval card shows the exact recipients (To, Cc, Bcc), the subject and the full text. Reading your mail and calendar happens without asking once you have connected them, and only when you ask Keo something that needs it. Email and invitations are written by other people, so Keo treats their content as information only and never follows instructions inside them.

---

## Part 1 — Connect an email account (IMAP/SMTP + app password)

Keo signs in to your mail server with an **app password**: a separate password your provider generates for one app, which you can revoke at any time without changing your real password. Keo stores it encrypted with Windows (DPAPI), uses it only to sign in to your own mail servers, never shows it again, and never puts it in logs or in anything sent to the AI model.

### Gmail

1. Turn on **2-Step Verification** for your Google account: <https://myaccount.google.com/signinoptions/twosv>. App passwords are only offered with 2-Step Verification on.
2. Open **App passwords**: <https://myaccount.google.com/apppasswords>. Type a name such as `Keo` and choose **Create**.
3. Copy the 16-letter password Google shows (spaces don't matter).
4. In Keo: **Settings → Email & calendar → Email account**. Enter your Gmail address, choose **Gmail** (the servers are filled in: `imap.gmail.com:993`, `smtp.gmail.com:465`), paste the app password and choose **Save and test**.

Notes: IMAP is always on for Gmail. Work or school Google accounts may have app passwords turned off by their administrator. If you later turn off 2-Step Verification, Google deletes your app passwords and Keo will say the login was refused.

### Outlook.com / Hotmail

Turn on two-step verification for your Microsoft account, create an app password under *Security → Advanced security options* (<https://account.live.com/proofs/AppPassword>), then choose **Outlook / Hotmail** in Keo (`outlook.office365.com:993`, `smtp-mail.outlook.com:587` with STARTTLS).

Microsoft is phasing out app-password sign-in for Outlook.com. If the login is refused even with a fresh app password, your account requires Microsoft's own sign-in (OAuth), which Keo does not support yet.

### Yahoo Mail

Account security → **Generate app password** (<https://login.yahoo.com/account/security/app-passwords>), name it `Keo`, then choose **Yahoo Mail** in Keo.

### iCloud Mail

Sign in to your Apple Account → *Sign-In and Security* → **App-Specific Passwords** (<https://account.apple.com/account/manage>), create one for `Keo`, and use your `@icloud.com` address with the **iCloud Mail** preset.

### Other providers

Choose **Other** and enter the IMAP and SMTP servers your provider lists. Keo only connects encrypted: IMAP with TLS (usually port 993); SMTP with TLS (465) or STARTTLS (587) — with STARTTLS Keo refuses to continue if the server does not upgrade to TLS.

### What Keo can then do

- **“Check my email” / “any new mail?”** — lists the newest unread messages (sender, subject, date, a short snippet). Listing does not mark anything as read.
- **“Find the email from Sam about the invoice”** — searches your inbox (or Sent) by words, sender, recipient, subject and date.
- **“Summarise that thread”** — reads a message and the rest of its conversation, including your own sent replies.
- **“Draft a reply…”** — Keo writes the text with you; *Save a draft* puts it in your Drafts folder (asks first, nothing is sent).
- **“Send it” / “reply to Alice”** — always asks first, showing exactly who receives it, the subject and the text. Replies stay in the same conversation (Keo sets the `In-Reply-To` and `References` headers and a `Re:` subject).
- **New-mail notifications** (off by default) — *Settings → Email & calendar → New mail*: Keo looks every few minutes (default 10) and shows a Windows notification such as “2 new emails from Alice, Bob”. Mail that was already unread when Keo started is not announced. Only the sender and subject are shown on your PC; nothing goes to the AI model until you ask.

Keo does not keep a copy of your mailbox. Messages it reads in a conversation are part of that conversation (and go to your active AI provider to answer you), like anything else you discuss with Keo.

To disconnect, choose **Disconnect** (the app password is deleted from Keo). To be thorough, also revoke the app password at your provider.

---

## Part 2 — Google Calendar (“Sign in with Google”)

Keo uses Google's standard sign-in for installed apps: your **own browser** opens Google's sign-in page; Keo never sees your Google password. Keo asks only for the `calendar.events` permission (see and change events in your calendars) — not Gmail, contacts, Drive or your profile. The sign-in is stored encrypted with Windows (DPAPI).

**Keo releases include Keo's own Google client**, so all you do is choose **Sign in with Google** in *Settings → Email & calendar*, pick your account in the browser and allow calendar access. Until Google has verified Keo, Google shows *"Google hasn't verified this app"*: choose *Advanced → Go to Keo*. (How the publisher sets this up: [GOOGLE_CLIENT_SETUP.md](GOOGLE_CLIENT_SETUP.md).)

The steps below are only needed for a build without the built-in client (a local or forked build), or if you prefer your own Google Cloud client. *Settings → Advanced: use your own Google Cloud client* — your client then takes precedence. Nothing is billed.

### One-time setup (own client only)

1. **Create a project.** Go to <https://console.cloud.google.com/projectcreate>, name it `Keo`, create it, and make sure it is selected at the top of the page.
2. **Turn on the Google Calendar API.** Open <https://console.cloud.google.com/apis/library/calendar-json.googleapis.com> and choose **Enable**.
3. **Set up the consent screen** (Google Auth Platform, <https://console.cloud.google.com/auth/overview>) → **Get started**:
   - App name `Keo`, your email as support and developer contact.
   - **Audience: External.**
   - Under **Audience → Test users**, add your own Google address (the one whose calendar Keo should use).
   - Under **Data access → Add or remove scopes**, add `https://www.googleapis.com/auth/calendar.events` and save.
4. **Create the client.** Open **Clients** (<https://console.cloud.google.com/auth/clients>) → **Create client** → Application type **Desktop app**, name `Keo`, **Create**. Copy the **Client ID** (it ends in `.apps.googleusercontent.com`). If Google also shows a **client secret**, copy it too.
5. **In Keo:** *Settings → Email & calendar → Google Calendar*: paste the client ID (and the client secret, if you have one; it is stored encrypted), then choose **Sign in with Google**.
6. Your browser opens Google's page. Google may say *“Google hasn't verified this app”* — it is your own app, so choose **Continue**. Tick the calendar permission and allow. The page then says *“Keo is connected”*; you can close the tab.

### The 7-day sign-in limit (“Testing” status)

While your Google app's publishing status is **Testing**, Google ends the sign-in after **7 days**. Keo then says: *“Your Google sign-in has expired … Sign in again in Settings → Email & calendar.”* Choose **Sign in again**; nothing else is lost.

To stop that, publish the app: Google Auth Platform → **Audience → Publish app**. For an app used only by you, Google does not require verification; you may still see the *unverified app* warning when signing in.

### What Keo can then do

- **“What's on my calendar this week?”** — lists events (no approval).
- **“When am I free for an hour on Thursday?”** — finds free slots inside working hours (9:00–17:00 on weekdays unless you say otherwise); free or declined events don't block time.
- **“Book a dentist appointment Friday at 3”** — adds the event after you approve.
- **“Set a meeting with carol@example.com tomorrow at 10 with a Meet link”** — adds the event with Carol invited and a Google Meet link. Because Google emails an invitation to Carol, this always asks you first.
- **“Move / cancel that meeting”** — Keo changes or deletes only events it has shown you in the conversation; deleting always asks, and changing an event with other people invited always asks.

**Sign out** in the same card: Keo revokes the sign-in at Google and deletes it. You can also remove Keo at <https://myaccount.google.com/connections>.

### Without Google Calendar

With only an email account connected, Keo sets meetings by emailing a standard calendar invitation (`invite.ics`, `METHOD:REQUEST`), which Gmail, Outlook and Apple Calendar show with Accept/Decline buttons. Sending it always asks first and shows the exact recipients, subject and text. The meeting is not added to your own calendar automatically.

---

## Troubleshooting

| Message | What to do |
|---|---|
| *The mail server refused the login* | Use an **app password**, not your normal password; check the address; for Gmail, 2-Step Verification must be on. |
| *Could not reach the mail server* | Check the server names and ports, your internet connection, and whether a firewall or antivirus blocks ports 993/465/587. |
| *Your mail server has no Drafts folder* | Your provider does not mark a Drafts folder; Keo cannot save drafts there. Sending still works. |
| *Google did not accept the client ID* | Copy the client ID again (Desktop app type); if Google gave a client secret, paste it as well. |
| *The Google Calendar API is not turned on* | Step 2 of the setup. |
| *Your Google sign-in has expired* | Sign in again (see the 7-day limit above). |
| *Keo was not given access to your calendar events* | Sign in again and tick the calendar permission on Google's page. |
