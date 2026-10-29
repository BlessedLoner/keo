import { clipEnd, findClip, mergeRanges, projectDuration, type EditOp, type Project } from './studio';

/**
 * Watching Keo edit: Keo's changes are made one visible step at a time (each cut, split, caption
 * group…), and each step says what it does and where on the timeline, so the Studio can move the
 * playhead there and point at it before the change lands.
 */

export interface KeoAction {
  kind: 'cut' | 'split' | 'trim' | 'move' | 'delete' | 'add' | 'captions' | 'change' | 'project';
  label: string;
  /** Where on the timeline (seconds), and where it ends for a range. */
  at: number;
  end?: number;
  /** Clips the step works on. */
  clips: string[];
}

/** Keo's ops as the steps the user watches: cuts one by one (left to right), captions a few lines at a time. */
export function showSteps(ops: EditOp[]): EditOp[] {
  const out: EditOp[] = [];
  for (const op of ops) {
    if (op.op === 'cut_ranges') {
      // Left to right: each later range moves earlier by what was cut before it.
      let removed = 0;
      for (const r of mergeRanges(op.ranges).filter((x) => x.to - x.from >= 0.02)) {
        out.push({ op: 'cut_range', from: Math.round((r.from - removed) * 1000) / 1000, to: Math.round((r.to - removed) * 1000) / 1000 });
        removed += r.to - r.from;
      }
    } else if (op.op === 'add_captions' && op.lines.length > 4) {
      for (let i = 0; i < op.lines.length; i += 4) out.push({ ...op, lines: op.lines.slice(i, i + 4), replace: i === 0 ? op.replace : false });
    } else out.push(op);
  }
  return out;
}

const t = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
};

/** What a step does, in a few words, and where (on the project as it is before the step). */
export function actionOf(op: EditOp, p: Project): KeoAction {
  const clip = 'clip' in op && typeof op.clip === 'string' ? findClip(p, op.clip)?.clip : undefined;
  const at = clip?.start ?? 0;
  const ids = clip ? [clip.id] : [];
  switch (op.op) {
    case 'cut_range':
      return { kind: 'cut', label: `Cutting ${t(op.from)}–${t(op.to)}`, at: op.from, end: op.to, clips: [] };
    case 'cut_ranges':
      return { kind: 'cut', label: `Cutting ${op.ranges.length} parts`, at: op.ranges[0]?.from ?? 0, clips: [] };
    case 'split':
      return { kind: 'split', label: `Splitting at ${t(op.at)}`, at: op.at, clips: ids };
    case 'trim':
      return { kind: 'trim', label: 'Trimming a clip', at: clip ? (op.trimStart ? at : clipEnd(clip)) : 0, clips: ids };
    case 'move':
      return { kind: 'move', label: `Moving a clip to ${t(op.start)}`, at: op.start, clips: ids };
    case 'delete':
      return { kind: 'delete', label: op.ripple ? 'Deleting a clip and closing the gap' : 'Deleting a clip', at, ...(clip ? { end: clipEnd(clip) } : {}), clips: ids };
    case 'add_media':
    case 'add_audio': {
      const start = typeof op.start === 'number' ? op.start : projectDuration(p);
      const a = p.assets.find((x) => x.id === op.assetId);
      return { kind: 'add', label: `Adding ${a?.name ?? (op.op === 'add_audio' ? 'a sound' : 'a clip')}`, at: start, clips: [] };
    }
    case 'add_text':
      return { kind: 'add', label: `Adding the text “${op.text.slice(0, 28)}${op.text.length > 28 ? '…' : ''}”`, at: op.start, clips: [] };
    case 'add_shape':
      return { kind: 'add', label: `Adding a ${op.shape}`, at: op.start, clips: [] };
    case 'add_adjust':
      return { kind: 'add', label: 'Adding an adjustment layer', at: op.start, end: op.start + op.duration, clips: [] };
    case 'add_captions':
      return { kind: 'captions', label: `Writing captions: “${(op.lines[0]?.text ?? '').slice(0, 24)}…”`, at: op.lines[0]?.start ?? 0, end: op.lines.at(-1)?.end, clips: [] };
    case 'duplicate':
      return { kind: 'add', label: 'Copying a clip', at: clip ? clipEnd(clip) : 0, clips: ids };
    case 'freeze':
      return { kind: 'change', label: `Freezing the frame at ${t(op.at)}`, at: op.at, clips: ids };
    case 'detach_audio':
      return { kind: 'change', label: 'Putting the sound on its own track', at, clips: ids };
    case 'replace_media':
      return { kind: 'change', label: 'Replacing a clip’s media', at, clips: ids };
    case 'set': {
      const what = Object.keys(op).filter((k) => k !== 'op' && k !== 'clip');
      const name: Record<string, string> = { color: 'colour', zooms: 'zoom', keys: 'motion', transition: 'transition', effects: 'effects', volume: 'volume', volumeKeys: 'volume', speed: 'speed', speedCurve: 'speed curve', voice: 'voice', voiceFx: 'voice changer', eq: 'equalizer', gate: 'noise gate', duck: 'music level', style: 'text style', text: 'text', enter: 'entrance', exit: 'exit', crop: 'crop', cutout: 'background removal', chroma: 'green screen', transform: 'position' };
      const words = [...new Set(what.map((k) => name[k] ?? k))].slice(0, 3).join(', ');
      return { kind: 'change', label: `Changing ${words || 'a clip'}`, at, ...(clip ? { end: clipEnd(clip) } : {}), clips: ids };
    }
    case 'set_project':
      return { kind: 'project', label: 'Changing the project settings', at: 0, clips: [] };
    default:
      return { kind: 'change', label: 'Editing', at, clips: ids };
  }
}
