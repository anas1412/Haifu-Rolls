/**
 * Admin dashboard: a small web page for looking at servers, seeing who owns what, and moving
 * cards around without touching SQL.
 *
 * It only starts when ADMIN_PASSWORD is set. You sign in once and a cookie keeps you signed in
 * for 30 days, so there is no token to paste on every visit.
 */
import type { Client } from "discord.js";
import * as db from "./db";
import { RARITIES, type Rarity } from "./config";

const PASSWORD = process.env.ADMIN_PASSWORD ?? "";
const COOKIE = "haifu_admin";
const SESSION_DAYS = 30;

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

// ---------- html ----------

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLE = `
  *{box-sizing:border-box}
  body{margin:0;background:#160409;color:#f4e7d3;font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
  a{color:#f1d28a}
  .wrap{max-width:1000px;margin:0 auto;padding:20px}
  h1{font-size:22px;margin:0 0 4px}
  h2{font-size:17px;margin:28px 0 10px;color:#f1d28a}
  .sub{color:#bfae99;font-size:14px;margin:0 0 20px}
  .card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:14px;margin-bottom:12px}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th,td{text-align:left;padding:8px 6px;border-bottom:1px solid rgba(255,255,255,.07);vertical-align:middle}
  th{color:#bfae99;font-weight:600;font-size:13px}
  .name{font-weight:600}
  .muted{color:#bfae99}
  input,select,button{font:inherit;border-radius:8px;border:1px solid rgba(255,255,255,.14);
    background:#241016;color:#f4e7d3;padding:7px 10px}
  button{cursor:pointer;background:#d9a441;color:#1d0b02;border:0;font-weight:600}
  button.ghost{background:transparent;color:#e0557b;border:1px solid rgba(224,85,123,.5);font-weight:500}
  form.row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:0}
  .bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
  .pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;background:rgba(255,255,255,.07)}
  .flash{background:rgba(46,204,113,.14);border:1px solid rgba(46,204,113,.4);padding:10px 12px;border-radius:10px;margin-bottom:14px}
  .top{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:18px}
  @media(max-width:640px){td,th{padding:6px 4px;font-size:13px}.wrap{padding:14px}}
`;

function page(title: string, body: string): Response {
  return html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style>
<div class="wrap"><div class="top"><h1>${esc(title)}</h1><a href="/logout">sign out</a></div>${body}</div>`);
}

const html = (s: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(s, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });

const redirect = (to: string, headers: Record<string, string> = {}) =>
  new Response(null, { status: 303, headers: { location: to, ...headers } });

function loginPage(error = ""): Response {
  return html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Haifu Rolls admin</title><style>${STYLE}</style>
<div class="wrap" style="max-width:340px;padding-top:80px">
  <h1>Haifu Rolls</h1><p class="sub">Admin sign in</p>
  ${error ? `<div class="card" style="border-color:rgba(224,85,123,.5)">${esc(error)}</div>` : ""}
  <form method="post" action="/login" class="card">
    <input type="password" name="password" placeholder="Password" autofocus style="width:100%;margin-bottom:10px">
    <button style="width:100%">Sign in</button>
  </form>
  <p class="sub">You stay signed in on this device for ${SESSION_DAYS} days.</p>
</div>`);
}

// ---------- name lookup ----------

const nameCache = new Map<string, string>();

async function displayName(client: Client, guildId: string, userId: string): Promise<string> {
  const key = `${guildId}:${userId}`;
  const hit = nameCache.get(key);
  if (hit) return hit;
  const guild = client.guilds.cache.get(guildId);
  const member = await guild?.members.fetch(userId).catch(() => null);
  const name = member?.displayName ?? (await client.users.fetch(userId).catch(() => null))?.displayName ?? userId;
  nameCache.set(key, name);
  return name;
}

// ---------- pages ----------

