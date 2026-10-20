import { useEffect, useState } from 'react';
import { invoke } from '../lib/api';

type Mark = { shape: 'circle' | 'box' | 'arrow' | 'underline' | 'label'; x: number; y: number; w?: number; h?: number; fromX?: number; fromY?: number; label?: string };

/**
 * Keo's marks over the screen while Keo explains: each mark draws itself in turn (bright, with a
 * soft white halo so it reads on any picture or video), with its note beside it, then all fade out.
 * The window is click-through; it only shows.
 */
export function MarksApp() {
  const [data, setData] = useState<{ marks: Mark[]; seconds: number } | null>(null);
  useEffect(() => {
    document.documentElement.classList.add('marks-root');
    void invoke('marks:get', {}).then(setData, () => undefined);
  }, []);
  if (!data) return null;
  const step = 0.45;
  return (
    <svg className="marks" width="100%" height="100%" style={{ animationDelay: `${Math.max(1, data.seconds - 0.6)}s` }} aria-hidden="true">
      <defs>
        <marker id="mk-head" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 Z" fill="#ff3d5a" />
        </marker>
      </defs>
      {data.marks.map((m, i) => {
        const delay = `${i * step}s`;
        const w = m.w ?? (m.shape === 'circle' ? 120 : 160);
        const h = m.h ?? (m.shape === 'circle' ? w : 60);
        let path = '';
        if (m.shape === 'circle') {
          // A hand-drawn loop: slightly more than a full turn.
          const rx = w / 2;
          const ry = h / 2;
          const pts = Array.from({ length: 41 }, (_, k) => {
            const a = -Math.PI / 2 + (k / 40) * Math.PI * 2.12;
            const wob = 1 + Math.sin(k * 1.7) * 0.025;
            return `${(m.x + Math.cos(a) * rx * wob).toFixed(1)} ${(m.y + Math.sin(a) * ry * wob).toFixed(1)}`;
          });
          path = `M${pts.join(' L')}`;
        } else if (m.shape === 'box') path = `M${m.x} ${m.y} h${w} v${h} h${-w} Z`;
        else if (m.shape === 'underline') path = `M${m.x} ${m.y} q${w / 2} 6 ${w} 0`;
        else if (m.shape === 'arrow') {
          const fx = m.fromX ?? m.x - 90;
          const fy = m.fromY ?? m.y - 90;
          path = `M${fx} ${fy} Q${(fx + m.x) / 2 + (m.y - fy) * 0.15} ${(fy + m.y) / 2 - (m.x - fx) * 0.15} ${m.x} ${m.y}`;
        }
        const labelX = m.shape === 'circle' ? m.x + w / 2 + 10 : m.shape === 'label' ? m.x : m.x + (m.shape === 'arrow' ? 0 : w) + 10;
        const labelY = m.shape === 'circle' ? m.y - h / 2 : m.shape === 'label' ? m.y : m.y - 6;
        return (
          <g key={i}>
            {path && (
              <>
                <path className="mk-halo" d={path} pathLength={1} style={{ animationDelay: delay }} />
                <path className="mk-line" d={path} pathLength={1} style={{ animationDelay: delay }} markerEnd={m.shape === 'arrow' ? 'url(#mk-head)' : undefined} />
              </>
            )}
            {m.label && (
              <foreignObject x={labelX} y={labelY - 16} width="260" height="64" className="mk-label-box" style={{ animationDelay: `${i * step + 0.3}s` }}>
                <div className="mk-label">
                  <b>{i + 1}</b> {m.label}
                </div>
              </foreignObject>
            )}
          </g>
        );
      })}
    </svg>
  );
}
