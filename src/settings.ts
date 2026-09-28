/**
 * Game settings that can be changed from the dashboard without a deploy.
 *
 * Three layers, later wins: the defaults in config.ts, then the global overrides, then a server's own
 * overrides. Only changed values are stored, so a setting nobody touched keeps following the default.
 * Every value is checked before it is saved, so a typo in the dashboard can't break the game.
 */
import {
  CLAIM_WINDOW_SECONDS, COLLECTION_IDLE_SECONDS, DUEL_LIST_LIMIT, DUEL_MAX_CARDS, DUEL_SUSPENSE_MS,
  DUEL_WINDOW_SECONDS, EXCHANGE_WINDOW_SECONDS, MEDAL_POINTS, RARITIES, RARITY_ORDER, ROLL_ONLY_UNCLAIMED,
  ROLL_RESET_HOURS, ROLLS_PER_RESET, RUSH_MAX_HOURS, RUSH_MAX_RARITY, RUSH_MIN_HOURS, RUSH_MIN_RARITY, type Rarity,
} from "./config";
import * as db from "./db";

export type Tier = { weight: number; points: number; claimHours: number };

export interface Settings {
  rollsPerReset: number;
  rollResetHours: number;
  claimWindowSeconds: number;
  rollOnlyUnclaimed: boolean;
  exchangeWindowSeconds: number;
  collectionIdleSeconds: number;
  duelWindowSeconds: number;
  duelMaxCards: number;
  duelListLimit: number;
  duelSuspenseMs: number;
  rushMinHours: number;
  rushMaxHours: number;
  rushMinRarity: Rarity;
  rushMaxRarity: Rarity;
  medalPoints: number[];
  tiers: Record<Rarity, Tier>;
}

export const DEFAULTS: Settings = {
  rollsPerReset: ROLLS_PER_RESET,
  rollResetHours: ROLL_RESET_HOURS,
  claimWindowSeconds: CLAIM_WINDOW_SECONDS,
  rollOnlyUnclaimed: ROLL_ONLY_UNCLAIMED,
  exchangeWindowSeconds: EXCHANGE_WINDOW_SECONDS,
  collectionIdleSeconds: COLLECTION_IDLE_SECONDS,
  duelWindowSeconds: DUEL_WINDOW_SECONDS,
  duelMaxCards: DUEL_MAX_CARDS,
  duelListLimit: DUEL_LIST_LIMIT,
  duelSuspenseMs: DUEL_SUSPENSE_MS,
  rushMinHours: RUSH_MIN_HOURS,
  rushMaxHours: RUSH_MAX_HOURS,
  rushMinRarity: RUSH_MIN_RARITY,
  rushMaxRarity: RUSH_MAX_RARITY,
  medalPoints: MEDAL_POINTS,
  tiers: Object.fromEntries(RARITY_ORDER.map((r) => [r, { weight: RARITIES[r].weight, points: RARITIES[r].points, claimHours: RARITIES[r].claimHours }])) as Record<Rarity, Tier>,
};

// ---------- what the dashboard shows, and what is allowed ----------

type Scalar = Exclude<keyof Settings, "tiers" | "medalPoints">;
export type Field = {
  key: Scalar;
  group: string;
  label: string;
  help: string;
  type: "int" | "number" | "bool" | "rarity";
  min?: number;
  max?: number;
  unit?: string;
};

export const FIELDS: Field[] = [
  { key: "rollsPerReset", group: "Rolling", label: "Rolls per refill", help: "How many /roll each player gets before waiting.", type: "int", min: 1, max: 50 },
  { key: "rollResetHours", group: "Rolling", label: "Rolls refill every", help: "Everyone's rolls come back together, counted from midnight.", type: "number", min: 0.25, max: 24, unit: "hours" },
  { key: "rollOnlyUnclaimed", group: "Rolling", label: "Only roll unclaimed cards", help: "Off: /roll can also show cards someone already owns.", type: "bool" },
  { key: "claimWindowSeconds", group: "Claiming", label: "Claim button stays for", help: "How long anyone in the channel can press claim after a roll.", type: "int", min: 5, max: 600, unit: "seconds" },
  { key: "exchangeWindowSeconds", group: "Trading and duels", label: "Exchange offer lasts", help: "Time the other member has to accept a /exchange.", type: "int", min: 30, max: 3600, unit: "seconds" },
  { key: "duelWindowSeconds", group: "Trading and duels", label: "Duel offer lasts", help: "Time the other member has to accept a /duel.", type: "int", min: 30, max: 3600, unit: "seconds" },
  { key: "duelMaxCards", group: "Trading and duels", label: "Most cards per duel side", help: "The largest stake one player can put up.", type: "int", min: 1, max: 50 },
  { key: "duelListLimit", group: "Trading and duels", label: "Cards named in a duel offer", help: "Beyond this the offer says \"and N more\".", type: "int", min: 1, max: 25 },
  { key: "duelSuspenseMs", group: "Trading and duels", label: "Pause between duel spin frames", help: "0 shows the result at once.", type: "int", min: 0, max: 5000, unit: "ms" },
  { key: "collectionIdleSeconds", group: "Trading and duels", label: "/collection buttons stay for", help: "Page buttons grey out after this long without a click.", type: "int", min: 10, max: 3600, unit: "seconds" },
  { key: "rushMinHours", group: "Card rush", label: "Shortest wait between drops", help: "Takes effect from the next drop.", type: "number", min: 0.1, max: 72, unit: "hours" },
  { key: "rushMaxHours", group: "Card rush", label: "Longest wait between drops", help: "Each drop lands at a random time between the two.", type: "number", min: 0.1, max: 72, unit: "hours" },
  { key: "rushMinRarity", group: "Card rush", label: "Lowest rarity that drops", help: "", type: "rarity" },
  { key: "rushMaxRarity", group: "Card rush", label: "Highest rarity that drops", help: "", type: "rarity" },
];

