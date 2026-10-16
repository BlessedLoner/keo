import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
}

interface UiApi {
  toast(text: string, kind?: Toast['kind']): void;
  error(text: string): void;
  confirm(opts: { title: string; body: ReactNode; confirmLabel?: string; danger?: boolean }): Promise<boolean>;
  prompt(opts: { title: string; label: string; initial?: string; confirmLabel?: string }): Promise<string | null>;
}

const UiContext = createContext<UiApi | null>(null);

export function useUi(): UiApi {
  const v = useContext(UiContext);
  if (!v) throw new Error('UiProvider missing');
  return v;
}

type DialogState =
  | { type: 'confirm'; title: string; body: ReactNode; confirmLabel: string; danger: boolean; resolve: (v: boolean) => void }
  | { type: 'prompt'; title: string; label: string; initial: string; confirmLabel: string; resolve: (v: string | null) => void }
  | null;

export function UiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dialog, setDialog] = useState<DialogState>(null);
  const nextId = useRef(1);

  const toast = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-4), { id, kind, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 9000 : 4500);
  }, []);
  const error = useCallback((text: string) => toast(text, 'error'), [toast]);
  const confirm = useCallback<UiApi['confirm']>(
    (o) => new Promise((resolve) => setDialog({ type: 'confirm', title: o.title, body: o.body, confirmLabel: o.confirmLabel ?? 'Confirm', danger: !!o.danger, resolve })),
    [],
  );
  const prompt = useCallback<UiApi['prompt']>(
    (o) => new Promise((resolve) => setDialog({ type: 'prompt', title: o.title, label: o.label, initial: o.initial ?? '', confirmLabel: o.confirmLabel ?? 'Save', resolve })),
    [],
  );
  const api = useMemo(() => ({ toast, error, confirm, prompt }), [toast, error, confirm, prompt]);

  return (
    <UiContext.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <Icon name={t.kind === 'error' ? 'warn' : t.kind === 'success' ? 'check' : 'info'} size={16} />
            <div className="grow">{t.text}</div>
            <button className="btn ghost icon sm" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
      </div>
      {dialog && <Dialog state={dialog} close={() => setDialog(null)} />}
    </UiContext.Provider>
  );
}

function Dialog({ state, close }: { state: NonNullable<DialogState>; close: () => void }) {
  const [value, setValue] = useState(state.type === 'prompt' ? state.initial : '');
  const ref = useRef<HTMLDivElement>(null);
  const finish = (ok: boolean) => {
    if (state.type === 'confirm') state.resolve(ok);
    else state.resolve(ok && value.trim() ? value.trim() : null);
    close();
  };
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current?.querySelector<HTMLElement>('input, button.primary, button.danger');
    el?.focus();
    return () => prev?.focus();
  }, []);
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && finish(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') finish(false);
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title" ref={ref}>
        <h2 id="dlg-title">{state.title}</h2>
        {state.type === 'confirm' ? (
          <div className="muted">{state.body}</div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              finish(true);
            }}
          >
            <div className="field">
              <label htmlFor="dlg-input">{state.label}</label>
              <input id="dlg-input" className="input" value={value} onChange={(e) => setValue(e.target.value)} maxLength={200} />
            </div>
          </form>
        )}
        <div className="actions">
          <button className="btn ghost" onClick={() => finish(false)}>
            Cancel
          </button>
          <button className={`btn ${state.type === 'confirm' && state.danger ? 'danger' : 'primary'}`} onClick={() => finish(true)}>
            {state.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------
export function Toggle({ checked, onChange, label, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean; id?: string }) {
  return (
    <label className="toggle">
      <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function Empty({ icon = 'info', title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} size={28} />
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

export function ViewHeader({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <header className="view-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {children && <div className="actions">{children}</div>}
    </header>
  );
}

export function ErrorBanner({ error, onRetry }: { error: string | null; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="banner danger" role="alert">
      <Icon name="warn" size={16} />
      <div className="grow">{error}</div>
      {onRetry && (
        <button className="btn sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
