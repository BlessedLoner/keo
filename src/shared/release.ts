/**
 * Where Keo is published. The installer lives on GitHub Releases (which the
 * update check reads) and the download page on GitHub Pages.
 */
export const RELEASE = { owner: 'BlessedLoner', repo: 'keo' } as const;

const PAGE = `https://${RELEASE.owner.toLowerCase()}.github.io/${RELEASE.repo}/`;

/**
 * The only web pages Keo's windows may ask the main process to open (no
 * arbitrary URLs from the renderer).
 */
export const LINKS = {
  download: PAGE,
  privacy: `${PAGE}privacy.html`,
  releases: `https://github.com/${RELEASE.owner}/${RELEASE.repo}/releases/latest`,
  openrouterKeys: 'https://openrouter.ai/keys',
  openaiKeys: 'https://platform.openai.com/api-keys',
  anthropicKeys: 'https://console.anthropic.com/settings/keys',
  braveKeys: 'https://api-dashboard.search.brave.com/app/keys',
  ollama: 'https://ollama.com/download',
  // The ffmpeg that "Set up video tools" downloads: its source code and the build's own page.
  ffmpegSource: 'https://ffmpeg.org/download.html',
  ffmpegBuild: 'https://www.gyan.dev/ffmpeg/builds/',
} as const;

export type LinkId = keyof typeof LINKS;
export const LINK_IDS = Object.keys(LINKS) as [LinkId, ...LinkId[]];

/** Compares semantic versions ("1.2.0", "v1.2.0-beta.1"): <0 if a is older, 0 if equal, >0 if newer. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre = ''] = v.trim().replace(/^v/i, '').split('-', 2);
    return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d;
  }
  // A release outranks its pre-releases (1.0.0 > 1.0.0-beta.2).
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre.localeCompare(y.pre, 'en', { numeric: true });
}
