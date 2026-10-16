/**
 * Content Security Policy for the renderer. Production is strict: only
 * same-origin scripts/styles, no eval, no remote connections. Images may be
 * data: URLs (stored observations are served that way via IPC). Media allows
 * blob: for locally generated speech audio.
 */
export function buildCsp(dev: boolean, devOrigin?: string): string {
  const self = "'self'";
  const directives: Record<string, string[]> = {
    'default-src': [self],
    'script-src': dev ? [self, "'unsafe-inline'", devOrigin ?? ''] : [self],
    'style-src': dev ? [self, "'unsafe-inline'"] : [self],
    'img-src': [self, 'data:', 'blob:'],
    'media-src': [self, 'blob:', 'data:'],
    'font-src': [self, 'data:'],
    'connect-src': dev ? [self, devOrigin ?? '', (devOrigin ?? '').replace(/^http/, 'ws')] : [self],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'worker-src': [self, 'blob:'],
  };
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.filter(Boolean).join(' ')}`)
    .join('; ');
}
