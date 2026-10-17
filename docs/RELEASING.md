# Releasing Keo

Keo is distributed as a Windows installer on **GitHub Releases**, with a download page on **GitHub Pages** (`site/`). Users need no account; they bring their own AI key. Installed copies check GitHub once a day and show *Update available* when a newer release exists (users can turn this off).

## One-time setup

1. Create the GitHub repository `BlessedLoner/keo` (public, so its releases and page are downloadable).
   - Before the first push, decide which email appears on commits: everything you push is public. To use GitHub's private address, set `git config user.email <id>+BlessedLoner@users.noreply.github.com` (find it under GitHub → Settings → Emails).
   - Decide the licence. Without a `LICENSE` file the code is *all rights reserved*: people may download and use the app, but not reuse the code.
2. Push: `git remote add origin https://github.com/BlessedLoner/keo.git` then `git push -u origin main`.
3. GitHub → repository **Settings → Pages → Build and deployment → Source: GitHub Actions**. The *Download page* workflow then publishes `site/` to `https://blessedloner.github.io/keo/`.

If the repository or owner name differs, change `RELEASE` in `src/shared/release.ts`, the links in `site/*.html`, and `homepage`/`repository` in `package.json`.

## Every release

1. Bump `version` in `package.json` (and the two version fields at the top of `package-lock.json`), e.g. `1.0.1`.
2. Run `npm run check` and `npm run smoke` locally (optionally `npm run e2e:desktop`).
3. Commit, then tag and push the tag:
   ```bash
   git tag v1.0.1
   git push origin main v1.0.1
   ```
4. The *Release* workflow (Windows runner) checks that the tag matches `package.json`, runs typecheck, lint and tests, builds `Keo-Setup-1.0.1.exe`, and publishes it as a GitHub Release with notes, together with `latest.yml` and `Keo-Setup-1.0.1.exe.blockmap`. The download page links to it automatically; installed copies (1.1.0 and later) download it in the background within a day and install it when Keo closes. Copies older than 1.1.0 only show an *Update available* chip, so their users install 1.1.0 once by hand.

Do not mark releases as *pre-release*: the update check and the download button read GitHub's "latest release", which skips pre-releases.

## Later (v2.1 and beyond)

- **Code signing** removes the *Windows protected your PC* warning: add the certificate as repository secrets and sign in the release workflow.
- **Accounts and payments**: needs a hosted backend, a privacy policy update and terms of use.
