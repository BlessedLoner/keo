/**
 * Redaction for anything that may reach logs, audit records or IPC errors.
 * Two layers: sensitive *keys* are dropped wholesale; sensitive *patterns*
 * (API keys, bearer tokens, card-like numbers) are masked inside strings.
 */
const SENSITIVE_KEY = /(api[-_]?key|authorization|auth[-_]?header|password|passwd|secret|token|cookie|credential|private[-_]?key|image|screenshot|audio|prompt|content|text)$/i;

const PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED_KEY]'],
  [/sk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, '[REDACTED_KEY]'],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '[REDACTED_AUTH]'],
  [/\b(?:x-api-key|api-key)\s*[:=]\s*\S+/gi, '[REDACTED_AUTH]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED_KEY]'],
  [/\b(?:\d[ -]?){13,19}\b/g, '[REDACTED_NUMBER]'],
  [/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/g, '[REDACTED_IMAGE]'],
];

export function redactString(s: string, maxLen = 2000): string {
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  if (out.length > maxLen) out = `${out.slice(0, maxLen)}…[truncated ${out.length - maxLen} chars]`;
  return out;
}

/** Returns true when a string looks like it contains a credential. */
export function containsSecret(s: string): boolean {
  return PATTERNS.slice(0, 6).some(([re]) => {
    re.lastIndex = 0;
    const hit = re.test(s);
    re.lastIndex = 0;
    return hit;
  }) || /\b(password|passwd|pwd)\s*[:=]\s*\S+/i.test(s);
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Uint8Array) return `[binary ${value.byteLength} bytes]`;
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(k)) {
        out[k] = typeof v === 'string' ? `[omitted ${v.length} chars]` : '[omitted]';
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}
