import type { EmailServers } from '../../shared/email';

/** Where a message lives. 'sent' and 'drafts' are found by their special-use flag. */
export type MailboxKey = 'inbox' | 'sent' | 'drafts';

export interface MailSearch {
  unseen?: boolean;
  since?: Date;
  from?: string;
  to?: string;
  subject?: string;
  /** Anywhere in subject, sender or body. */
  text?: string;
  /** Header contains (IMAP SEARCH HEADER), e.g. { 'message-id': '<…>' }. */
  header?: Record<string, string>;
}

export interface RawMessage {
  uid: number;
  seen: boolean;
  /** The full RFC 5322 source. */
  source: Buffer;
}

export interface MailAccount extends EmailServers {
  address: string;
  password: string;
}

/**
 * The few IMAP operations Keo needs. The app uses imapflow; tests inject a
 * fake, so no test ever reaches a real mail server.
 */
export interface MailConnection {
  /** Matching UIDs (any order). An absent special mailbox (no Sent folder) gives []. */
  search(box: MailboxKey, q: MailSearch): Promise<number[]>;
  /** The messages' source, cut after `maxBytes` (enough for headers and the start of the text). */
  fetch(box: MailboxKey, uids: number[], maxBytes: number): Promise<RawMessage[]>;
  setSeen(box: MailboxKey, uids: number[], seen: boolean): Promise<void>;
  /** Stores a message (a draft, or a copy of a sent message); returns the folder used. */
  append(box: 'drafts' | 'sent', raw: Buffer, flags: string[]): Promise<{ folder: string } | null>;
  close(): Promise<void>;
}

export type MailConnector = (account: MailAccount, signal: AbortSignal) => Promise<MailConnection>;

/** Real IMAP over TLS with imapflow. Its own logging is off: it could include the login. */
export const imapConnector: MailConnector = async (a, signal) => {
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({
    host: a.imapHost,
    port: a.imapPort,
    secure: a.imapSecure,
    auth: { user: a.address, pass: a.password },
    logger: false,
    emitLogs: false,
    disableAutoIdle: true,
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 60000,
  });
  // A broken connection must not crash Keo; the next call reconnects.
  client.on('error', () => undefined);
  const abort = () => void client.close();
  signal.addEventListener('abort', abort, { once: true });
  try {
    await client.connect();
  } catch (e) {
    signal.removeEventListener('abort', abort);
    throw new Error(loginHint(e), { cause: e });
  }
  let special: Partial<Record<MailboxKey, string>> | null = null;
  const pathOf = async (box: MailboxKey): Promise<string | null> => {
    if (box === 'inbox') return 'INBOX';
    if (!special) {
      special = {};
      for (const m of await client.list()) {
        if (m.specialUse === '\\Sent') special.sent = m.path;
        if (m.specialUse === '\\Drafts') special.drafts = m.path;
      }
    }
    return special[box] ?? null;
  };
  const withBox = async <T>(box: MailboxKey, empty: T, fn: () => Promise<T>): Promise<T> => {
    const p = await pathOf(box);
    if (!p) return empty;
    const lock = await client.getMailboxLock(p);
    try {
      return await fn();
    } finally {
      lock.release();
    }
  };
  return {
    search: (box, q) =>
      withBox(box, [] as number[], async () => {
        const criteria: Record<string, unknown> = {};
        if (q.unseen) criteria.seen = false;
        if (q.since) criteria.since = q.since;
        if (q.from) criteria.from = q.from;
        if (q.to) criteria.to = q.to;
        if (q.subject) criteria.subject = q.subject;
        if (q.header) criteria.header = q.header;
        if (q.text) criteria.or = [{ subject: q.text }, { from: q.text }, { body: q.text }];
        if (!Object.keys(criteria).length) criteria.all = true;
        const r = await client.search(criteria, { uid: true });
        return r || [];
      }),
    fetch: (box, uids, maxBytes) =>
      withBox(box, [] as RawMessage[], async () => {
        if (!uids.length) return [];
        const out: RawMessage[] = [];
        for await (const m of client.fetch(uids.join(','), { uid: true, flags: true, source: { start: 0, maxLength: maxBytes } }, { uid: true })) {
          if (m.source) out.push({ uid: m.uid, seen: !!m.flags?.has('\\Seen'), source: m.source });
        }
        return out;
      }),
    setSeen: (box, uids, seen) =>
      withBox(box, undefined, async () => {
        if (!uids.length) return;
        if (seen) await client.messageFlagsAdd(uids.join(','), ['\\Seen'], { uid: true });
        else await client.messageFlagsRemove(uids.join(','), ['\\Seen'], { uid: true });
      }),
    append: async (box, raw, flags) => {
      const p = await pathOf(box);
      if (!p) return null;
      await client.append(p, raw, flags);
      return { folder: p };
    },
    close: async () => {
      signal.removeEventListener('abort', abort);
      try {
        await client.logout();
      } catch {
        client.close();
      }
    },
  };
};

/** A login failure in plain words (never echoing the server's text, which may quote the login). */
export function loginHint(e: unknown): string {
  const err = e as { authenticationFailed?: boolean; code?: string; message?: string };
  if (err?.authenticationFailed) return 'The mail server refused the login. Check the address and the app password (a normal account password usually does not work).';
  if (err?.code === 'ENOTFOUND' || err?.code === 'EAI_AGAIN') return 'The mail server could not be found. Check the server name and your internet connection.';
  if (err?.code === 'ETIMEDOUT' || err?.code === 'ECONNREFUSED' || err?.code === 'ECONNRESET') return 'Could not reach the mail server (check the server, port and your internet connection).';
  return 'Could not connect to the mail server.';
}
