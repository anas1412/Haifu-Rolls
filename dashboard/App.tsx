import { useEffect, useState } from "react";
import icon from "./icon.png";
import { api, type Meta, type ServerCard, type ServerDetail, type Status, signedOut } from "./api";
import { type Route, ToastContext, usePoll, useRoute, useToasts } from "./hooks";
import { Avatar, Empty, Name, Progress, Skeleton, plural, since } from "./ui";
import { Cards, Overview, Players, Season } from "./views";

export function App() {
  const [auth, setAuth] = useState<"checking" | "in" | "out">("checking");
  const { toasts, push } = useToasts();

  useEffect(() => {
    api("/session").then(() => setAuth("in")).catch(() => setAuth("out"));
    const out = () => setAuth("out");
    signedOut.addEventListener("out", out);
    return () => signedOut.removeEventListener("out", out);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {auth === "checking" ? <div className="boot" /> : auth === "out" ? <Login onIn={() => setAuth("in")} /> : <Console onOut={() => setAuth("out")} />}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>)}
      </div>
    </ToastContext.Provider>
  );
}

function Login({ onIn }: { onIn: () => void }) {
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/login", { method: "POST", body: { password } });
      onIn();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form onSubmit={submit} className="login-card">
        <img className="brand-mark" src={icon} alt="" width={64} height={64} />
        <h1>Haifu Rolls</h1>
        <p className="muted">Admin dashboard. Sign in to manage servers, cards and seasons.</p>
        <label className="field">
          <span>Password</span>
          <div className="pw">
            <input type={show ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="current-password" />
            <button type="button" className="link" onClick={() => setShow(!show)}>{show ? "Hide" : "Show"}</button>
          </div>
        </label>
        {error && <p className="error-text" role="alert">{error}</p>}
        <button className="btn primary wide" disabled={busy || !password}>{busy ? "Signing in…" : "Sign in"}</button>
        <p className="muted small">You stay signed in on this device for 30 days.</p>
      </form>
    </main>
  );
}

const TAB_LABELS: Record<Route["tab"], string> = { overview: "Overview", cards: "Cards", players: "Players", season: "Season" };

function Console({ onOut }: { onOut: () => void }) {
  const [route, go] = useRoute();
  const [menu, setMenu] = useState(false);
  const [meta, setMeta] = useState<Meta | null>(null);
  const servers = usePoll(() => api<ServerCard[]>("/servers"), [], 30_000);
  const status = usePoll(() => api<Status>("/status"), [], 15_000);

  useEffect(() => { api<Meta>("/meta").then(setMeta).catch(() => {}); }, []);
  // Land on the busiest server when nothing is picked yet.
  useEffect(() => {
    if (!route.server && servers.data?.length) go({ server: servers.data[0]!.id, tab: "overview", owner: "" });
  }, [route.server, servers.data, go]);

  async function signOut() {
    await api("/logout", { method: "POST" }).catch(() => {});
    onOut();
  }

  const s = status.data;
  return (
    <div className={`console${menu ? " menu-open" : ""}`}>
      <aside className="sidebar">
        <div className="side-top">
          <div className="brand"><img className="brand-mark small" src={icon} alt="" width={32} height={32} /><b>Haifu Rolls</b></div>
          <button className="icon-btn only-sm" onClick={() => setMenu(false)} aria-label="Close menu"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg></button>
        </div>

        <div className={`bot-status ${s?.online ? "on" : "off"}`}>
          <i />
          <div>
            <b>{!s ? "Checking the bot…" : s.online ? "Bot online" : "Bot offline"}</b>
            {s?.online && <span>{s.ping} ms ping · up {since(s.uptime)}</span>}
          </div>
        </div>

        <nav className="server-list" aria-label="Servers">
          <span className="label">Servers {servers.data && <em>{servers.data.length}</em>}</span>
          {!servers.data ? <Skeleton h={180} /> : servers.data.map((srv) => (
            <button key={srv.id} className={`server${route.server === srv.id ? " active" : ""}`}
              onClick={() => { go({ server: srv.id, tab: route.tab, owner: "" }); setMenu(false); }}>
              {srv.icon ? <img src={srv.icon} alt="" width={34} height={34} /> : <span className="server-blank">{[...srv.name][0]}</span>}
              <span className="server-text">
                <Name>{srv.name}</Name>
                <small>{plural(srv.players, "player")} · season {srv.season}{!srv.present ? " · bot removed" : ""}</small>
              </span>
            </button>
          ))}
        </nav>

        <button className="btn ghost wide sign-out" onClick={signOut}>Sign out</button>
      </aside>

      <div className="scrim" onClick={() => setMenu(false)} />

      <main className="main">
        <button className="btn ghost only-sm menu-btn" onClick={() => setMenu(true)}>Servers</button>
        {route.server && meta ? <ServerView key={route.server} id={route.server} route={route} go={go} meta={meta} onChange={servers.reload} />
          : servers.data && !servers.data.length ? <Empty title="The bot isn't in any server yet">Invite it to a server and it will show up here.</Empty>
          : <Skeleton h={320} />}
      </main>
    </div>
  );
}

function ServerView({ id, route, go, meta, onChange }: {
  id: string; route: Route; go: (r: Partial<Route>) => void; meta: Meta; onChange: () => void;
}) {
  const detail = usePoll(() => api<ServerDetail>(`/servers/${id}`), [id], 20_000);
  const server = detail.data;
  const refresh = () => { void detail.reload(); onChange(); };

  if (detail.error && !server) return <Empty title="Couldn't load this server">{detail.error}</Empty>;
  if (!server) return <Skeleton h={420} />;

  return (
    <>
      <header className="server-head">
        {server.icon ? <img src={server.icon} alt="" width={56} height={56} /> : <span className="server-blank big">{[...server.name][0]}</span>}
        <div>
          <h1><Name>{server.name}</Name></h1>
          <p className="muted">
            Season {server.season} · {plural(server.players.length, "player")}
            {server.members != null && <> · {plural(server.members, "member")}</>}
          </p>
        </div>
        <div className="head-progress">
          <span><b>{server.claimed}</b> / {server.total} claimed</span>
          <Progress value={server.claimed} total={server.total} />
        </div>
      </header>

      <nav className="tabs" role="tablist">
        {(Object.keys(TAB_LABELS) as Route["tab"][]).map((t) => (
          <button key={t} role="tab" aria-selected={route.tab === t} onClick={() => go({ tab: t, owner: t === "cards" ? route.owner : "" })}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </nav>

      <div className="tab-body">
        {route.tab === "overview" && <Overview server={server} meta={meta} onPlayer={(u) => go({ tab: "cards", owner: u })} />}
        {route.tab === "cards" && <Cards server={server} meta={meta} owner={route.owner} setOwner={(o) => go({ owner: o })} onChanged={refresh} />}
        {route.tab === "players" && <Players server={server} onCards={(u) => go({ tab: "cards", owner: u })} />}
        {route.tab === "season" && <Season server={server} meta={meta} onEnded={refresh} />}
      </div>
    </>
  );
}
