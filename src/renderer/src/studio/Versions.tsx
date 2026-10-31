import { useEffect, useState } from 'react';
import type { StudioVersion } from '@shared/studio';
import { useUi } from '../components/ui';
import { errText, invoke } from '../lib/api';

/**
 * Saved versions of an edit, at the top of the History menu: keep the edit as it is now under a
 * name, and go back to any saved one (a step that can be undone). Keo saves them too before a
 * big change.
 */
export function Versions({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const ui = useUi();
  const [list, setList] = useState<StudioVersion[]>([]);
  const [name, setName] = useState('');
  useEffect(() => {
    void invoke('studio:versions', { id: projectId, action: 'list' })
      .then(setList)
      .catch(() => undefined);
  }, [projectId]);
  const act = async (action: 'save' | 'restore' | 'delete', o: { name?: string; version?: string } = {}) => {
    try {
      setList(await invoke('studio:versions', { id: projectId, action, ...o }));
      if (action === 'save') {
        setName('');
        ui.toast('Version saved.');
      }
      if (action === 'restore') onDone();
    } catch (e) {
      ui.error(errText(e));
    }
  };
  return (
    <div className="versions">
      <div className="hist-title">Versions</div>
      <form
        className="versions-save"
        onSubmit={(e) => {
          e.preventDefault();
          void act('save', { name: name.trim() || `Version ${list.length + 1}` });
        }}
      >
        <input className="input" value={name} maxLength={80} placeholder={`Version ${list.length + 1}`} onChange={(e) => setName(e.target.value)} aria-label="Version name" />
        <button type="submit" className="btn sm">
          Save this version
        </button>
      </form>
      {list.map((v) => (
        <div key={v.id} className="version-row">
          <button onClick={() => void act('restore', { version: v.id })} title="Go back to this version (you can undo it)">
            <span className="version-name">{v.name}</span>
            <span className="hist-n">
              {new Date(v.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {v.seconds}s
            </span>
          </button>
          <button className="version-del" onClick={() => void act('delete', { version: v.id })} title="Delete this saved version" aria-label={`Delete ${v.name}`}>
            ×
          </button>
        </div>
      ))}
      <div className="hist-title">Changes</div>
    </div>
  );
}
