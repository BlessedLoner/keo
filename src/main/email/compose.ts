import crypto from 'node:crypto';

/** One outgoing message, exactly as the user approved it. */
export interface Outgoing {
  from: { address: string; name: string };
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  /** Reply threading: the Message-ID answered and the thread's earlier ids. */
  inReplyTo?: string;
  references?: string[];
  /** A calendar invite (text/calendar; method=REQUEST). */
  ics?: string;
}

/**
 * Builds the RFC 5322 source with nodemailer's composer. The same bytes are
 * stored as a draft or handed to SMTP, so what was approved is what is sent.
 */
export async function composeMessage(m: Outgoing, messageId = newMessageId(m.from.address)): Promise<{ raw: Buffer; messageId: string }> {
  const { default: MailComposer } = await import('nodemailer/lib/mail-composer');
  const mail = new MailComposer({
    from: m.from.name ? { name: m.from.name, address: m.from.address } : m.from.address,
    to: m.to,
    cc: m.cc.length ? m.cc : undefined,
    bcc: m.bcc.length ? m.bcc : undefined,
    subject: m.subject,
    text: m.body,
    messageId,
    date: new Date(),
    ...(m.inReplyTo ? { inReplyTo: m.inReplyTo, references: [...(m.references ?? []), m.inReplyTo].filter((v, i, all) => all.indexOf(v) === i) } : {}),
    ...(m.ics ? { icalEvent: { method: 'REQUEST', filename: 'invite.ics', content: m.ics } } : {}),
  });
  // Bcc reaches SMTP's envelope only; the composer leaves it out of the message itself.
  const raw = await new Promise<Buffer>((resolve, reject) => mail.compile().build((err, out) => (err ? reject(err) : resolve(out))));
  return { raw, messageId };
}

export function newMessageId(from: string): string {
  const domain = from.split('@')[1] || 'keo.local';
  return `<${crypto.randomUUID()}@${domain}>`;
}

/** "Re: subject", without stacking "Re: Re:". */
export function replySubject(subject: string): string {
  const s = subject.trim();
  return /^(re|aw|sv)\s*:/i.test(s) ? s : `Re: ${s || '(no subject)'}`;
}

export interface CalendarInvite {
  uid?: string;
  title: string;
  start: Date;
  end: Date;
  location?: string;
  description?: string;
  organizer: { address: string; name: string };
  attendees: string[];
}

/** An RFC 5545 VCALENDAR with one VEVENT, METHOD:REQUEST (an invitation Gmail, Outlook and Apple Calendar accept). */
export function buildIcs(e: CalendarInvite, now = new Date()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'PRODID:-//Keo//Keo calendar invite//EN',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${e.uid ?? `${crypto.randomUUID()}@keo`}`,
    `DTSTAMP:${icsTime(now)}`,
    `DTSTART:${icsTime(e.start)}`,
    `DTEND:${icsTime(e.end)}`,
    `SUMMARY:${icsText(e.title)}`,
    ...(e.location ? [`LOCATION:${icsText(e.location)}`] : []),
    ...(e.description ? [`DESCRIPTION:${icsText(e.description)}`] : []),
    `ORGANIZER${e.organizer.name ? `;CN=${icsParam(e.organizer.name)}` : ''}:mailto:${e.organizer.address}`,
    ...e.attendees.map((a) => `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a}`),
    'SEQUENCE:0',
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/** UTC "20261024T150000Z". */
export function icsTime(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function icsText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function icsParam(s: string): string {
  const clean = s.replace(/["\r\n]/g, '');
  return /[;:,]/.test(clean) ? `"${clean}"` : clean;
}

/** Lines longer than 75 octets continue on the next line after a space (RFC 5545 §3.1). */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch, 'utf8') > (parts.length ? 74 : 75)) {
      parts.push(cur);
      cur = '';
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}