async function serversPage(client: Client): Promise<Response> {
  const ids = new Set([...client.guilds.cache.keys(), ...db.guildsWithData()]);
  const rows = await Promise.all(
    [...ids].map(async (id) => {
      const guild = client.guilds.cache.get(id);
      const players = db.seasonTop(id, db.currentSeason(id), 100);
      const deck = db.deckBreakdown(id);
      const total = deck.reduce((n, r) => n + r.total, 0);
      const claimed = deck.reduce((n, r) => n + r.claimed, 0);
      return `<tr>
        <td class="name"><a href="/g/${esc(id)}">${esc(guild?.name ?? id)}</a><div class="muted" style="font-size:12px">${esc(id)}</div></td>
        <td>${players.length}</td><td>${claimed} / ${total}</td><td>${db.currentSeason(id)}</td></tr>`;
    }),
  );
  return page(
    "Servers",
    `<div class="card"><table><tr><th>Server</th><th>Players</th><th>Cards claimed</th><th>Season</th></tr>${rows.join("")}</table></div>`,
  );
}

async function serverPage(client: Client, guildId: string, url: URL, flash = ""): Promise<Response> {
  const guild = client.guilds.cache.get(guildId);
  const search = url.searchParams.get("q") ?? "";
  const showAll = url.searchParams.get("all") === "1";
  const season = db.currentSeason(guildId);

  const players = db.seasonTop(guildId, season, 100);
  const named = await Promise.all(
    players.map(async (p) => ({ ...p, name: await displayName(client, guildId, p.userId) })),
  );
  const playerRows = named
    .map(
      (p) =>
        `<tr><td class="name">${esc(p.name)}</td><td>${p.count}</td><td>${p.points}</td>
         <td><a href="/g/${esc(guildId)}?q=&owner=${esc(p.userId)}">view</a></td></tr>`,
    )
    .join("");

  // owner filter, applied after the query so the search box stays simple
  const ownerFilter = url.searchParams.get("owner") ?? "";
  let cards = db.cardsWithOwners(guildId, { search, onlyClaimed: !showAll && !search, limit: 300 });
  if (ownerFilter) cards = cards.filter((c) => c.owner === ownerFilter);

  const options = named.map((p) => `<option value="${esc(p.userId)}">${esc(p.name)}</option>`).join("");
  const cardRows = await Promise.all(
    cards.map(async (c) => {
      const owner = c.owner ? esc(await displayName(client, guildId, c.owner)) : `<span class="muted">unclaimed</span>`;
      return `<tr>
        <td><span class="pill">#${c.id}</span></td>
        <td class="name">${RARITIES[c.rarity as Rarity].emoji} ${esc(c.name)}</td>
        <td class="muted">${esc(c.rarity)}</td>
        <td>${owner}</td>
        <td>
          <form class="row" method="post" action="/g/${esc(guildId)}/set">
            <input type="hidden" name="card" value="${c.id}">
            <input type="hidden" name="back" value="${esc(url.search)}">
            <select name="user"><option value="">give to…</option>${options}</select>
            <input name="userId" placeholder="or user ID" size="12">
            <button>Save</button>
          </form>
        </td>
        <td>${
          c.owner
            ? `<form class="row" method="post" action="/g/${esc(guildId)}/clear" onsubmit="return confirm('Return #${c.id} to the pool?')">
                 <input type="hidden" name="card" value="${c.id}">
                 <input type="hidden" name="back" value="${esc(url.search)}">
                 <button class="ghost">Remove</button></form>`
            : ""
        }</td></tr>`;
    }),
  );

  const deck = db.deckBreakdown(guildId);
  const total = deck.reduce((n, r) => n + r.total, 0);
  const claimed = deck.reduce((n, r) => n + r.claimed, 0);

  return page(
    guild?.name ?? guildId,
    `${flash ? `<div class="flash">${esc(flash)}</div>` : ""}
     <p class="sub"><a href="/">← all servers</a> · season ${season} · ${claimed} of ${total} cards claimed</p>

     <h2>Players</h2>
     <div class="card"><table><tr><th>Name</th><th>Cards</th><th>Points</th><th></th></tr>${playerRows || `<tr><td colspan="4" class="muted">nobody yet</td></tr>`}</table></div>

     <h2>Cards</h2>
     <form class="bar" method="get" action="/g/${esc(guildId)}">
       <input name="q" value="${esc(search)}" placeholder="card number or name">
       <label class="muted"><input type="checkbox" name="all" value="1" ${showAll ? "checked" : ""}> include unclaimed</label>
       <button>Search</button>
       ${ownerFilter ? `<a href="/g/${esc(guildId)}">clear owner filter</a>` : ""}
     </form>
     <div class="card"><table>
       <tr><th>#</th><th>Card</th><th>Rarity</th><th>Owner</th><th>Give to</th><th></th></tr>
       ${cardRows.join("") || `<tr><td colspan="6" class="muted">no matches</td></tr>`}
     </table></div>
     <p class="sub">Showing ${cards.length} card(s). Search narrows it; by default only claimed cards are listed.</p>`,
  );
}

