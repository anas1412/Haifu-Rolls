// Season lifecycle: medals, archiving, all-time totals, tie-breaks.
//   bun test
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "haifu-test-")), "t.db");
process.env.DISCORD_TOKEN = "dummy"; // lets index.ts load without connecting
const db = await import("./db");
db.init();

const G = "1534906366068658196";
const [A, B, C] = ["111111111111111111", "222222222222222222", "333333333333333333"];

const card: Record<string, number> = {};
for (const [name, rarity] of [["ع1", "عادية"], ["ع2", "عادية"], ["م1", "مميزة"], ["م2", "مميزة"], ["ن1", "نادرة"], ["ك1", "الملكة"]] as const) {
  card[name] = db.addCard(`${name}.jpg`, name, rarity, "d");
}
const totalPoints = (season: number, user: string) => db.seasonTop(G, season).find((s) => s.userId === user)?.points ?? 0;

test("a fresh server starts on season 1", () => {
  expect(db.currentSeason(G)).toBe(1);
});

test("season 1 closes when the last card is taken and pays 5/4/3", () => {
  db.claimFree(G, card["ك1"]!, A); // 50
  db.claimFree(G, card["ن1"]!, B); // 8
  db.claimFree(G, card["م1"]!, B); // +3 = 11
  db.claimFree(G, card["م2"]!, C); // 3
  db.claimFree(G, card["ع1"]!, C); // +1
  db.claimFree(G, card["ع2"]!, C); // +1 = 5

  expect(Object.values(db.poolCounts(G)).every((n) => !n)).toBe(true);
  expect([totalPoints(1, A), totalPoints(1, B), totalPoints(1, C)]).toEqual([50, 11, 5]);
  expect(db.closeSeason(G)).toEqual([
    { userId: A, place: 1, points: 5 },
    { userId: B, place: 2, points: 4 },
    { userId: C, place: 3, points: 3 },
  ]);
  expect(db.currentSeason(G)).toBe(2);
});

test("the new season frees every card but keeps the old one readable", () => {
  expect(Object.values(db.poolCounts(G)).reduce((a, b) => a + (b ?? 0), 0)).toBe(6);
  expect(db.collection(G, A)).toHaveLength(0);
  expect(db.collection(G, A, 1)).toHaveLength(1); // archived, not deleted
  expect(totalPoints(1, A)).toBe(50);
});

test("all-time medals accumulate across seasons and never reset", () => {
  db.claimFree(G, card["ك1"]!, C); // 50
  db.claimFree(G, card["ن1"]!, A);
  db.claimFree(G, card["م1"]!, A); // 11
  db.claimFree(G, card["م2"]!, B);
  db.claimFree(G, card["ع1"]!, B);
  db.claimFree(G, card["ع2"]!, B); // 5
  expect(db.closeSeason(G)).toEqual([
    { userId: C, place: 1, points: 5 },
    { userId: A, place: 2, points: 4 },
    { userId: B, place: 3, points: 3 },
  ]);

  const all = db.allTimeLeaderboard(G);
  expect(Object.fromEntries(all.map((r) => [r.userId, r.points]))).toEqual({ [A]: 9, [C]: 8, [B]: 7 });
  expect(all[0]).toMatchObject({ userId: A, seasons: 2, golds: 1 });
});

test("a points tie goes to whoever holds more cards", () => {
  const G2 = "9876543210987654321";
  const one = db.addCard("t0.jpg", "ت0", "مميزة", "d"); // 3 points in one card
  const many = ["ت1", "ت2", "ت3"].map((n) => db.addCard(`${n}.jpg`, n, "عادية", "d")); // 3 points in three
  db.claimFree(G2, one, A);
  for (const c of many) db.claimFree(G2, c, B);

  const board = db.seasonTop(G2, 1);
  expect(board.map((s) => s.userId)).toEqual([B, A]);
  expect(board[0]!.points).toBe(board[1]!.points);
});

test("a server where nobody played never closes a season", () => {
  const quiet = "555555555555555555";
  expect(db.closeSeason(quiet)).toEqual([]);
  expect(db.currentSeason(quiet)).toBe(1);
});

test("cards can be found by number, with or without a #", () => {
  const id = db.addCard("find.jpg", "كرت البحث", "نادرة", "d");
  expect(db.findCard(String(id))?.id).toBe(id);
  expect(db.findCard(`#${id}`)?.id).toBe(id);
  expect(db.findCard(` ${id} `)?.id).toBe(id);
  expect(db.findCard("كرت البحث")?.id).toBe(id);   // exact name still works
  expect(db.findCard("البحث")?.id).toBe(id);       // partial name still works
  expect(db.findCard("999999")).toBeNull();        // unknown number, not a crash
  expect(db.findCard("لا يوجد")).toBeNull();
});

// ---------- duels ----------

