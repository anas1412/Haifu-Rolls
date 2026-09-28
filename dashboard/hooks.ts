import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

/**
 * Load something now, then again every `every` ms while the tab is visible, so the numbers on screen
 * follow what players do in Discord. `reload` refreshes on demand, e.g. right after a change.
 */
export function usePoll<T>(load: () => Promise<T>, deps: unknown[], every = 20_000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(async () => {
    try {
      setData(await loadRef.current());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    setData(null);
    void reload();
    const tick = () => document.visibilityState === "visible" && void reload();
    const t = setInterval(tick, every);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, reload };
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// ---------- toasts ----------

export type Toast = { id: number; text: string; tone: "ok" | "error" };
export const ToastContext = createContext<(text: string, tone?: Toast["tone"]) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast["tone"] = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 7000 : 4000);
  }, []);
  return { toasts, push };
}

// ---------- routing ----------

/**
 * The address bar keeps your place: #/s/<server>/<tab>, or #/settings for the global settings,
 * so a refresh or a shared link lands in the same view.
 */
export type Route = { server: string | null; global: boolean; tab: "overview" | "cards" | "players" | "season" | "settings"; owner: string };
const TABS = ["overview", "cards", "players", "season", "settings"] as const;

function parse(): Route {
  const [path = "", query = ""] = location.hash.replace(/^#/, "").split("?");
  const [, s, server, tab] = path.split("/");
  const owner = new URLSearchParams(query).get("owner") ?? "";
  return {
    global: s === "settings",
    server: s === "s" && server ? server : null,
    tab: (TABS as readonly string[]).includes(tab ?? "") ? (tab as Route["tab"]) : "overview",
    owner,
  };
}

export function useRoute(): [Route, (r: Partial<Route>) => void] {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  const go = useCallback((next: Partial<Route>) => {
    const r = { ...parse(), ...next };
    location.hash = r.global ? "/settings" : r.server ? `/s/${r.server}/${r.tab}${r.owner ? `?owner=${r.owner}` : ""}` : "/";
  }, []);
  return [route, go];
}
