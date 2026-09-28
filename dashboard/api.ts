// Everything the dashboard asks the bot for. One wrapper: JSON in, JSON out, readable errors.

export type Person = { userId: string; name: string; avatar: string | null };
export type Rarity = { key: string; points: number; color: string; secret: boolean };
export type Meta = { imageBase: string; rarities: Rarity[]; medals: number[] };
export type Status = { online: boolean; tag: string | null; avatar: string | null; ping: number | null; uptime: number; servers: number };
export type ServerCard = {
  id: string; name: string; icon: string | null; members: number | null; present: boolean;
  season: number; players: number; claimed: number; total: number;
};
export type Player = Person & { points: number; cards: number };
export type ServerDetail = ServerCard & {
  points: Record<string, number>; // this server's value per rarity
  medals: number[];
  deck: { rarity: string; total: number; claimed: number }[];
  players: Player[];
  allTime: (Person & { points: number; seasons: number; golds: number })[];
};
export type Card = { id: number; name: string; rarity: string; file: string; owner: Person | null };
export type SeasonResult = {
  season: number; posted: boolean; pinged: boolean; channel: string | null;
  medals: (Person & { place: number; points: number })[];
};

export class ApiError extends Error {
  /** errors: which field was wrong and why, when the server checked a form */
  constructor(message: string, readonly status: number, readonly errors?: Record<string, string>) { super(message); }
}

/** Fired when the session runs out, so the app can show the sign-in screen again. */
export const signedOut = new EventTarget();

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    headers: init.body !== undefined || init.method ? { "content-type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : init.method ? "{}" : undefined,
    credentials: "same-origin",
  }).catch(() => null);
  if (!res) throw new ApiError("Can't reach the bot. Check your connection and try again.", 0);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/login") signedOut.dispatchEvent(new Event("out"));
  const d = data as { error?: string; errors?: Record<string, string> };
  if (!res.ok) throw new ApiError(d.error ?? `Something went wrong (${res.status}).`, res.status, d.errors);
  return data as T;
}
