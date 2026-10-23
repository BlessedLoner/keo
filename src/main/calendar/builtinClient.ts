/**
 * The Google OAuth client Keo ships with, so users only choose "Sign in with Google".
 *
 * It is baked in at build time from the KEO_GOOGLE_CLIENT_ID / KEO_GOOGLE_CLIENT_SECRET
 * environment variables (GitHub Actions secrets for releases) and never committed. For a
 * Google "Desktop app" client the secret is not confidential — Google expects it inside the
 * installed app — but it stays out of the public repo. Builds without them (tests, local
 * builds) have no built-in client; a client ID in Settings always takes precedence.
 */
declare const __KEO_GOOGLE_CLIENT_ID__: string | undefined;
declare const __KEO_GOOGLE_CLIENT_SECRET__: string | undefined;

export interface GoogleClient {
  id: string;
  secret: string | null;
}

export function builtinGoogleClient(): GoogleClient | null {
  const id = typeof __KEO_GOOGLE_CLIENT_ID__ === 'string' ? __KEO_GOOGLE_CLIENT_ID__.trim() : '';
  const secret = typeof __KEO_GOOGLE_CLIENT_SECRET__ === 'string' ? __KEO_GOOGLE_CLIENT_SECRET__.trim() : '';
  if (!/^[A-Za-z0-9-]+\.apps\.googleusercontent\.com$/.test(id)) return null;
  return { id, secret: secret || null };
}
