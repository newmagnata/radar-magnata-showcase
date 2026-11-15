import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ToastApi {
  ok(message: string): void;
  fail(reason: unknown): void;
}

const ToastContext = createContext<ToastApi>({ ok: () => {}, fail: () => {} });
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ text: string; kind: "ok" | "fail" } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback((text: string, kind: "ok" | "fail") => {
    setToast({ text, kind });
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 5000);
  }, []);
  const value = useRef<ToastApi>({
    ok: (message) => show(message, "ok"),
    fail: (reason) => show(reason instanceof Error ? reason.message : "Algo deu errado", "fail"),
  });
  return (
    <ToastContext.Provider value={value.current}>
      {children}
      <div className="toast-area" role="status" aria-live="polite">
        {toast && <div className={`toast toast-${toast.kind}`}>{toast.text}</div>}
      </div>
    </ToastContext.Provider>
  );
}

export function Button({
  variant = "secondary",
  busy,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; busy?: boolean }) {
  return (
    <button type="button" {...props} className={`btn btn-${variant} ${props.className ?? ""}`} disabled={props.disabled || busy}>
      {busy ? "Aguarde…" : children}
    </button>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (value: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="toggle-track" aria-hidden="true" />
      <span>
        <span className="toggle-label">{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </span>
    </label>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function Card({ title, action, children, className = "" }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

export function PageHead({ title, sub, action }: { title: string; sub?: string; action?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {action}
    </div>
  );
}

export function LoadState({ loading, error, onRetry }: { loading: boolean; error: string; onRetry: () => void }) {
  if (error) {
    return (
      <div className="notice notice-error">
        <span>{error}</span>
        <Button variant="ghost" onClick={onRetry}>Tentar de novo</Button>
      </div>
    );
  }
  return loading ? <div className="skeleton" aria-label="Carregando" /> : null;
}
