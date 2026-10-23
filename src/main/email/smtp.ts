import type { MailAccount } from './mailbox';

export interface SendResult {
  accepted: string[];
  rejected: string[];
}

/**
 * Hands one composed message to SMTP. The app uses nodemailer; tests inject a
 * fake (or nodemailer's offline stream transport), so no test sends mail.
 */
export interface MailSender {
  send(account: MailAccount, envelope: { from: string; to: string[] }, raw: Buffer): Promise<SendResult>;
  /** Logs in without sending anything (Settings → Test). */
  verify(account: MailAccount): Promise<void>;
}

/** SMTP errors raised before the message was handed over: nothing was sent. */
const NOT_SENT = new Set(['EAUTH', 'ECONNECTION', 'EDNS', 'ETLS', 'EENVELOPE', 'ENOAUTH', 'EOAUTH2']);

export class SmtpError extends Error {
  constructor(
    message: string,
    readonly notSent: boolean,
  ) {
    super(message);
  }
}

export function smtpFailure(e: unknown): SmtpError {
  const code = (e as { code?: string })?.code ?? '';
  const notSent = NOT_SENT.has(code);
  const message =
    code === 'EAUTH' || code === 'ENOAUTH'
      ? 'The mail server refused the login for sending. Check the app password.'
      : code === 'EENVELOPE'
        ? 'The mail server refused the recipients.'
        : code === 'ECONNECTION' || code === 'EDNS' || code === 'ETLS'
          ? 'Could not reach the outgoing mail server (check the server, port and your internet connection).'
          : 'The outgoing mail server failed while sending.';
  return new SmtpError(message, notSent);
}

export const smtpSender: MailSender = {
  async send(a, envelope, raw) {
    const nodemailer = await import('nodemailer');
    const t = nodemailer.createTransport(transportOptions(a));
    try {
      const info = await t.sendMail({ envelope, raw });
      return { accepted: info.accepted.map(addr), rejected: info.rejected.map(addr) };
    } catch (e) {
      throw smtpFailure(e);
    } finally {
      t.close();
    }
  },
  async verify(a) {
    const nodemailer = await import('nodemailer');
    const t = nodemailer.createTransport(transportOptions(a));
    try {
      await t.verify();
    } catch (e) {
      throw smtpFailure(e);
    } finally {
      t.close();
    }
  },
};

function transportOptions(a: MailAccount) {
  return {
    host: a.smtpHost,
    port: a.smtpPort,
    secure: a.smtpSecure,
    // Port 587 starts plain and must upgrade to TLS; never send the password in the clear.
    requireTLS: !a.smtpSecure,
    auth: { user: a.address, pass: a.password },
    logger: false,
    debug: false,
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 60000,
  };
}

function addr(a: unknown): string {
  return typeof a === 'string' ? a : ((a as { address?: string })?.address ?? String(a));
}
