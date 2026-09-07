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
      card_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      claimed_at REAL NOT NULL,
      PRIMARY KEY (guild_id, card_id)
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
  `);
}

const now = () => Date.now() / 1000;

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
    .query<Card, [string, string]>(
      `SELECT c.* FROM cards c LEFT JOIN claims k ON k.card_id = c.id AND k.guild_id = ?
       WHERE c.rarity = ? AND k.card_id IS NULL`,
    )
    .all(unclaimedIn, rarity);
}

export function getCard(id: number): Card | null {
  return db.query<Card, [number]>("SELECT * FROM cards WHERE id = ?").get(id);
}

/** Exact name first, then substring match. */
export function findCard(query: string): Card | null {
  return (
    db.query<Card, [string]>("SELECT * FROM cards WHERE name = ?").get(query) ??
    db.query<Card, [string]>("SELECT * FROM cards WHERE name LIKE ? ORDER BY name LIMIT 1").get(`%${query}%`)
  );
}

/** Cards per rarity; with unclaimedIn = guild id, only those nobody in that server owns. */
export function poolCounts(unclaimedIn?: string): Partial<Record<Rarity, number>> {
  const rows =
    unclaimedIn === undefined
      ? db.query<{ rarity: Rarity; n: number }, []>("SELECT rarity, COUNT(*) AS n FROM cards GROUP BY rarity").all()
      : db
          .query<{ rarity: Rarity; n: number }, [string]>(
            `SELECT c.rarity, COUNT(*) AS n FROM cards c
             LEFT JOIN claims k ON k.card_id = c.id AND k.guild_id = ?
             WHERE k.card_id IS NULL GROUP BY c.rarity`,
          )
          .all(unclaimedIn);
  return Object.fromEntries(rows.map((r) => [r.rarity, r.n]));
}

// ---------- ownership ----------

export function ownerOf(guildId: string, cardId: number): string | null {
  const row = db
    .query<{ user_id: string }, [string, number]>("SELECT CAST(user_id AS TEXT) AS user_id FROM claims WHERE guild_id = ? AND card_id = ?")
    .get(guildId, cardId);
  return row?.user_id ?? null;
}

/** True if the claim succeeded, false if someone got there first. */
export function claim(guildId: string, cardId: number, userId: string): boolean {
  try {
    db.query("INSERT INTO claims (guild_id, card_id, user_id, claimed_at) VALUES (?, ?, ?, ?)").run(guildId, cardId, userId, now());
  } catch {
    return false;
  }
  db.query("INSERT OR REPLACE INTO last_claim (guild_id, user_id, claimed_at) VALUES (?, ?, ?)").run(guildId, userId, now());
  return true;
}

export function release(guildId: string, cardId: number, userId: string): boolean {
  return db.query("DELETE FROM claims WHERE guild_id = ? AND card_id = ? AND user_id = ?").run(guildId, cardId, userId).changes === 1;
}

export function transfer(guildId: string, cardId: number, fromUser: string, toUser: string): boolean {
  return (
    db.query("UPDATE claims SET user_id = ? WHERE guild_id = ? AND card_id = ? AND user_id = ?").run(toUser, guildId, cardId, fromUser)
      .changes === 1
  );
}

/** Atomically trade cardA (owned by userA) for cardB (owned by userB). Throws if ownership changed. */
export function swap(guildId: string, cardA: number, userA: string, cardB: number, userB: string): void {
  db.transaction(() => {
    const q = db.query("UPDATE claims SET user_id = ? WHERE guild_id = ? AND card_id = ? AND user_id = ?");
    const a = q.run(userB, guildId, cardA, userA).changes;
    const b = q.run(userA, guildId, cardB, userB).changes;
    if (a !== 1 || b !== 1) throw new Error("ownership changed"); // rolls the transaction back
  })();
}

export function collection(guildId: string, userId: string): Card[] {
  return db
    .query<Card, [string, string]>(
      `SELECT c.* FROM cards c JOIN claims k ON k.card_id = c.id
       WHERE k.guild_id = ? AND k.user_id = ? ORDER BY c.name`,
    )
    .all(guildId, userId);
}

export function leaderboard(guildId: string, limit = 10): { userId: string; points: number; count: number }[] {
  const rows = db
    .query<{ user_id: string; rarity: Rarity; n: number }, [string]>(
      `SELECT CAST(k.user_id AS TEXT) AS user_id, c.rarity, COUNT(*) AS n
       FROM claims k JOIN cards c ON c.id = k.card_id WHERE k.guild_id = ? GROUP BY k.user_id, c.rarity`,
    )
    .all(guildId);
  const totals = new Map<string, { points: number; count: number }>();
  for (const r of rows) {
    const t = totals.get(r.user_id) ?? { points: 0, count: 0 };
    t.points += RARITIES[r.rarity].points * r.n;
    t.count += r.n;
    totals.set(r.user_id, t);
  }
  return [...totals].map(([userId, t]) => ({ userId, ...t })).sort((x, y) => y.points - x.points).slice(0, limit);
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

export function recordRoll(guildId: string, userId: string): void {
  db.query("INSERT INTO rolls (guild_id, user_id, rolled_at) VALUES (?, ?, ?)").run(guildId, userId, now());
  db.query("DELETE FROM rolls WHERE rolled_at < ?").run(dayStart());
}

export function claimedToday(guildId: string, userId: string): boolean {
  const row = db
    .query<{ claimed_at: number }, [string, string]>("SELECT claimed_at FROM last_claim WHERE guild_id = ? AND user_id = ?")
    .get(guildId, userId);
  return row !== null && row.claimed_at >= dayStart();
}
