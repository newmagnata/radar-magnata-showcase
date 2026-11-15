import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { FolderTree, LayoutDashboard, ListOrdered, LogOut, Radar, Send, Settings as SettingsIcon, Ticket, Users } from "lucide-react";
import { api, useLoad } from "./api.ts";
import type { AppStatus } from "./api.ts";
import { CategoriesPage, CouponsPage, DashboardPage, GroupsPage, QueuePage, SendPage, SettingsPage } from "./pages.tsx";
import type { PageId } from "./pages.tsx";
import { Button, Field, ToastProvider } from "./ui.tsx";

interface AuthState {
  needsSetup: boolean;
  authenticated: boolean;
  needsTotp: boolean;
}

function AuthScreen({ state, onDone }: { state: AuthState; onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [code, setCode] = useState("");
  const [enroll, setEnroll] = useState<{ qr: string; secret: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const askTotp = enroll !== null || state.needsTotp;

  const run = async (event: FormEvent, action: () => Promise<void>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) =>
    run(event, async () => {
      if (askTotp) {
        await api("/auth/totp", "POST", { code });
        onDone();
      } else if (state.needsSetup) {
        setEnroll(await api("/auth/setup", "POST", { token, email, password }));
      } else {
        await api("/auth/login", "POST", { email, password });
        onDone();
      }
    });

  const heading = enroll ? "Ative a verificação em 2 etapas" : askTotp ? "Código de verificação" : state.needsSetup ? "Crie seu acesso" : "Entrar no painel";

  return (
    <main className="auth">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand brand-auth"><Radar size={24} /> Radar Magnata</div>
        <h1>{heading}</h1>
        {enroll && (
          <div className="enroll">
            <img src={enroll.qr} alt="QR Code para o aplicativo autenticador" width={200} height={200} />
            <p className="hint">Leia no Google Authenticator ou Authy. Sem câmera, digite esta chave:</p>
            <code>{enroll.secret}</code>
          </div>
        )}
        {askTotp ? (
          <Field label="Código de 6 números">
            <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} required autoFocus />
          </Field>
        ) : (
          <>
            {state.needsSetup && (
              <Field label="Código de instalação" hint="Está no arquivo .env, na linha SETUP_TOKEN">
                <input value={token} onChange={(e) => setToken(e.target.value)} type="password" required autoComplete="off" />
              </Field>
            )}
            <Field label="E-mail">
              <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required autoComplete="username" />
            </Field>
            <Field label="Senha" hint={state.needsSetup ? "Pelo menos 12 caracteres" : undefined}>
              <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required autoComplete={state.needsSetup ? "new-password" : "current-password"} minLength={state.needsSetup ? 12 : 1} />
            </Field>
          </>
        )}
        {error && <div className="notice notice-error" role="alert">{error}</div>}
        <Button type="submit" variant="primary" busy={busy}>{askTotp ? "Confirmar" : state.needsSetup ? "Continuar" : "Entrar"}</Button>
      </form>
    </main>
  );
}

const NAV: { id: PageId; label: string; icon: typeof Radar }[] = [
  { id: "dashboard", label: "Resultados", icon: LayoutDashboard },
  { id: "queue", label: "Fila", icon: ListOrdered },
  { id: "send", label: "Enviar", icon: Send },
  { id: "coupons", label: "Cupons", icon: Ticket },
  { id: "groups", label: "Grupos", icon: Users },
  { id: "categories", label: "Categorias", icon: FolderTree },
  { id: "settings", label: "Ajustes", icon: SettingsIcon },
];

const WA_TEXT = { open: "WhatsApp conectado", qr: "Aguardando QR Code", connecting: "Conectando", disconnected: "WhatsApp desconectado" };

function Shell({ onLogout }: { onLogout: () => void }) {
  const [page, setPage] = useState<PageId>("dashboard");
  const status = useLoad<AppStatus>("/status", 5000);
  const pending = status.data?.queue.find((q) => q.status === "pending_approval")?.n ?? 0;
  const state = status.data?.whatsapp.state ?? "disconnected";
  const commonProps = { status: status.data, reloadStatus: status.reload, go: setPage };

  return (
    <div className="shell">
      <nav className="side" aria-label="Principal">
        <div className="brand"><Radar size={22} /> <span>Radar Magnata</span></div>
        {NAV.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" className={page === id ? "nav active" : "nav"} aria-current={page === id ? "page" : undefined} onClick={() => setPage(id)}>
            <Icon size={19} aria-hidden="true" />
            <span>{label}</span>
            {id === "queue" && pending > 0 && <em aria-label={`${pending} aguardando aprovação`}>{pending}</em>}
          </button>
        ))}
        <button type="button" className="nav nav-out" onClick={onLogout}>
          <LogOut size={19} aria-hidden="true" /><span>Sair</span>
        </button>
      </nav>
      <div className="main">
        <div className="statusbar">
          <span className={`pill ${state === "open" ? "pill-good" : "pill-bad"}`}><i aria-hidden="true" />{WA_TEXT[state]}</span>
          <span className={`pill ${status.data?.settings.autoMode ? "pill-good" : "pill-off"}`}><i aria-hidden="true" />Automático {status.data?.settings.autoMode ? "ligado" : "desligado"}</span>
          <button type="button" className="logout-mobile" onClick={onLogout}><LogOut size={15} aria-hidden="true" /> Sair</button>
        </div>
        <main className="content">
          {page === "dashboard" && <DashboardPage {...commonProps} />}
          {page === "queue" && <QueuePage {...commonProps} />}
          {page === "send" && <SendPage {...commonProps} />}
          {page === "coupons" && <CouponsPage {...commonProps} />}
          {page === "groups" && <GroupsPage {...commonProps} />}
          {page === "categories" && <CategoriesPage {...commonProps} />}
          {page === "settings" && <SettingsPage {...commonProps} />}
        </main>
      </div>
    </div>
  );
}

export function App() {
  const [state, setState] = useState<AuthState | null>(null);
  const [failed, setFailed] = useState(false);
  const refresh = () => {
    api<AuthState>("/auth/state").then(setState, () => setFailed(true));
  };
  useEffect(() => {
    refresh();
    window.addEventListener("radar:logout", refresh);
    return () => window.removeEventListener("radar:logout", refresh);
  }, []);

  if (failed) return <main className="auth"><div className="notice notice-error">O servidor não respondeu. Verifique se ele está ligado.</div></main>;
  if (!state) return <main className="auth"><div className="skeleton" aria-label="Carregando" /></main>;
  return (
    <ToastProvider>
      {state.authenticated ? (
        <Shell onLogout={() => void api("/auth/logout", "POST").then(refresh)} />
      ) : (
        <AuthScreen state={state} onDone={refresh} />
      )}
    </ToastProvider>
  );
}
