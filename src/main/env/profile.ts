import path from 'node:path';

export const APP_ID = 'com.keo.desktop';
export const APP_NAME = 'Keo';

export interface ProfileInfo {
  profile: string;
  userData: string;
  dbFile: string;
  logsDir: string;
  secretsDir: string;
  observationsDir: string;
  backupsDir: string;
  runtimeDir: string;
}

/**
 * Resolves Keo's own, isolated data directory:
 *   %APPDATA%\Keo\<profile>
 * Profiles: "default" for packaged builds, "dev" for unpackaged/dev builds.
 * KEO_PROFILE selects a named profile; KEO_USER_DATA_DIR points at a fully
 * disposable directory (used by automated lifecycle checks).
 */
export function resolveProfile(appDataDir: string, env: NodeJS.ProcessEnv, packaged: boolean): ProfileInfo {
  const requested = env.KEO_PROFILE?.trim();
  const profile = requested && /^[a-z0-9-]{1,32}$/.test(requested) ? requested : packaged ? 'default' : 'dev';
  const override = env.KEO_USER_DATA_DIR?.trim();
  const userData = override ? path.resolve(override) : path.join(appDataDir, APP_NAME, profile);
  return {
    profile: override ? `${profile} (custom dir)` : profile,
    userData,
    dbFile: path.join(userData, 'keo.db'),
    logsDir: path.join(userData, 'logs'),
    secretsDir: userData,
    observationsDir: path.join(userData, 'observations'),
    backupsDir: path.join(userData, 'backups'),
    runtimeDir: path.join(userData, 'runtime'),
  };
}
