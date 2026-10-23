# Keo's Google client: one-time setup and verification (maintainer guide)

This is for **you, the publisher of Keo**, not for Keo's users. You do it once. Afterwards every
user of a Keo release only chooses **Settings → Email & calendar → Sign in with Google**.

How it fits together:

- Keo signs in with Google's flow for installed apps: the user's own browser, PKCE, and a one-time
  `127.0.0.1` redirect. Keo asks only for `calendar.events`.
- The release workflow bakes your client ID and secret into the installer from two **GitHub
  repository secrets** (`KEO_GOOGLE_CLIENT_ID`, `KEO_GOOGLE_CLIENT_SECRET`). They are never
  committed. For a *Desktop app* client Google does not treat the secret as confidential (it ships
  inside every installed app), but keeping it out of the public repo stops casual scraping.
- A user can still enter their own client in *Settings → Advanced*, and theirs takes precedence.
- Builds without the secrets (local builds, tests, forks) have no built-in client and show the
  old "use your own client" steps.

## Part 1 — Create the client (about 15 minutes)

Use a Google account you will keep for Keo; it becomes the app's owner.

1. **Project.** <https://console.cloud.google.com/projectcreate> → name `Keo` → Create. Keep it
   selected at the top of the page.
2. **Calendar API.** <https://console.cloud.google.com/apis/library/calendar-json.googleapis.com>
   → **Enable**.
3. **Branding** (Google Auth Platform, <https://console.cloud.google.com/auth/overview> → Get started,
   then **Branding**):
   - App name `Keo`, user support email, developer contact email.
   - App home page `https://blessedloner.github.io/keo/`.
   - Privacy policy `https://blessedloner.github.io/keo/privacy.html`. It now has a Google
     Calendar section with the Limited Use statement Google looks for.
   - Authorized domain `blessedloner.github.io`.
   - Logo: optional. Adding one triggers a brand review, so you can skip it at first.
4. **Audience:** *External*.
5. **Data access → Add or remove scopes:** add `https://www.googleapis.com/auth/calendar.events`
   only. It is a *sensitive* scope, which matters for verification below.
6. **Clients → Create client** → type **Desktop app**, name `Keo` → Create. Copy the **Client ID**
   (ends in `.apps.googleusercontent.com`) and the **Client secret** (starts with `GOCSPX-`). Desktop
   clients need no redirect URI; the `127.0.0.1` loopback is allowed automatically.
7. **GitHub secrets.** <https://github.com/BlessedLoner/keo/settings/secrets/actions> → **New
   repository secret**, twice:
   - `KEO_GOOGLE_CLIENT_ID` = the client ID
   - `KEO_GOOGLE_CLIENT_SECRET` = the client secret

   Don't paste either into chat, an issue or a commit.
8. **Publish the app:** Audience → **Publish app** (status *In production*). This ends the 7-day
   sign-in limit that apps in *Testing* have. Until Google verifies the app (Part 2), users see
   *"Google hasn't verified this app"* and must choose *Advanced → Go to Keo (unsafe)*, and at
   most **100 users** can sign in.

The next tagged release then contains the client. To try it on your PC first, build locally with
the two values set only in that terminal (for example
`$env:KEO_GOOGLE_CLIENT_ID='…'; $env:KEO_GOOGLE_CLIENT_SECRET='…'; npm run package:win`).

## Part 2 — Verification (removes the warning and the 100-user cap)

`calendar.events` is **sensitive**, not *restricted*. So verification is free and needs no paid
security assessment; only Gmail's restricted scopes need one, which is why Keo uses IMAP with an
app password for mail. Google usually takes a few days to a few weeks. Start it from Google Auth
Platform → **Verification centre**.

What Google will check, and what to have ready:

1. **Domain ownership.** Verify `https://blessedloner.github.io/keo/` in Google Search Console
   (<https://search.google.com/search-console>). Choose a *URL prefix* property and the *HTML tag*
   method, and send me the `<meta name="google-site-verification" …>` tag: I'll add it to
   `site/index.html`. Use the same Google account as the Cloud project.
   - If Google refuses a `github.io` address, a custom domain pointed at GitHub Pages solves it
     (about $10 a year). Then update the home page and privacy URLs.
2. **Home page.** It must describe Keo and link to the privacy policy. The site already does both.
3. **Privacy policy.** It must say what Google data Keo uses, why, where it goes, and how to remove
   access, and include the Limited Use statement. `site/privacy.html` has all of this.
4. **Scope justification** (text box). For example: *"Keo is a desktop assistant. With the user's
   request it lists their events, finds free time, and, after the user approves each change,
   creates, updates or deletes events (optionally with invitees and a Meet link). calendar.events
   is the narrowest scope that allows creating and changing events; Keo does not request
   full calendar or other Google data."*
5. **Demo video** (an unlisted YouTube link). Record a short screen capture in English showing:
   - Keo's Settings → Sign in with Google
   - the Google consent screen, with the **client ID visible in the browser address bar** (Google
     asks for this) and the calendar permission
   - Keo listing events
   - Keo asking for approval and then creating an event
   - Sign out
6. Answer Google's follow-up emails promptly. They often ask for small wording changes on the
   privacy page.

Once verified, the warning screen and the user cap go away. Nothing changes in Keo itself.

## If something goes wrong

- **`invalid_client` when signing in.** The secrets in GitHub don't match the Desktop client.
  Re-copy them, then publish a new release.
- **`access_denied` / "app is being tested".** The app is still in *Testing* and the user isn't a
  test user. Publish it (Part 1, step 8).
- **Sign-in ends after 7 days.** The app is still in *Testing*. Publish it.
- **Rotating the secret.** Create a new secret in Clients, update the GitHub secret, release.
  Users are asked to sign in again.
