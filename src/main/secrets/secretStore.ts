import fs from 'node:fs';
import path from 'node:path';
import { KeoError } from '../util/errors';

/** OS-backed encryption primitive. On Windows Electron's safeStorage uses DPAPI. */
export interface SecretCipher {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
}

export type SecretName =
  | 'anthropic'
  | 'openai'
  | 'openrouter'
  | 'local'
  | 'brave'
  | 'picovoice'
  /** The email account's app password (IMAP and SMTP). */
  | 'email_password'
  /** Google OAuth client secret of the user's own "Desktop app" client, if it has one. */
  | 'google_client_secret'
  /** Google Calendar tokens (JSON: refresh and access token, expiry). */
  | 'google_tokens';

/**
 * Stores provider credentials as OS-encrypted blobs in Keo's own profile.
 * Plaintext secrets exist only in main-process memory while a request is made;
 * they are never returned to the renderer, logged or written unencrypted.
 * If OS encryption is unavailable, storing is refused rather than degraded.
 */
export class SecretStore {
  private readonly file: string;

  constructor(
    dir: string,
    private readonly cipher: SecretCipher,
  ) {
    this.file = path.join(dir, 'secrets.json');
  }

  available(): boolean {
    try {
      return this.cipher.isAvailable();
    } catch {
      return false;
    }
  }

  private readAll(): Record<string, string> {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
        return out;
      }
      return {};
    } catch {
      return {};
    }
  }

  private writeAll(data: Record<string, string>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  set(name: SecretName, value: string): void {
    if (!this.available()) {
      throw new KeoError(
        'secret_storage_unavailable',
        'OS-backed secret encryption is unavailable, so Keo will not store this credential.',
      );
    }
    const all = this.readAll();
    all[name] = this.cipher.encrypt(value).toString('base64');
    this.writeAll(all);
  }

  get(name: SecretName): string | null {
    const enc = this.readAll()[name];
    if (!enc || !this.available()) return null;
    try {
      return this.cipher.decrypt(Buffer.from(enc, 'base64'));
    } catch {
      return null;
    }
  }

  has(name: SecretName): boolean {
    return typeof this.readAll()[name] === 'string';
  }

  delete(name: SecretName): void {
    const all = this.readAll();
    delete all[name];
    this.writeAll(all);
  }

  clear(): void {
    this.writeAll({});
  }
}
