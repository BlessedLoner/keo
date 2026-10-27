/**
 * Keo Cloud: where Keo accounts and Keo's own AI live (see cloud/README.md). These values are
 * public by design — the anon key only allows what the database's row-level security allows,
 * and every request to the gateway carries the user's own sign-in.
 */
export const KEO_CLOUD = {
  supabaseUrl: 'https://snacuyukgzizjqdwxexn.supabase.co',
  anonKey:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNuYWN1eXVrZ3ppempxZHd4ZXhuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMwMTg5NzYsImV4cCI6MjEwODU5NDk3Nn0.b86L_GmzwJJ6O_JYoJKOw0RKtv6r8cMgOrNL69BOjtU',
  gatewayUrl: 'https://keo-cloud.blessednoble90.workers.dev/v1',
  /** Where the links in Keo's account emails land (must be in Supabase → URL Configuration → Redirect URLs). */
  accountPageUrl: 'https://keo-cloud.blessednoble90.workers.dev/account',
} as const;

/** What the app shows about the signed-in Keo account. */
export interface AccountStatus {
  signedIn: boolean;
  email: string | null;
  /** Waiting for the user to confirm their email (after sign-up). */
  pendingEmail: string | null;
  plan: { id: string; name: string; dailyRequests: number; dailyTokens: number; features: Record<string, unknown> } | null;
  usage: { day: string; requests: number; inputTokens: number; outputTokens: number; webSearches: number; images: number; voiceSeconds: number } | null;
  /** Why plan/usage could not be read just now (offline, gateway not deployed yet…). */
  error: string | null;
}
