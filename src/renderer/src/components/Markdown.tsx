import { Fragment, type ReactNode } from 'react';

/**
 * Small, safe Markdown renderer. Produces React elements only (never raw
 * HTML), so model output cannot inject markup or scripts. Supports fenced
 * code, headings, lists, blockquotes, paragraphs, inline code, bold, italic
 * and https links (opened externally by the main process).
 */
export function Markdown({ text }: { text: string }) {
  return <div className="md">{blocks(text)}</div>;
}

function blocks(src: string): ReactNode[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i] as string)) body.push(lines[i++] as string);
      i++;
      out.push(
        <pre key={key++}>
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(4, (h[1] as string).length);
      const content = inline(h[2] as string);
      out.push(level === 1 ? <h1 key={key++}>{content}</h1> : level === 2 ? <h2 key={key++}>{content}</h2> : level === 3 ? <h3 key={key++}>{content}</h3> : <h4 key={key++}>{content}</h4>);
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i] as string)) {
        let item = (lines[i] as string).replace(/^\s*([-*+]|\d+[.)])\s+/, '');
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i] as string) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i] as string)) {
          item += ` ${(lines[i] as string).trim()}`;
          i++;
        }
        items.push(item);
      }
      const lis = items.map((it, n) => <li key={n}>{inline(it)}</li>);
      out.push(ordered ? <ol key={key++}>{lis}</ol> : <ul key={key++}>{lis}</ul>);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] as string)) q.push((lines[i++] as string).replace(/^>\s?/, ''));
      out.push(<blockquote key={key++}>{inline(q.join(' '))}</blockquote>);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && (lines[i] as string).trim() && !/^(```|#{1,4}\s|>\s?|\s*([-*+]|\d+[.)])\s+)/.test(lines[i] as string)) para.push(lines[i++] as string);
    out.push(
      <p key={key++}>
        {para.map((p, n) => (
          <Fragment key={n}>
            {n > 0 && <br />}
            {inline(p)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return out;
}

const TOKEN = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\s][^*]*\*)|(_[^_\s][^_]*_)|(\[[^\]]+\]\(https:\/\/[^)\s]+\))/g;

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of s.matchAll(TOKEN)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(s.slice(last, idx));
    const t = m[0];
    if (t.startsWith('`')) out.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else if (t.startsWith('**') || t.startsWith('__')) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('[')) {
      const lm = /^\[([^\]]+)\]\((https:\/\/[^)\s]+)\)$/.exec(t);
      if (lm) {
        out.push(
          <a key={k++} href={lm[2]} target="_blank" rel="noreferrer noopener" title={lm[2]}>
            {lm[1]}
          </a>,
        );
      } else out.push(t);
    } else out.push(<em key={k++}>{t.slice(1, -1)}</em>);
    last = idx + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
