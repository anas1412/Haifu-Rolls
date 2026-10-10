// Preview the admin dashboard locally, without Discord and without touching the real database.
//
//   bun run dashboard      then open http://localhost:3002 and sign in with the password below
//
// It builds a throwaway demo database (the real deck from seed.json, two made-up servers, a dozen
// made-up players) and a stand-in Discord client that answers with invented names.
import type { Client } from "discord.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "haifu-dash-")), "demo.db");
process.env.ADMIN_PASSWORD ??= "local-dashboard"; // local test value only; the real one lives in Railway's variables
process.env.PORT ??= "3002";

const db = await import("../src/db");
const { RARITIES } = await import("../src/config");
db.init();
const seed = (await Bun.file(new URL("../seed.json", import.meta.url)).json()) as { file: string; name: string; rarity: keyof typeof RARITIES; description: string }[];
for (const c of seed) db.addCard(c.file, c.name, c.rarity, c.description);

const NAMES = ["Liurnia", "Yasuo hasagi tetti", "dooby", "nas", "Osswa", "Mimi", "Kaiser", "سلمى", "Rayen", "Wiss", "Lina", "Skander"];
const servers = [
  { id: "1534906366068658196", name: "9esm el a3sab", players: 12, share: 0.55 },
  { id: "1417579158220832800", name: "binchilin communist party", players: 4, share: 0.12 },
];
const cards = db.cardsWithOwners(servers[0]!.id, { limit: 1000 }).cards;
for (const s of servers) {
  for (const c of cards) {
    if (Math.random() > s.share) continue;
    const player = Math.floor(Math.pow(Math.random(), 1.7) * s.players); // a few big collectors, a long tail
    db.claimFree(s.id, c.id, String(100000000000000000n + BigInt(player)));
  }
}

// a few players are mid-wait, so the Players tab has something to reset
for (const s of servers) {
  db.cardsWithOwners(s.id, { owner: "none", limit: 3 }).cards.forEach((c, i) => db.claim(s.id, c.id, String(100000000000000000n + BigInt(i))));
}

const nameOf = (id: string) => NAMES[Number(BigInt(id) - 100000000000000000n) % NAMES.length] ?? id;
// every other player gets a picture, so both the photo and the letter fallback show up
const avatarOf = (id: string) => (Number(BigInt(id) % 2n) ? null : `/images/h${String((Number(BigInt(id) % 40n)) + 10)}.jpg`);
const member = (id: string) => ({
  id, displayName: nameOf(id), user: { bot: false, displayName: nameOf(id), displayAvatarURL: () => avatarOf(id) },
  displayAvatarURL: () => avatarOf(id),
});
const guild = (s: (typeof servers)[number]) => ({
  name: s.name, memberCount: 40 + s.players * 7, iconURL: () => null,
  members: {
    fetch: async (id: string) => member(id),
    search: async ({ query }: { query: string }) => new Map(
      Array.from({ length: s.players }, (_, i) => String(100000000000000000n + BigInt(i)))
        .filter((id) => nameOf(id).toLowerCase().includes(query.toLowerCase())).map((id) => [id, member(id)]),
    ),
  },
});
const client = {
  guilds: { cache: new Map(servers.map((s) => [s.id, guild(s)])) },
  users: { fetch: async (id: string) => member(id).user },
  isReady: () => true, user: { tag: "haifu-rolls#1287", displayAvatarURL: () => null },
  ws: { ping: 42 }, uptime: 3 * 3600_000,
} as unknown as Client;

const { startWeb } = await import("../src/web");
startWeb(client, async (guildId) => {
  const season = db.currentSeason(guildId);
  const medals = db.closeSeason(guildId);
  return medals.length ? { season, medals, posted: true, pinged: true, channel: "general" } : null;
});
console.log(`dashboard preview: http://localhost:${process.env.PORT}  (password: ${process.env.ADMIN_PASSWORD})`);
