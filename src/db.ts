// SQLite storage (bun:sqlite): cards, ownership, daily limits. Ownership is per Discord server.
// Discord IDs are 64-bit snowflakes, bigger than a JS number can hold exactly, so they are
// passed around as strings and read back with CAST(... AS TEXT).
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH, RARITIES, type Rarity } from "./config";

export interface Card {
  id: number;
  file: string;
  name: string;
  rarity: Rarity;
  description: string;
}

mkdirSync(dirname(DB_PATH), { recursive: true });
let db = new Database(DB_PATH, { create: true });

/** A consistent snapshot of the whole database as bytes (for /backup). */
export function backupBytes(): Uint8Array {
  const tmp = `${DB_PATH}.backup-${Date.now()}`;
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  const bytes = readFileSync(tmp);
  rmSync(tmp);
  return bytes;
}

/** Replace the database file with the given bytes (for /restore) and reopen it. */
export function replaceDatabase(bytes: Uint8Array): void {
  if (!Buffer.from(bytes.subarray(0, 16)).toString("latin1").startsWith("SQLite format 3")) throw new Error("not a SQLite file");
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) if (existsSync(DB_PATH + suffix)) rmSync(DB_PATH + suffix);
  writeFileSync(DB_PATH, bytes);
  db = new Database(DB_PATH);
  init();
}