const D = "7777777777777777777"; // its own guild, so season state above cannot interfere

test("a duel hands both staked cards to the winner", () => {
  const a = db.addCard("d1.jpg", "د1", "نادرة", "d"), b = db.addCard("d2.jpg", "د2", "أسطورية", "d");
  db.claimFree(D, a, A);
  db.claimFree(D, b, B);

  db.awardDuel(D, a, A, b, B, B); // B wins
  expect(db.ownerOf(D, a)).toBe(B);
  expect(db.ownerOf(D, b)).toBe(B);
});

test("the challenger winning keeps their own card and takes the other", () => {
  const a = db.addCard("d3.jpg", "د3", "نادرة", "d"), b = db.addCard("d4.jpg", "د4", "مميزة", "d");
  db.claimFree(D, a, A);
  db.claimFree(D, b, B);

  db.awardDuel(D, a, A, b, B, A); // A wins: card a is "moved" to its existing owner
  expect(db.ownerOf(D, a)).toBe(A);
  expect(db.ownerOf(D, b)).toBe(A);
});

test("a duel whose stake moved first is rejected and changes nothing", () => {
  const a = db.addCard("d5.jpg", "د5", "نادرة", "d"), b = db.addCard("d6.jpg", "د6", "مميزة", "d");
  db.claimFree(D, a, A);
  db.claimFree(D, b, B);
  db.transfer(D, b, B, C); // B gifts the stake away while the offer is open

  expect(() => db.awardDuel(D, a, A, b, B, A)).toThrow();
  expect(db.ownerOf(D, a)).toBe(A); // rolled back, A did not lose or gain anything
  expect(db.ownerOf(D, b)).toBe(C);
});

test("duels started are capped per day", () => {
  const fresh = "8888888888888888888";
  expect(db.duelsToday(fresh, A)).toBe(0);
  db.recordDuel(fresh, A);
  db.recordDuel(fresh, A);
  expect(db.duelsToday(fresh, A)).toBe(2);
  expect(db.duelsToday(fresh, B)).toBe(0); // per player, not per server
});

// ---------- rolls: no repeats within a day ----------

const { pickCard } = await import("./index");
const P = "6666666666666666666"; // fresh guild for roll tests

const { RARITY_ORDER } = await import("./config");
const allFreeIds = (g: string) => RARITY_ORDER.flatMap((t) => db.cardsInRarity(t, g).map((c) => c.id));

test("a card already rolled today is never offered again", () => {
  const excluded = allFreeIds(P).slice(0, 3);
  expect(excluded.length).toBe(3);
  for (let n = 0; n < 300; n++) {
    const got = pickCard(P, undefined, excluded)!;
    expect(excluded).not.toContain(got.id); // the whole point of the fix
  }
});

test("repeats are allowed again only when nothing new is left", () => {
  const solo = "5555000055550000555";
  const everything = allFreeIds(solo); // exclude the entire deck, every tier
  expect(everything.length).toBeGreaterThan(0);
  const got = pickCard(solo, undefined, everything);
  expect(got).not.toBeNull(); // must fall back rather than refuse to roll
  expect(everything).toContain(got!.id);
});

test("an exhausted deck still returns nothing", () => {
  const empty = "4444000044440000444";
  for (const c of db.cardsInRarity("عادية", empty)) db.claimFree(empty, c.id, A);
  for (const tier of ["مميزة", "نادرة", "أسطورية", "الملكة", "المنتخب"] as const) {
    for (const c of db.cardsInRarity(tier, empty)) db.claimFree(empty, c.id, A);
  }
  expect(pickCard(empty, undefined, [])).toBeNull();
});

test("rolls remember which card they showed", () => {
  const g = "3333000033330000333";
  const card = db.addCard("r5.jpg", "r5", "نادرة", "d");
  expect(db.cardsRolledToday(g, A)).toEqual([]);
  db.recordRoll(g, A, card);
  expect(db.cardsRolledToday(g, A)).toEqual([card]);
  expect(db.cardsRolledToday(g, B)).toEqual([]); // per player
  expect(db.rollsToday(g, A)).toBe(1);
});

// ---------- /deck ----------

test("the deck breakdown counts claimed and free per rarity", () => {
  const g = "2222000022220000222";
  const a = db.addCard("k1.jpg", "ك1د", "نادرة", "d");
  db.addCard("k2.jpg", "ك2د", "نادرة", "d");
  db.claimFree(g, a, A);

  const rare = db.deckBreakdown(g).find((r) => r.rarity === "نادرة")!;
  expect(rare.claimed).toBe(1);
  expect(rare.total).toBeGreaterThanOrEqual(2);
  // every card in the deck is counted exactly once
  const total = db.deckBreakdown(g).reduce((n, r) => n + r.total, 0);
  expect(total).toBe(db.allNames().length);
});