// ---------- server ----------

export function startAdmin(client: Client): void {
  if (!PASSWORD) {
    console.log("admin dashboard disabled (set ADMIN_PASSWORD to enable)");
    return;
  }
  const port = Number(process.env.PORT ?? 8080);
  try {
    listen(port, client);
    console.log(`admin dashboard listening on :${port}`);
  } catch (err) {
    // The dashboard is a convenience; never let it take the bot down with it.
    console.error("admin dashboard failed to start:", err);
  }
}

function listen(port: number, client: Client): void {
  Bun.serve({
    port,
    idleTimeout: 30,
    async fetch(req) {
      const url = new URL(req.url);
      const signedIn = tokenIsValid(cookieFrom(req));

      if (url.pathname === "/login" && req.method === "POST") {
        const form = await req.formData();
        if (timingSafeEqual(String(form.get("password") ?? ""), PASSWORD)) {
          return redirect("/", {
            "set-cookie": `${COOKIE}=${issueToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}; Secure`,
          });
        }
        await Bun.sleep(600); // slow down guessing
        return loginPage("Wrong password");
      }
      if (url.pathname === "/logout") {
        return redirect("/", { "set-cookie": `${COOKIE}=; HttpOnly; Path=/; Max-Age=0` });
      }
      if (!signedIn) return loginPage();

      if (url.pathname === "/") return serversPage(client);

      const set = url.pathname.match(/^\/g\/(\d+)\/set$/);
      if (set && req.method === "POST") {
        const form = await req.formData();
        const guildId = set[1]!;
        const cardId = Number(form.get("card"));
        const userId = String(form.get("userId") || form.get("user") || "").trim();
        const back = String(form.get("back") ?? "");
        if (!/^\d{5,25}$/.test(userId)) return serverPage(client, guildId, new URL(`${url.origin}/g/${guildId}${back}`), "Pick a player or paste a valid user ID.");
        db.setOwner(guildId, cardId, userId);
        const who = await displayName(client, guildId, userId);
        return serverPage(client, guildId, new URL(`${url.origin}/g/${guildId}${back}`), `Card #${cardId} now belongs to ${who}.`);
      }

      const clear = url.pathname.match(/^\/g\/(\d+)\/clear$/);
      if (clear && req.method === "POST") {
        const form = await req.formData();
        const guildId = clear[1]!;
        const cardId = Number(form.get("card"));
        const back = String(form.get("back") ?? "");
        const removed = db.clearOwner(guildId, cardId);
        return serverPage(client, guildId, new URL(`${url.origin}/g/${guildId}${back}`), removed ? `Card #${cardId} is back in the pool.` : `Card #${cardId} was not owned.`);
      }

      const guildPage = url.pathname.match(/^\/g\/(\d+)$/);
      if (guildPage) return serverPage(client, guildPage[1]!, url);

      return new Response("Not found", { status: 404 });
    },
  });
}

export const _internals = { tokenIsValid, issueToken, timingSafeEqual };
