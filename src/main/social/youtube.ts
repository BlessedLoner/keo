import fs from 'node:fs';

/**
 * Uploading a finished video to the user's own YouTube channel (YouTube Data API v3, resumable
 * upload), with the Google sign-in Keo already has plus the "upload videos" permission. Private
 * by default; AI-made videos are declared as altered or synthetic content, as YouTube asks.
 */

export const YOUTUBE_UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';

export interface YouTubeVideo {
  file: string;
  title: string;
  description: string;
  tags: string[];
  privacy: 'private' | 'unlisted' | 'public';
  /** Made with AI (realistic): YouTube's altered or synthetic content label. */
  synthetic: boolean;
  /** Made for children (YouTube asks every upload). */
  forKids: boolean;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

export class YouTubeError extends Error {}

/** What a YouTube video's title and tags may be (YouTube's own limits). */
export function cleanVideo(v: YouTubeVideo): YouTubeVideo {
  const title = v.title.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'My video';
  const description = v.description.replace(/[<>]/g, '').slice(0, 5000);
  let total = 0;
  const tags = v.tags
    .map((t) => t.replace(/^#/, '').replace(/[<>,]/g, '').trim())
    .filter(Boolean)
    .filter((t) => (total += t.length + 1) <= 480)
    .slice(0, 30);
  return { ...v, title, description, tags };
}

export async function uploadToYouTube(v: YouTubeVideo, o: { token: () => Promise<string>; fetch?: Fetch; signal?: AbortSignal; progress?: (sent: number, total: number) => void }): Promise<{ id: string; url: string }> {
  const fetchFn: Fetch = o.fetch ?? ((url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<Fetch>);
  const video = cleanVideo(v);
  const bytes = fs.readFileSync(video.file);
  const token = await o.token();
  const meta = {
    snippet: { title: video.title, description: video.description, tags: video.tags, categoryId: '22' },
    status: { privacyStatus: video.privacy, selfDeclaredMadeForKids: video.forKids, containsSyntheticMedia: video.synthetic },
  };
  const start = await fetchFn(YOUTUBE_UPLOAD_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'video/mp4', 'x-upload-content-length': String(bytes.length) },
    body: JSON.stringify(meta),
    ...(o.signal ? { signal: o.signal } : {}),
  });
  if (!start.ok) throw new YouTubeError(youTubeReason(start.status, await start.json().catch(() => ({}))));
  const session = start.headers.get('location');
  if (!session) throw new YouTubeError('YouTube did not start the upload. Try again in a minute.');
  o.progress?.(0, bytes.length);
  const put = await fetchFn(session, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'video/mp4' }, body: new Uint8Array(bytes), ...(o.signal ? { signal: o.signal } : {}) });
  const j = (await put.json().catch(() => ({}))) as { id?: unknown };
  if (!put.ok) throw new YouTubeError(youTubeReason(put.status, j));
  if (typeof j.id !== 'string') throw new YouTubeError('YouTube took the video but did not say where it is. Check YouTube Studio.');
  o.progress?.(bytes.length, bytes.length);
  return { id: j.id, url: `https://youtu.be/${j.id}` };
}

/** YouTube's answer in plain words. */
export function youTubeReason(status: number, j: unknown): string {
  const err = (j as { error?: { message?: unknown; errors?: Array<{ reason?: unknown }> } })?.error;
  const reason = String(err?.errors?.[0]?.reason ?? '');
  if (status === 401) return 'The YouTube sign-in has run out: connect YouTube again.';
  if (reason === 'quotaExceeded' || reason === 'uploadLimitExceeded') return 'YouTube’s upload limit for today has been reached. Try again tomorrow.';
  if (reason === 'youtubeSignupRequired') return 'This Google account has no YouTube channel yet: create one on youtube.com, then try again.';
  if (status === 403) return 'YouTube did not allow the upload (the “upload videos” permission is missing). Connect YouTube again and allow it.';
  const msg = typeof err?.message === 'string' ? err.message.replace(/<[^>]+>/g, '').slice(0, 200) : '';
  return `YouTube did not take the video (${status})${msg ? `: ${msg}` : ''}.`;
}
