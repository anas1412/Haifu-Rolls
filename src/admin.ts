/**
 * Admin dashboard API: the JSON the React dashboard (dashboard/) reads and writes.
 *
 * It only runs when ADMIN_PASSWORD is set. Signing in sets a cookie that keeps you in for 30 days,
 * so there is no token to paste on every visit. Every route except /api/login needs that cookie,
 * and every change must be sent as JSON: a form on another site cannot fake that, so a link or a
 * hidden form elsewhere can't move cards while you are signed in.
 */
import type { Client, Guild } from "discord.js";
import { RARITIES, RARITY_ORDER, SECRET_RARITIES } from "./config";
import { DEFAULTS, FIELDS, overridesFor, saveOverrides, settingsFor } from "./settings";
import * as db from "./db";
import type { SeasonEnd } from "./index";

const PASSWORD = process.env.ADMIN_PASSWORD ?? "";
const COOKIE = "haifu_admin";
const SESSION_DAYS = 30;
type EndSeason = (guildId: string) => Promise<SeasonEnd | null>;

export const adminEnabled = () => !!PASSWORD;

// ---------- sign-in ----------

/** Sessions are a signed expiry stamp, so nothing has to be stored server side. */
function sign(value: string): string {
  return new Bun.CryptoHasher("sha256").update(`${value}.${PASSWORD}`).digest("hex");
}

function issueToken(): string {
  const expires = Date.now() + SESSION_DAYS * 86400_000;
  return `${expires}.${sign(String(expires))}`;
}

function tokenIsValid(token: string | undefined): boolean {
  if (!token) return false;
  const [expires, mac] = token.split(".");
  if (!expires || !mac || Number(expires) < Date.now()) return false;
  // constant-time compare so a wrong cookie cannot be probed byte by byte
  return timingSafeEqual(mac, sign(expires));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let n = 0; n < a.length; n++) diff |= a.charCodeAt(n) ^ b.charCodeAt(n);
  return diff === 0;
}

function cookieFrom(req: Request): string | undefined {
  return req.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim().split("="))
    .find(([k]) => k === COOKIE)?.[1];
}

const session = (value: string, maxAge: number) =>
  `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${process.env.RAILWAY_ENVIRONMENT ? "; Secure" : ""}`;

// ---------- people ----------

type Person = { userId: string; name: string; avatar: string | null };
const people = new Map<string, { at: number; person: Person }>();
const PERSON_TTL = 10 * 60_000; // nicknames change; don't keep them forever

/** Server nickname and avatar, falling back to the global profile, then to the bare id. */
async function person(client: Client, guildId: string, userId: string): Promise<Person> {
  const key = `${guildId}:${userId}`;
  const hit = people.get(key);
  if (hit && Date.now() - hit.at < PERSON_TTL) return hit.person;
  const member = await client.guilds.cache.get(guildId)?.members.fetch(userId).catch(() => null);
  const user = member?.user ?? (await client.users.fetch(userId).catch(() => null));
  const p: Person = {
    userId,
    name: member?.displayName ?? user?.displayName ?? userId,
    avatar: member?.displayAvatarURL({ size: 64 }) ?? user?.displayAvatarURL({ size: 64 }) ?? null,
  };
  people.set(key, { at: Date.now(), person: p });
  return p;
}

// ---------- data ----------

function deckTotals(guildId: string) {
  const deck = db.deckBreakdown(guildId);
  return { deck, claimed: deck.reduce((n, r) => n + r.claimed, 0), total: deck.reduce((n, r) => n + r.total, 0) };
}

function serverCard(client: Client, id: string) {
  const guild: Guild | undefined = client.guilds.cache.get(id);
  const season = db.currentSeason(id);
  const { claimed, total } = deckTotals(id);
  return {
    id,
    name: guild?.name ?? id,
    icon: guild?.iconURL({ size: 64 }) ?? null,
    members: guild?.memberCount ?? null,
    present: !!guild, // false when the bot was removed but the server still has game history
    season,
    players: db.seasonTop(id, season, 10_000).length,
    claimed,
    total,
  };
}

