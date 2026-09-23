// Game settings. Edit freely.

export type Rarity = "عادية" | "مميزة" | "نادرة" | "أسطورية" | "الملكة" | "المنتخب" | "كيرك";

// Rarity tiers, lowest to highest.
// weight = how often /roll lands on this tier (relative)
// points = score in /top
export const RARITIES: Record<Rarity, { weight: number; points: number; emoji: string; color: number }> = {
  "عادية":   { weight: 50, points: 1,  emoji: "⚪", color: 0x95a5a6 },
  "مميزة":   { weight: 28, points: 3,  emoji: "🟢", color: 0x2ecc71 },
  "نادرة":   { weight: 14, points: 8,  emoji: "🔵", color: 0x3498db },
  "أسطورية": { weight: 6,  points: 20, emoji: "🟣", color: 0x9b59b6 },
  "الملكة":  { weight: 2,  points: 50, emoji: "👑", color: 0xf1c40f },
  "المنتخب": { weight: 1,  points: 100, emoji: "⚽", color: 0x000000 }, // sports / black-shirt shots only
  "كيرك":    { weight: 0.5, points: 910, emoji: "🩷", color: 0xff69b4 }, // the Kirkified meme, rarest of all
};
export const RARITY_ORDER = Object.keys(RARITIES) as Rarity[];

/**
 * Tiers that exist but are never named in public listings like /deck. Their cards still count
 * in totals, so the numbers stay truthful; the tier just is not advertised.
 */
export const SECRET_RARITIES: Rarity[] = ["المنتخب", "كيرك"];

export const ROLLS_PER_RESET = 5;        // rolls each player gets per window
export const ROLL_RESET_HOURS = 2;       // rolls refill for everyone together every this many hours (windows start at midnight)
export const CLAIM_COOLDOWN_HOURS = 3;   // one claim, then wait this long from the moment you claimed
export const CLAIM_WINDOW_SECONDS = 30;  // how long the claim button stays alive after a roll
export const EXCHANGE_WINDOW_SECONDS = 300;
export const COLLECTION_IDLE_SECONDS = 120; // /collection browsing buttons grey out after this long without a click
export const ROLL_ONLY_UNCLAIMED = true; // true: /roll only shows cards nobody in the server owns yet

// Card Rush: every few hours the bot drops a card in the channel it was last used in.
// First to press the button keeps it, for free, and it never expires.
export const RUSH_MIN_HOURS = 2;   // shortest wait between drops
export const RUSH_MAX_HOURS = 6;   // longest wait between drops
export const RUSH_MIN_RARITY: Rarity = "نادرة"; // drops are never worse than this

// Duel: stake one of your cards against someone else's. A coin flip decides; winner takes both.
// Stakes are free on purpose, so a newcomer can win big. The defender has to accept, which is the safeguard.
// There is no daily cap: the other side must agree to every duel, so that consent is the throttle.
export const DUEL_WINDOW_SECONDS = 300;  // how long the other side has to answer
export const DUEL_MAX_CARDS = 10;        // most cards one side may stake, so nobody gambles a whole collection
export const DUEL_LIST_LIMIT = 10;       // cards listed by name before an embed field summarises the rest
export const DUEL_SUSPENSE_MS = 1000;    // pause between the spin frames before the result. 0 reveals instantly

export const IMAGES_DIR = "images";
// Optional: serve card images from a public URL instead of uploading them as attachments.
// Leave empty ("") to upload attachments. Only works with a PUBLIC repo.
export const IMAGE_BASE_URL = "https://raw.githubusercontent.com/anas1412/Haifu-Rolls/main/images";
// Where the SQLite file lives. On hosts with a persistent volume, point this at it, e.g. DB_PATH=/data/haifa.db
export const DB_PATH = process.env.DB_PATH || "haifa.db";
