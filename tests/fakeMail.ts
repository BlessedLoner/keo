import type { MailAccount, MailboxKey, MailConnection, MailConnector, MailSearch } from '../src/main/email/mailbox';
import type { MailSender } from '../src/main/email/smtp';

/**
 * In-memory mail server for tests: a few folders of RFC 5322 messages with
 * IMAP-like search. Nothing touches the network. Records every login so tests
 * can check the password was used only as a credential.
 */
export class FakeMailServer {
  boxes: Record<MailboxKey, Array<{ uid: number; seen: boolean; flags: string[]; source: string }>> = { inbox: [], sent: [], drafts: [] };
  logins: MailAccount[] = [];
  private next = 100;
  refuseLogin = false;

  add(box: MailboxKey, source: string, seen = false): number {
    const uid = this.next++;
    this.boxes[box].push({ uid, seen, flags: [], source: source.replace(/\r?\n/g, '\r\n') });
    return uid;
  }

  connector: MailConnector = async (account) => {
    this.logins.push(account);
    if (this.refuseLogin) throw new Error('The mail server refused the login. Check the address and the app password (a normal account password usually does not work).');
    const conn: MailConnection = {
      search: async (box, q) => this.boxes[box].filter((m) => matches(m, q)).map((m) => m.uid),
      fetch: async (box, uids, maxBytes) =>
        this.boxes[box].filter((m) => uids.includes(m.uid)).map((m) => ({ uid: m.uid, seen: m.seen, source: Buffer.from(m.source).subarray(0, maxBytes) })),
      setSeen: async (box, uids, seen) => {
        for (const m of this.boxes[box]) if (uids.includes(m.uid)) m.seen = seen;
      },
      append: async (box, raw, flags) => {
        this.boxes[box].push({ uid: this.next++, seen: flags.includes('\\Seen'), flags, source: raw.toString() });
        return { folder: box === 'drafts' ? 'Drafts' : 'Sent' };
      },
      close: async () => undefined,
    };
    return conn;
  };
}

function header(source: string, name: string): string {
  const head = source.split(/\r\n\r\n/)[0] ?? '';
  const m = new RegExp(`^${name}:([^\\r\\n]*(?:\\r\\n[ \\t][^\\r\\n]*)*)`, 'im').exec(head);
  return m ? m[1]!.replace(/\r\n[ \t]/g, ' ').trim() : '';
}

function matches(m: { seen: boolean; source: string }, q: MailSearch): boolean {
  const lc = (s: string) => s.toLowerCase();
  if (q.unseen && m.seen) return false;
  if (q.since && new Date(header(m.source, 'Date')) < q.since) return false;
  if (q.from && !lc(header(m.source, 'From')).includes(lc(q.from))) return false;
  if (q.to && !lc(header(m.source, 'To')).includes(lc(q.to))) return false;
  if (q.subject && !lc(header(m.source, 'Subject')).includes(lc(q.subject))) return false;
  if (q.text && !lc(m.source).includes(lc(q.text))) return false;
  for (const [k, v] of Object.entries(q.header ?? {})) if (!lc(header(m.source, k)).includes(lc(v))) return false;
  return true;
}

/** Records what would have gone to SMTP; sends nothing. */
export class FakeSender implements MailSender {
  sent: Array<{ account: MailAccount; envelope: { from: string; to: string[] }; raw: string }> = [];
  verified = 0;
  rejectAll = false;
  async send(account: MailAccount, envelope: { from: string; to: string[] }, raw: Buffer) {
    this.sent.push({ account, envelope, raw: raw.toString() });
    return this.rejectAll ? { accepted: [], rejected: envelope.to } : { accepted: envelope.to, rejected: [] };
  }
  async verify() {
    this.verified++;
  }
}

export function mail(o: { from: string; to: string; subject: string; body: string; date: string; id: string; cc?: string; inReplyTo?: string; references?: string; replyTo?: string }): string {
  return [
    `From: ${o.from}`,
    `To: ${o.to}`,
    ...(o.cc ? [`Cc: ${o.cc}`] : []),
    ...(o.replyTo ? [`Reply-To: ${o.replyTo}`] : []),
    `Subject: ${o.subject}`,
    `Date: ${o.date}`,
    `Message-ID: ${o.id}`,
    ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`] : []),
    ...(o.references ? [`References: ${o.references}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    o.body,
  ].join('\r\n');
}