async function serverDetail(client: Client, id: string) {
  const season = db.currentSeason(id);
  const { deck } = deckTotals(id);
  const standings = db.seasonTop(id, season, 500);
  const allTime = db.allTimeLeaderboard(id, 10);
  const s = settingsFor(id);
  return {
    ...serverCard(client, id),
    points: Object.fromEntries(RARITY_ORDER.map((r) => [r, s.tiers[r].points])), // this server's values
    medals: s.medalPoints,
    deck: RARITY_ORDER.map((rarity) => ({ rarity, ...(deck.find((d) => d.rarity === rarity) ?? { total: 0, claimed: 0 }) })),
    players: await Promise.all(standings.map(async (s) => ({ ...(await person(client, id, s.userId)), points: s.points, cards: s.count }))),
    allTime: await Promise.all(allTime.map(async (a) => ({ ...(await person(client, id, a.userId)), ...a }))),
  };
}

// ---------- routes ----------

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
const fail = (status: number, error: string) => json({ error }, status);

async function body(req: Request): Promise<Record<string, unknown>> {
  return ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
}

/** Handles every /api request. The web server only calls this when the dashboard is enabled. */
export async function adminApi(req: Request, client: Client, endSeason: EndSeason): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.slice("/api".length);
  const write = req.method !== "GET";
  if (write && !req.headers.get("content-type")?.includes("application/json")) return fail(415, "Send JSON.");

  if (path === "/login" && req.method === "POST") {
    const { password } = await body(req);
    if (timingSafeEqual(String(password ?? ""), PASSWORD)) {
      return json({ ok: true }, 200, { "set-cookie": session(issueToken(), SESSION_DAYS * 86400) });
    }
    await Bun.sleep(600); // slow down guessing
    return fail(401, "That password is not right.");
  }
  if (path === "/logout" && req.method === "POST") return json({ ok: true }, 200, { "set-cookie": session("", 0) });
  if (!tokenIsValid(cookieFrom(req))) return fail(401, "Sign in first.");

  if (path === "/session") return json({ ok: true });

  if (path === "/status") {
    return json({
      online: client.isReady(),
      tag: client.user?.tag ?? null,
      avatar: client.user?.displayAvatarURL({ size: 64 }) ?? null,
      ping: client.isReady() ? Math.round(client.ws.ping) : null,
      uptime: client.uptime ?? 0,
      servers: client.guilds.cache.size,
    });
  }

  if (path === "/meta") {
    return json({
      imageBase: "/images", // served by web.ts from the same folder the bot reads
      medals: settingsFor().medalPoints,
      rarities: RARITY_ORDER.map((key) => ({
        key,
        points: settingsFor().tiers[key].points,
        color: `#${RARITIES[key].color.toString(16).padStart(6, "0")}`,
        secret: SECRET_RARITIES.includes(key),
      })),
    });
  }

  if (path === "/settings/global") return settingsRoute(req, "global");

  if (path === "/servers") {
    const ids = new Set([...client.guilds.cache.keys(), ...db.guildsWithData()]);
    return json([...ids].map((id) => serverCard(client, id)).sort((a, b) => b.players - a.players || a.name.localeCompare(b.name)));
  }

  const route = path.match(/^\/servers\/(\d{5,25})(\/.*)?$/);
  if (!route) return fail(404, "Nothing here.");
  const guildId = route[1]!;
  const rest = route[2] ?? "";

  if (rest === "" && req.method === "GET") return json(await serverDetail(client, guildId));
  if (rest === "/settings") return settingsRoute(req, guildId);

  if (rest === "/cards" && req.method === "GET") {
    const q = url.searchParams;
    const { cards, total } = db.cardsWithOwners(guildId, {
      search: q.get("q") ?? "",
      rarity: q.get("rarity") ?? "",
      owner: q.get("owner") ?? "",
      limit: Math.min(Number(q.get("limit")) || 48, 200),
      offset: Math.max(Number(q.get("offset")) || 0, 0),
    });
    const withOwners = await Promise.all(
      cards.map(async (c) => ({ ...c, owner: c.owner ? await person(client, guildId, c.owner) : null })),
    );
    return json({ cards: withOwners, total });
  }

  if (rest === "/members" && req.method === "GET") {
    // Search the whole server by name, so a card can go to anyone, not just current players.
    const query = (url.searchParams.get("q") ?? "").trim();
    if (/^\d{15,25}$/.test(query)) return json([await person(client, guildId, query)]);
    const guild = client.guilds.cache.get(guildId);
    const found = query && guild ? await guild.members.search({ query, limit: 8 }).catch(() => null) : null;
    if (found) {
      return json([...found.values()].filter((m) => !m.user.bot).map((m) => ({ userId: m.id, name: m.displayName, avatar: m.displayAvatarURL({ size: 64 }) })));
    }
    // No search available: offer this season's players whose name matches.
    const players = await Promise.all(db.seasonTop(guildId, db.currentSeason(guildId), 500).map((s) => person(client, guildId, s.userId)));
    return json(players.filter((p) => p.name.toLowerCase().includes(query.toLowerCase())).slice(0, 8));
  }

  const owner = rest.match(/^\/cards\/(\d+)\/owner$/);
  if (owner && (req.method === "PUT" || req.method === "DELETE")) {
    const card = db.getCard(Number(owner[1]));
    if (!card) return fail(404, `There is no card #${owner[1]}.`);
    if (req.method === "DELETE") {
      return db.clearOwner(guildId, card.id) ? json({ ok: true }) : fail(409, `#${card.id} already had no owner.`);
    }
    const { userId } = await body(req);
    if (typeof userId !== "string" || !/^\d{15,25}$/.test(userId)) return fail(400, "Pick someone to give it to.");
    db.setOwner(guildId, card.id, userId);
    return json({ ok: true, owner: await person(client, guildId, userId) });
  }

  if (rest === "/end-season" && req.method === "POST") {
    // The page says which season it was showing, so a double click or a stale tab can't end the next one too.
    const { season } = await body(req);
    if (Number(season) !== db.currentSeason(guildId)) return fail(409, "That season has already ended. Nothing was changed.");
    const result = await endSeason(guildId);
    if (!result) return fail(409, "Nobody has claimed a card this season, so it was left open.");
    return json({
      ...result,
      medals: await Promise.all(result.medals.map(async (m) => ({ ...m, ...(await person(client, guildId, m.userId)) }))),
    });
  }

  return fail(404, "Nothing here.");
}

/**
 * Read or replace one scope's settings. The page gets the overrides (what was changed here), what it
 * inherits (the code defaults for global, the global values for a server), and the result in effect.
 */
async function settingsRoute(req: Request, scope: string): Promise<Response> {
  if (req.method === "PUT") {
    const { overrides } = await body(req);
    const r = saveOverrides(scope, (overrides ?? {}) as Record<string, unknown>);
    if (!r.ok) return json({ error: "Some values need fixing.", errors: r.errors }, 422);
  } else if (req.method !== "GET") return fail(405, "Not allowed.");
  return json({
    scope,
    fields: FIELDS,
    rarities: RARITY_ORDER.map((key) => ({ key, secret: SECRET_RARITIES.includes(key), color: `#${RARITIES[key].color.toString(16).padStart(6, "0")}` })),
    overrides: overridesFor(scope),
    inherited: scope === "global" ? DEFAULTS : settingsFor(),
    effective: scope === "global" ? settingsFor() : settingsFor(scope),
  });
}

export const _internals = { tokenIsValid, issueToken, timingSafeEqual };
