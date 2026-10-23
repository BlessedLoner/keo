/**
 * Server presets for the email account form (Settings → Email & calendar).
 * Shared by the renderer (to fill the form) and the main process.
 */
export type EmailProvider = 'gmail' | 'outlook' | 'yahoo' | 'icloud' | 'custom';

export interface EmailServers {
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
}

export const EMAIL_PRESETS: Record<Exclude<EmailProvider, 'custom'>, EmailServers & { label: string }> = {
  gmail: { label: 'Gmail', imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true },
  outlook: { label: 'Outlook / Hotmail', imapHost: 'outlook.office365.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp-mail.outlook.com', smtpPort: 587, smtpSecure: false },
  yahoo: { label: 'Yahoo Mail', imapHost: 'imap.mail.yahoo.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465, smtpSecure: true },
  icloud: { label: 'iCloud Mail', imapHost: 'imap.mail.me.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.mail.me.com', smtpPort: 587, smtpSecure: false },
};

/** Guess the provider from the address, for the form's first suggestion. */
export function providerFor(address: string): EmailProvider {
  const domain = address.split('@')[1]?.toLowerCase() ?? '';
  if (domain === 'gmail.com' || domain === 'googlemail.com') return 'gmail';
  if (/^(outlook|hotmail|live|msn)\.[a-z.]+$/.test(domain)) return 'outlook';
  if (/^(yahoo|ymail|rocketmail)\.[a-z.]+$/.test(domain)) return 'yahoo';
  if (domain === 'icloud.com' || domain === 'me.com' || domain === 'mac.com') return 'icloud';
  return 'custom';
}
