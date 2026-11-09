import { Icon } from '../components/Icon';

/** What each kind of problem is called in the panel. */
const KIND: Record<string, string> = {
  face: 'Covers the face',
  'picture-face': 'Picture on the face',
  edge: 'Cut off at the edge',
  'app-buttons': 'Under the app buttons',
  overlap: 'Text on text',
  'too-fast': 'Too quick to read',
  twice: 'Same picture twice',
  stuck: 'Caption stuck on screen',
  'same-words': 'Same words twice',
  blank: 'Empty screen',
  words: 'Misheard word',
};

export const kindLabel = (k: string) => KIND[k] ?? k;
export const fmtAt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

/** One thing to look at: found instantly from the timeline, by looking at frames, or by proofreading the words. */
export interface CheckRow {
  key: string;
  kind: string;
  clip: string;
  at: number;
  detail: string;
  fix: string;
  canFix: boolean;
  source: 'live' | 'frames' | 'words';
}

export type Stage = 'idle' | 'running' | 'done' | 'failed';

/**
 * Keo's edit check, in Studio. What the timeline shows (stuck captions, doubled titles, empty
 * frames) is checked instantly and stays up to date while editing; faces and edges need Keo to
 * look at frames, and misheard words need the user's AI model — those arrive as they finish.
 * Fixes are edits that can be undone, and the panel says what was fixed.
 */
export function CheckPanel({
  rows,
  frames,
  frameCount,
  words,
  fixing,
  fixed,
  onCheck,
  onFix,
  onGo,
  onUndo,
  onClose,
}: {
  rows: CheckRow[];
  frames: Stage;
  frameCount: number;
  words: Stage;
  fixing: boolean;
  /** What the last fix did (shown until the next check), and how many edits to undo it. */
  fixed: { labels: string[]; edits: number } | null;
  onCheck: () => void;
  /** One row, or all that can be fixed. */
  onFix: (row?: CheckRow) => void;
  onGo: (row: CheckRow) => void;
  onUndo: () => void;
  onClose: () => void;
}) {
  const fixable = rows.filter((r) => r.canFix);
  const looking = frames === 'running' || words === 'running';
  const allDone = frames !== 'running' && words !== 'running';
  return (
    <div className="check-panel" role="dialog" aria-label="Check the edit">
      <div className="check-head">
        <Icon name="shield" size={15} />
        <strong>Check the edit</strong>
        <span className="check-spacer" />
        <button className="btn icon sm ghost" onClick={onClose} title="Close" aria-label="Close">
          <Icon name="x" size={14} />
        </button>
      </div>

      {fixed && fixed.labels.length > 0 && (
        <div className="check-fixed">
          <div className="check-fixed-head">
            <Icon name="check" size={13} /> Fixed just now
            <span className="check-spacer" />
            {fixed.edits > 0 && (
              <button className="btn sm ghost" onClick={onUndo} disabled={fixing} title="Put it back as it was">
                <Icon name="undo" size={12} /> Undo
              </button>
            )}
          </div>
          <ul>
            {fixed.labels.slice(0, 8).map((l, i) => (
              <li key={i} className="small">{l}</li>
            ))}
            {fixed.labels.length > 8 && <li className="small muted">and {fixed.labels.length - 8} more</li>}
          </ul>
        </div>
      )}

      <div className="check-stages small">
        <span className="check-stage done">
          <Icon name="check" size={12} /> Timeline: checked live
        </span>
        <span className={`check-stage ${frames}`}>
          {frames === 'running' ? <span className="spinner tiny" /> : frames === 'done' ? <Icon name="check" size={12} /> : frames === 'failed' ? '!' : '·'} {frames === 'running' ? `Looking at ${frameCount} frames…` : frames === 'failed' ? 'Frames: could not look' : frames === 'done' ? 'Faces and edges' : 'Faces and edges: not checked yet'}
        </span>
        <span className={`check-stage ${words}`}>
          {words === 'running' ? <span className="spinner tiny" /> : words === 'done' ? <Icon name="check" size={12} /> : words === 'failed' ? '!' : '·'} {words === 'running' ? 'Proofreading the words…' : words === 'failed' ? 'Words: AI model not available' : words === 'done' ? 'Words proofread' : 'Words: not checked yet'}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="small check-ok">
          <Icon name="check" size={14} /> {allDone && frames === 'done' ? 'All clear: nothing on the face, nothing cut off, no stuck captions, no misheard words, no empty frames.' : looking ? 'Nothing so far…' : 'The timeline looks clean. Check again to look at faces, edges and words too.'}
        </p>
      ) : (
        <p className="small muted check-note">
          {rows.length} thing{rows.length === 1 ? '' : 's'} to look at{fixable.length ? ` · Keo can fix ${fixable.length}` : ''}{looking ? ' (still looking)' : ''}.
        </p>
      )}

      <ul className="check-list">
        {rows.map((r) => (
          <li key={r.key} className="check-item">
            <button className="check-go" onClick={() => onGo(r)} title="Go there">
              <span className="check-time">{fmtAt(r.at)}</span>
              <span className="check-text">
                <b>{kindLabel(r.kind)}</b>
                <span className="small muted">{r.detail}</span>
              </span>
            </button>
            {r.canFix ? (
              <button className="btn sm" onClick={() => onFix(r)} disabled={fixing} title={r.fix}>
                Fix
              </button>
            ) : (
              <span className="small muted check-hand" title={r.fix}>
                By hand
              </span>
            )}
          </li>
        ))}
      </ul>

      <div className="check-foot">
        <button className="btn sm ghost" disabled={looking || fixing} onClick={onCheck}>
          <Icon name="retry" size={13} /> {frames === 'idle' ? 'Check faces & words' : 'Check again'}
        </button>
        {fixable.length > 0 && (
          <button className="btn sm primary" disabled={fixing} onClick={() => onFix()}>
            {fixing ? <span className="spinner tiny" /> : <Icon name="magic" size={13} />} {fixing ? 'Fixing…' : `Fix all ${fixable.length}`}
          </button>
        )}
      </div>
    </div>
  );
}