const TIER_LIMITS = {
  weight: { min: 0.01, max: 10_000, int: false },
  points: { min: 0, max: 100_000, int: true },
  claimHours: { min: 0, max: 72, int: false },
} as const;

// ---------- reading ----------

const cache = new Map<string, Settings>();

function merge(base: Settings, over: Record<string, unknown>): Settings {
  const out: Settings = { ...base, tiers: { ...base.tiers }, medalPoints: [...base.medalPoints] };
  for (const f of FIELDS) if (over[f.key] !== undefined) (out as unknown as Record<string, unknown>)[f.key] = over[f.key];
  if (Array.isArray(over.medalPoints)) out.medalPoints = over.medalPoints as number[];
  const tiers = (over.tiers ?? {}) as Partial<Record<Rarity, Partial<Tier>>>;
  for (const r of RARITY_ORDER) if (tiers[r]) out.tiers[r] = { ...out.tiers[r], ...tiers[r] };
  return out;
}

/** What the game actually uses in this server (or globally, without a server). */
export function settingsFor(guildId?: string | null): Settings {
  const key = guildId ?? "global";
  const hit = cache.get(key);
  if (hit) return hit;
  const global = merge(DEFAULTS, db.readSettings("global"));
  const s = guildId ? merge(global, db.readSettings(guildId)) : global;
  cache.set(key, s);
  return s;
}

export const overridesFor = (scope: string) => db.readSettings(scope);

// ---------- writing ----------

export type SaveResult = { ok: true } | { ok: false; errors: Record<string, string> };

/**
 * Replace a scope's overrides. Each value is checked on its own, then the merged result is checked as a
 * whole (the rush minimum can't be above its maximum), so nothing invalid is ever stored.
 */
export function saveOverrides(scope: string, input: Record<string, unknown>): SaveResult {
  const errors: Record<string, string> = {};
  const clean: Record<string, unknown> = {};

  for (const f of FIELDS) {
    const v = input[f.key];
    if (v === undefined || v === null || v === "") continue;
    if (f.type === "bool") {
      if (typeof v !== "boolean") errors[f.key] = "Pick yes or no.";
      else clean[f.key] = v;
    } else if (f.type === "rarity") {
      if (!RARITY_ORDER.includes(v as Rarity)) errors[f.key] = "Pick a rarity from the list.";
      else clean[f.key] = v;
    } else {
      const n = Number(v);
      if (!Number.isFinite(n)) errors[f.key] = "Enter a number.";
      else if (f.type === "int" && !Number.isInteger(n)) errors[f.key] = "Enter a whole number.";
      else if (f.min !== undefined && n < f.min) errors[f.key] = `The lowest allowed is ${f.min}.`;
      else if (f.max !== undefined && n > f.max) errors[f.key] = `The highest allowed is ${f.max}.`;
      else clean[f.key] = n;
    }
  }

  if (input.medalPoints !== undefined && input.medalPoints !== null) {
    const m = input.medalPoints;
    if (!Array.isArray(m) || m.length !== DEFAULTS.medalPoints.length || m.some((x) => !Number.isInteger(x) || x < 0 || x > 1000)) {
      errors.medalPoints = `Enter ${DEFAULTS.medalPoints.length} whole numbers from 0 to 1000.`;
    } else clean.medalPoints = m;
  }

  const tiers = (input.tiers ?? {}) as Record<string, Record<string, unknown>>;
  const cleanTiers: Record<string, Partial<Tier>> = {};
  for (const [r, t] of Object.entries(tiers)) {
    if (!RARITY_ORDER.includes(r as Rarity)) continue;
    for (const [k, lim] of Object.entries(TIER_LIMITS) as [keyof Tier, (typeof TIER_LIMITS)[keyof Tier]][]) {
      const v = t?.[k];
      if (v === undefined || v === null || v === "") continue;
      const n = Number(v);
      const at = `tiers.${r}.${k}`;
      if (!Number.isFinite(n)) errors[at] = "Enter a number.";
      else if (lim.int && !Number.isInteger(n)) errors[at] = "Enter a whole number.";
      else if (n < lim.min || n > lim.max) errors[at] = `Between ${lim.min} and ${lim.max}.`;
      else (cleanTiers[r] ??= {})[k] = n;
    }
  }
  if (Object.keys(cleanTiers).length) clean.tiers = cleanTiers;

  // Check the combination the game would actually run with.
  const parent = scope === "global" ? DEFAULTS : settingsFor();
  const result = merge(parent, clean);
  if (result.rushMinHours > result.rushMaxHours) errors.rushMaxHours = "Must be at least the shortest wait.";
  if (RARITY_ORDER.indexOf(result.rushMinRarity) > RARITY_ORDER.indexOf(result.rushMaxRarity)) errors.rushMaxRarity = "Must be the same as or rarer than the lowest.";

  if (Object.keys(errors).length) return { ok: false, errors };
  db.writeSettings(scope, clean);
  cache.clear(); // a global change reaches every server that doesn't override it
  return { ok: true };
}

/** For tests and after a database restore. */
export const clearSettingsCache = () => cache.clear();
