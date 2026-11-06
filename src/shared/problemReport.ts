/**
 * A problem report: what the user says happened, which Keo they run, and (if they agree) Keo's
 * recent activity log, with personal details taken out. The user sees this exact text before it
 * is sent (or saved).
 *
 * Keo's log already leaves out conversation text, prompts, pictures, sound and keys; the report
 * also removes the user's name in file paths, email addresses, phone numbers, web addresses'
 * queries and anything that looks like a key.
 */

export interface ReportEnvironment {
  version: string;
  platform: string;
  electron?: string;
  packaged?: boolean;
  /** Where the user's files are (their name is taken out of paths). */
  home?: string;
}

export interface ReportLogLine {
  ts: string;
  level: string;
  event: string;
  data?: unknown;
}

/** The most a report holds (Keo Cloud takes up to this). */
export const REPORT_MAX_CHARS = 200_000;

/** Personal details out of a piece of text. */
export function scrubPersonal(text: string, home?: string): string {
  let s = text;
  if (home) {
    // C:\Users\anita → C:\Users\<you> (both slash styles; JSON-escaped backslashes too).
    const name = home.split(/[\\/]/).filter(Boolean).at(-1);
    if (name && name.length > 1) s = s.replace(new RegExp(`([\\\\/]+(?:Users|home)[\\\\/]+)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\\\/"']|$)`, 'gi'), '$1<you>');
  }
  return s
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\b(sk|pk|rk|fal|key|tok|token)[-_][A-Za-z0-9_-]{12,}\b/gi, '<key>')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '<token>')
    .replace(/(https?:\/\/[^\s"'?#]+)\?[^\s"']*/g, '$1?<query>')
    .replace(/(?<![\w.])\+?\d[\d\s().-]{7,}\d(?![\w.])/g, (m) => (m.replace(/\D/g, '').length >= 8 ? '<number>' : m));
}

/** The report's text: the user's words, the environment, and the log lines (newest last). */
export function buildReport(o: { message: string; env: ReportEnvironment; logs?: ReportLogLine[]; now?: Date }): string {
  const env = o.env;
  const lines = [
    'Keo problem report',
    `Made: ${(o.now ?? new Date()).toISOString()}`,
    `Keo ${env.version}${env.packaged === false ? ' (development build)' : ''} on ${env.platform}${env.electron ? `, Electron ${env.electron}` : ''}`,
    '',
    'What happened (in the user’s words):',
    o.message.trim() || '(nothing written)',
    '',
  ];
  if (o.logs?.length) {
    lines.push(`Recent activity (${o.logs.length} events, personal details removed):`);
    for (const l of o.logs) lines.push(`${l.ts} ${l.level.toUpperCase()} ${l.event}${l.data !== undefined ? ` ${JSON.stringify(l.data)}` : ''}`);
  } else lines.push('Recent activity: not included.');
  let text = scrubPersonal(lines.join('\n'), env.home);
  if (text.length > REPORT_MAX_CHARS) {
    // The oldest log lines go first: the newest ones are what matter.
    const head = text.indexOf('\n', text.indexOf('Recent activity'));
    text = `${text.slice(0, head + 1)}…(older events left out)\n${text.slice(text.length - (REPORT_MAX_CHARS - head - 40))}`;
  }
  return text;
}