export function init(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY,
      file TEXT UNIQUE NOT NULL,
      name TEXT UNIQUE NOT NULL,
      rarity TEXT NOT NULL,
      description TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS claims (
      guild_id INTEGER NOT NULL,
      season INTEGER NOT NULL,
      card_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      claimed_at REAL NOT NULL,
      PRIMARY KEY (guild_id, season, card_id)
    );
    CREATE TABLE IF NOT EXISTS season_medals (
      guild_id INTEGER NOT NULL,
      season INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      place INTEGER NOT NULL,
      points INTEGER NOT NULL,
      PRIMARY KEY (guild_id, season, user_id)
    );
    CREATE TABLE IF NOT EXISTS rolls (
      guild_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      rolled_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS last_claim (
      guild_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      claimed_at REAL NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS guild_channel (
      guild_id INTEGER PRIMARY KEY,
      channel_id INTEGER NOT NULL
    );
  `);
  migrate();
  migrateRolls();
  dropDuelsTable();
}

/** Old databases have a claims table with no season. Rebuild it once, keeping every row as season 1. */
function migrate(): void {
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(claims)").all().map((c) => c.name);
  if (cols.includes("season")) return;
  db.exec(`
    BEGIN;
    CREATE TABLE claims_new (
      guild_id INTEGER NOT NULL,
      season INTEGER NOT NULL,
      card_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      claimed_at REAL NOT NULL,
      PRIMARY KEY (guild_id, season, card_id)
    );
    INSERT INTO claims_new (guild_id, season, card_id, user_id, claimed_at)
      SELECT guild_id, 1, card_id, user_id, claimed_at FROM claims;
    DROP TABLE claims;
    ALTER TABLE claims_new RENAME TO claims;
    COMMIT;
  `);
  console.log("migrated claims: every existing claim is now season 1");
}

/** Rolls used to record only that a roll happened. Track the card too, to avoid repeats within a day. */
/** Duels used to be capped per day. The tracking table is no longer read, so let it go. */
function dropDuelsTable(): void {
  db.exec("DROP TABLE IF EXISTS duels");
}

function migrateRolls(): void {
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(rolls)").all().map((c) => c.name);
  if (cols.includes("card_id")) return;
  db.exec("ALTER TABLE rolls ADD COLUMN card_id INTEGER"); // old rows keep NULL and simply exclude nothing
  console.log("migrated rolls: now recording which card was rolled");
}

const now = () => Date.now() / 1000;

// ---------- seasons ----------

/**
 * A season is only written down once it ends, so the live one is always "last closed + 1".
 * Seasons are per server: one guild can be on season 3 while another is still on 1.
 */
export function currentSeason(guildId: string): number {
  return db
    .query<{ n: number }, [string]>("SELECT COALESCE(MAX(season), 0) + 1 AS n FROM season_medals WHERE guild_id = ?")
    .get(guildId)!.n;
}

/** Highest season that has actually been played (closed seasons plus the live one). */
export function latestSeason(guildId: string): number {
  return currentSeason(guildId);
}

export interface Standing { userId: string; points: number; count: number; firstAt: number }

/** Card-point standings for one season. Ties: more points, then more cards, then who claimed first. */
export function seasonTop(guildId: string, season: number, limit = 10): Standing[] {
  const rows = db
    .query<{ user_id: string; rarity: Rarity; n: number; first_at: number }, [string, number]>(
      `SELECT CAST(k.user_id AS TEXT) AS user_id, c.rarity, COUNT(*) AS n, MIN(k.claimed_at) AS first_at
       FROM claims k JOIN cards c ON c.id = k.card_id
       WHERE k.guild_id = ? AND k.season = ? GROUP BY k.user_id, c.rarity`,
    )
    .all(guildId, season);
  const totals = new Map<string, Standing>();
  for (const r of rows) {
    const t = totals.get(r.user_id) ?? { userId: r.user_id, points: 0, count: 0, firstAt: Infinity };
    t.points += RARITIES[r.rarity].points * r.n;
    t.count += r.n;
    t.firstAt = Math.min(t.firstAt, r.first_at);
    totals.set(r.user_id, t);
  }
  return [...totals.values()]
    .sort((x, y) => y.points - x.points || y.count - x.count || x.firstAt - y.firstAt)
    .slice(0, limit);
}

/** Medal points awarded to the top five when a season ends. */
export const MEDAL_POINTS = [5, 4, 3, 2, 1];

/**
 * Close the live season: award medals to the top five and archive them.
 * Claims are kept, so past collections stay readable; the next season simply ignores them.
 */
export function closeSeason(guildId: string): { userId: string; place: number; points: number }[] {
  const season = currentSeason(guildId);
  const medals = seasonTop(guildId, season, MEDAL_POINTS.length).map((s, i) => ({
    userId: s.userId,
    place: i + 1,
    points: MEDAL_POINTS[i]!,
  }));
  if (!medals.length) return []; // nobody played; leave the season open
  const insert = db.query("INSERT OR REPLACE INTO season_medals (guild_id, season, user_id, place, points) VALUES (?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (const m of medals) insert.run(guildId, season, m.userId, m.place, m.points);
  })();
  return medals;
}

/** All-time table: medal points summed over every finished season. Never resets. */
export function allTimeLeaderboard(guildId: string, limit = 10): { userId: string; points: number; seasons: number; golds: number }[] {
  return db
    .query<{ userId: string; points: number; seasons: number; golds: number }, [string, number]>(
      `SELECT CAST(user_id AS TEXT) AS userId, SUM(points) AS points, COUNT(*) AS seasons,
              SUM(CASE WHEN place = 1 THEN 1 ELSE 0 END) AS golds
       FROM season_medals WHERE guild_id = ?
       GROUP BY user_id ORDER BY points DESC, golds DESC LIMIT ?`,
    )
    .all(guildId, limit);
}

// ---------- cards ----------

export function addCard(file: string, name: string, rarity: Rarity, description: string): number {
  const r = db.query("INSERT INTO cards (file, name, rarity, description) VALUES (?, ?, ?, ?)").run(file, name, rarity, description);
  return Number(r.lastInsertRowid);
}

/** Change a known card's rarity (seed.json edits). True if it changed. */
export function setRarity(file: string, rarity: Rarity): boolean {
  return db.query("UPDATE cards SET rarity = ? WHERE file = ? AND rarity <> ?").run(rarity, file, rarity).changes === 1;
}

export function knownFiles(): Set<string> {
  return new Set(db.query<{ file: string }, []>("SELECT file FROM cards").all().map((r) => r.file));
}

export function allNames(): string[] {
  return db.query<{ name: string }, []>("SELECT name FROM cards").all().map((r) => r.name);
}

/** All cards of a rarity; with unclaimedIn = guild id, only those nobody in that server owns. */
export function cardsInRarity(rarity: Rarity, unclaimedIn?: string): Card[] {
  if (unclaimedIn === undefined) return db.query<Card, [string]>("SELECT * FROM cards WHERE rarity = ?").all(rarity);
  return db
    .query<Card, [string, number, string]>(
      `SELECT c.* FROM cards c LEFT JOIN claims k ON k.card_id = c.id AND k.guild_id = ? AND k.season = ?
       WHERE c.rarity = ? AND k.card_id IS NULL`,
    )
    .all(unclaimedIn, currentSeason(unclaimedIn), rarity);
}

export function getCard(id: number): Card | null {
  return db.query<Card, [number]>("SELECT * FROM cards WHERE id = ?").get(id);
}

/** Card number first (names are awkward to type), then exact name, then substring. */
export function findCard(query: string): Card | null {
  const q = query.trim().replace(/^#/, "");
  if (/^\d+$/.test(q)) {
    const byId = getCard(Number(q));
    if (byId) return byId;
  }
  return (
    db.query<Card, [string]>("SELECT * FROM cards WHERE name = ?").get(q) ??
    db.query<Card, [string]>("SELECT * FROM cards WHERE name LIKE ? ORDER BY name LIMIT 1").get(`%${q}%`)
  );
}

/** Cards per rarity; with unclaimedIn = guild id, only those nobody in that server owns. */
export function poolCounts(unclaimedIn?: string): Partial<Record<Rarity, number>> {
  const rows =
    unclaimedIn === undefined
      ? db.query<{ rarity: Rarity; n: number }, []>("SELECT rarity, COUNT(*) AS n FROM cards GROUP BY rarity").all()
      : db
          .query<{ rarity: Rarity; n: number }, [string, number]>(
            `SELECT c.rarity, COUNT(*) AS n FROM cards c
             LEFT JOIN claims k ON k.card_id = c.id AND k.guild_id = ? AND k.season = ?
             WHERE k.card_id IS NULL GROUP BY c.rarity`,
          )
          .all(unclaimedIn, currentSeason(unclaimedIn));
  return Object.fromEntries(rows.map((r) => [r.rarity, r.n]));
}

// ---------- ownership ----------

export function ownerOf(guildId: string, cardId: number): string | null {
  const row = db
    .query<{ user_id: string }, [string, number, number]>(
      "SELECT CAST(user_id AS TEXT) AS user_id FROM claims WHERE guild_id = ? AND season = ? AND card_id = ?",
    )
    .get(guildId, currentSeason(guildId), cardId);
  return row?.user_id ?? null;
}

/** True if the claim succeeded, false if someone got there first. */
export function claim(guildId: string, cardId: number, userId: string): boolean {
  try {
    db.query("INSERT INTO claims (guild_id, season, card_id, user_id, claimed_at) VALUES (?, ?, ?, ?, ?)")
      .run(guildId, currentSeason(guildId), cardId, userId, now());
  } catch {
    return false;
  }
  db.query("INSERT OR REPLACE INTO last_claim (guild_id, user_id, claimed_at) VALUES (?, ?, ?)").run(guildId, userId, now());
  return true;
}

export function release(guildId: string, cardId: number, userId: string): boolean {
  return (
    db.query("DELETE FROM claims WHERE guild_id = ? AND season = ? AND card_id = ? AND user_id = ?")
      .run(guildId, currentSeason(guildId), cardId, userId).changes === 1
  );
}

export function transfer(guildId: string, cardId: number, fromUser: string, toUser: string): boolean {
  return (
    db.query("UPDATE claims SET user_id = ? WHERE guild_id = ? AND season = ? AND card_id = ? AND user_id = ?")
      .run(toUser, guildId, currentSeason(guildId), cardId, fromUser).changes === 1
  );
}

/** Atomically trade cardA (owned by userA) for cardB (owned by userB). Throws if ownership changed. */
export function swap(guildId: string, cardA: number, userA: string, cardB: number, userB: string): void {
  const season = currentSeason(guildId);
  db.transaction(() => {
    const q = db.query("UPDATE claims SET user_id = ? WHERE guild_id = ? AND season = ? AND card_id = ? AND user_id = ?");
    const a = q.run(userB, guildId, season, cardA, userA).changes;
    const b = q.run(userA, guildId, season, cardB, userB).changes;
    if (a !== 1 || b !== 1) throw new Error("ownership changed"); // rolls the transaction back
  })();
}

export function collection(guildId: string, userId: string, season = currentSeason(guildId)): Card[] {
  return db
    .query<Card, [string, number, string]>(
      `SELECT c.* FROM cards c JOIN claims k ON k.card_id = c.id
       WHERE k.guild_id = ? AND k.season = ? AND k.user_id = ? ORDER BY c.name`,
    )
    .all(guildId, season, userId);
}


// ---------- card rush ----------

/** Remember where the bot was last used in a server; that is where rush cards drop. */
export function setLastChannel(guildId: string, channelId: string): void {
  db.query("INSERT OR REPLACE INTO guild_channel (guild_id, channel_id) VALUES (?, ?)").run(guildId, channelId);
}

export function getLastChannel(guildId: string): string | null {
  const row = db
    .query<{ channel_id: string }, [string]>("SELECT CAST(channel_id AS TEXT) AS channel_id FROM guild_channel WHERE guild_id = ?")
    .get(guildId);
  return row?.channel_id ?? null;
}

/** Claim with no daily cost: used by rush drops, which are free. */
export function claimFree(guildId: string, cardId: number, userId: string): boolean {
  try {
    db.query("INSERT INTO claims (guild_id, season, card_id, user_id, claimed_at) VALUES (?, ?, ?, ?, ?)")
      .run(guildId, currentSeason(guildId), cardId, userId, now());
  } catch {
    return false;
  }
  return true;
}

// ---------- daily limits (reset at local midnight) ----------

export function dayStart(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() / 1000;
}

export function secondsUntilMidnight(): number {
  return dayStart() + 86400 - now();
}

export function rollsToday(guildId: string, userId: string): number {
  return db
    .query<{ n: number }, [string, string, number]>("SELECT COUNT(*) AS n FROM rolls WHERE guild_id = ? AND user_id = ? AND rolled_at >= ?")
    .get(guildId, userId, dayStart())!.n;
}

export function recordRoll(guildId: string, userId: string, cardId: number): void {
  db.query("INSERT INTO rolls (guild_id, user_id, rolled_at, card_id) VALUES (?, ?, ?, ?)").run(guildId, userId, now(), cardId);
  db.query("DELETE FROM rolls WHERE rolled_at < ?").run(dayStart());
}

/** Cards this player has already been shown today, so their remaining rolls can avoid them. */
export function cardsRolledToday(guildId: string, userId: string): number[] {
  return db
    .query<{ card_id: number }, [string, string, number]>(
      "SELECT card_id FROM rolls WHERE guild_id = ? AND user_id = ? AND rolled_at >= ? AND card_id IS NOT NULL",
    )
    .all(guildId, userId, dayStart())
    .map((r) => r.card_id);
}

/** Per-rarity breakdown of the whole deck for this server's live season. */
export function deckBreakdown(guildId: string): { rarity: Rarity; total: number; claimed: number }[] {
  return db
    .query<{ rarity: Rarity; total: number; claimed: number }, [string, number]>(
      `SELECT c.rarity, COUNT(*) AS total, SUM(CASE WHEN k.card_id IS NULL THEN 0 ELSE 1 END) AS claimed
       FROM cards c LEFT JOIN claims k ON k.card_id = c.id AND k.guild_id = ? AND k.season = ?
       GROUP BY c.rarity`,
    )
    .all(guildId, currentSeason(guildId));
}

/**
 * Hand both staked cards to the winner, all or nothing.
 * Throws if either card changed hands while the offer was open, so nothing is ever duplicated.
 */
export function awardDuel(guildId: string, cardA: number, userA: string, cardB: number, userB: string, winner: string): void {
  const season = currentSeason(guildId);
  db.transaction(() => {
    const q = db.query("UPDATE claims SET user_id = ? WHERE guild_id = ? AND season = ? AND card_id = ? AND user_id = ?");
    const a = q.run(winner, guildId, season, cardA, userA).changes;
    const b = q.run(winner, guildId, season, cardB, userB).changes;
    if (a !== 1 || b !== 1) throw new Error("ownership changed"); // rolls back
  })();
}

export function claimedToday(guildId: string, userId: string): boolean {
  const row = db
    .query<{ claimed_at: number }, [string, string]>("SELECT claimed_at FROM last_claim WHERE guild_id = ? AND user_id = ?")
    .get(guildId, userId);
  return row !== null && row.claimed_at >= dayStart();
}
