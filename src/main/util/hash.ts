import { createHash } from 'node:crypto';

/** Deterministic JSON (sorted keys) so equal inputs always hash identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hashInput(capabilityId: string, version: string, input: unknown): string {
  return sha256(`${capabilityId}@${version}:${canonicalJson(input)}`);
}
