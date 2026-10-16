import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Sortable-ish random id: time prefix + 12 random chars. Matches the IPC id schema. */
export function newId(prefix = ''): string {
  const time = Date.now().toString(36);
  const bytes = randomBytes(12);
  let rand = '';
  for (const b of bytes) rand += ALPHABET[b % ALPHABET.length];
  return `${prefix}${time}${rand}`;
}

export function newCorrelationId(): string {
  return newId('c_');
}
