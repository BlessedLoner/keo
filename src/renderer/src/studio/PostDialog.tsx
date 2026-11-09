import { useEffect, useState } from 'react';
import { PLATFORMS, postBody, type PlatformId } from '@shared/social';
import { Icon } from '../components/Icon';
import { useUi } from '../components/ui';
import { errText, invoke } from '../lib/api';

/**
 * Posting a finished export. Keo writes the post from what the video says; the user reads and
 * changes it. YouTube: uploaded to their channel (private unless they choose). TikTok and
 * Instagram do not let apps post for people: Keo copies the caption, shows the file and opens
 * their upload page, and the user posts it there.
 */
export function PostDialog({ projectId, file, aiMade, onClose }: { projectId: string; file: string; aiMade: boolean; onClose: () => void }) {
  const ui = useUi();
  const [platform, setPlatform] = useState<PlatformId>('youtube');
  const [title, setTitle] = useState('');
  const [caption, setCaption] = useState('');
  const [tags, setTags] = useState('');
  const [privacy, setPrivacy] = useState<'private' | 'unlisted' | 'public'>('private');
  const [forKids, setForKids] = useState(false);
  const [yt, setYt] = useState<{ connected: boolean; email: string | null; canConnect: boolean } | null>(null);
  const [busy, setBusy] = useState<'write' | 'connect' | 'post' | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    void invoke('social:youtubeStatus', {}).then(setYt, () => undefined);
  }, []);

  const write = async () => {
    setBusy('write');
    try {
      const r = await invoke('social:write', { projectId, platform });
      setTitle(r.title);
      setCaption(r.caption);
      setTags(r.hashtags.join(' '));
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(null);
    }
  };
  // Written for each platform when it is chosen (and nothing written yet).
  useEffect(() => {
    if (!title && !caption) void write();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform]);

  const hashtags = tags.split(/\s+/).map((t) => t.trim()).filter(Boolean);
  const body = postBody({ title: title || 'My video', caption, hashtags }, platform);

  const connect = async () => {
    setBusy('connect');
    try {
      const r = await invoke('social:connectYouTube', {});
      if (!r.connected) ui.error('YouTube was not connected: tick “upload videos” on Google’s page.');
      setYt(await invoke('social:youtubeStatus', {}));
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const post = async () => {
    if (platform === 'youtube') {
      if (privacy === 'public') {
        const ok = await ui.confirm({ title: 'Publish on YouTube for everyone?', body: `“${title}” goes live on ${yt?.email ?? 'your channel'} straight away.`, confirmLabel: 'Publish now' });
        if (!ok) return;
      }
      setBusy('post');
      try {
        const r = await invoke('social:postYouTube', { projectId, file, title, description: `${caption}${hashtags.length ? `\n\n${hashtags.join(' ')}` : ''}`, tags: hashtags, privacy, forKids });
        setDone(r.privacy === 'private' ? `Uploaded as private: open it in YouTube Studio to publish. ${r.url}` : `Posted: ${r.url}`);
      } catch (e) {
        ui.error(errText(e));
      } finally {
        setBusy(null);
      }
      return;
    }
    setBusy('post');
    try {
      const r = await invoke('social:handoff', { platform, file, text: body });
      setDone(`${r.copied ? 'The caption is copied. ' : ''}Keo opened ${PLATFORMS[platform].label}'s upload page and showed the video file: drag the file in, paste the caption (Ctrl+V) and post.`);
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label="Post the video" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal post-dialog">
        <div className="row">
          <h3>Post your video</h3>
          <span className="grow" />
          <button className="btn icon sm ghost" onClick={onClose} aria-label="Close">
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="row post-platforms" role="tablist">
          {(Object.keys(PLATFORMS) as PlatformId[]).map((p) => (
            <button key={p} role="tab" aria-selected={platform === p} className={`chip-btn${platform === p ? ' on' : ''}`} disabled={!!busy} onClick={() => { setPlatform(p); setTitle(''); setCaption(''); setTags(''); setDone(null); }}>
              {PLATFORMS[p].label}
            </button>
          ))}
        </div>
        {!PLATFORMS[platform].direct && <p className="small muted">{PLATFORMS[platform].label} only lets approved apps post for people, so Keo copies your caption, shows the file and opens the upload page; you post it there in a few clicks.</p>}
        {platform === 'youtube' && yt && !yt.connected && (
          <div className="post-connect">
            <span className="small">Connect your YouTube channel once (Google asks you to allow “upload videos”).</span>
            <button className="btn sm primary" disabled={!yt.canConnect || !!busy} onClick={() => void connect()}>
              {busy === 'connect' ? <span className="spinner tiny" /> : null} Connect YouTube
            </button>
          </div>
        )}
        {busy === 'write' ? (
          <p className="small muted"><span className="spinner tiny" /> Keo is writing the post from what you say in the video…</p>
        ) : (
          <>
            {platform === 'youtube' && (
              <div className="field">
                <label>Title</label>
                <input className="input" value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} />
              </div>
            )}
            <div className="field">
              <label>Caption</label>
              <textarea className="textarea" rows={4} value={caption} maxLength={2200} onChange={(e) => setCaption(e.target.value)} />
            </div>
            <div className="field">
              <label>Hashtags</label>
              <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="#keo #ai" />
            </div>
            {platform === 'youtube' && (
              <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                <select className="select" value={privacy} onChange={(e) => setPrivacy(e.target.value as typeof privacy)}>
                  <option value="private">Private (publish later in YouTube Studio)</option>
                  <option value="unlisted">Unlisted (only people with the link)</option>
                  <option value="public">Public (everyone, straight away)</option>
                </select>
                <label className="insp-check"><input type="checkbox" checked={forKids} onChange={(e) => setForKids(e.target.checked)} /> Made for kids</label>
              </div>
            )}
            {aiMade && <p className="small warn-text">This video has realistic AI-made footage{platform === 'youtube' ? ': Keo tells YouTube (its “altered or synthetic content” label).' : `: turn on ${PLATFORMS[platform].label}'s AI-generated label when you post.`}</p>}
          </>
        )}
        {done && <p className="small post-done"><Icon name="check" size={13} /> {done}</p>}
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn sm ghost" disabled={!!busy} onClick={() => void write()}>
            <Icon name="sparkle" size={12} /> Write again
          </button>
          <button className="btn sm primary" disabled={!!busy || (platform === 'youtube' && (!yt?.connected || !title.trim()))} onClick={() => void post()}>
            {busy === 'post' ? <span className="spinner tiny" /> : <Icon name="send" size={12} />} {platform === 'youtube' ? (busy === 'post' ? 'Uploading…' : 'Upload to YouTube') : `Open ${PLATFORMS[platform].label}`}
          </button>
        </div>
      </div>
    </div>
  );
}
