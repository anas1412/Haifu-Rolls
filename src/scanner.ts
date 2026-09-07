// Scan images/ for new photos. Cards listed in seed.json keep their curated name and rarity;
// anything else gets a weighted dice roll and a name from the lists below.
import { existsSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import * as db from "./db";
import { IMAGES_DIR, RARITIES, RARITY_ORDER, type Rarity } from "./config";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const SEED_FILE = "seed.json";

interface SeedCard { file: string; name: string; rarity: Rarity; description: string }

// Card titles. Higher tiers pull from the more dramatic lists.
const TITLES: Record<Rarity, string[]> = {
  "عادية": [
    "هيفاء الصباح", "لقطة عفوية", "ابتسامة خفيفة", "هيفاء على الطبيعة", "نظرة سريعة",
    "يوم عادي مع الملكة", "هيفاء بالكاجوال", "لحظة هدوء", "همسة الظهيرة", "هيفاء بلا فلتر",
    "قهوة الصباح", "طلة بسيطة", "هيفاء في الشارع", "سيلفي الملكة", "لقطة من بعيد",
  ],
  "مميزة": [
    "لمسة أنوثة", "نظرة الواوا", "هيفاء بالأحمر", "طلة المساء", "ضحكة ياباي",
    "هيفاء بالأسود", "غمزة الملكة", "طلة الكاميرا", "سحر اللبنانية", "بوسة للجمهور",
    "هيفاء بالذهبي", "نظرة جانبية", "ألق الغروب", "هيفاء والورد", "لمعة العيون",
  ],
  "نادرة": [
    "ملكة المسرح", "أضواء بيروت", "هيفاء تحت الأضواء", "بوس الواوا", "نجمة الحفل",
    "سحر الشرق", "ليلة الفستان الأبيض", "هيفاء والميكروفون", "نظرة تذيب القلوب", "أيقونة الجمال",
    "طلة السجادة الحمراء", "هيفاء بالفضي", "رقصة الضوء", "لهيب المسرح", "أميرة الليل",
  ],
  "أسطورية": [
    "الوعوع الأسطورية", "ملكة الإغراء", "طلة القرن", "هيفاء الأيقونة", "ليلة الجوائز",
    "أسطورة الشاشة", "تاج الجمال العربي", "نجمة لا تنطفئ", "هيفاء في أبهى حللها", "ملكة السجادة",
    "سيدة الأضواء", "الفستان الذي أوقف الحفل", "هيفاء الخالدة", "جمال لا يُنسى", "طلة العمر",
  ],
  "الملكة": [
    "الملكة", "هيفاء وهبي", "أنا هيفاء", "الملكة المتوّجة", "أسطورة لبنان",
    "ملكة الملكات", "الطلة الخالدة", "لحظة التاريخ", "تاج الشرق", "الملكة بلا منازع",
  ],
  "المنتخب": ["الكابتن", "لاعبة الأساس", "المهاجمة", "صانعة الألعاب", "الهدف الذهبي", "الركلة الحرة", "المدرّجات"],
};

const DESCRIPTIONS: Record<Rarity, string[]> = {
  "عادية": ["لقطة عادية بس الملكة ما بتكون عادية أبداً.", "يوم من أيام هيفاء.", "بسيطة وحلوة."],
  "مميزة": ["فيها شي مميز... شو هو؟ شوف بنفسك.", "طلة لطيفة تخطف النظر.", "نظرة واحدة وبتفهم."],
  "نادرة": ["ما بتشوفها كل يوم.", "لقطة نادرة لملكة الطلات.", "احتفظ بها، صعب تلاقي مثلها."],
  "أسطورية": ["لحظة دخلت التاريخ.", "طلة حكى عنها الكل.", "الأسطورة بشخصها."],
  "الملكة": ["👑 الملكة فقط. لا تعليق.", "أندر ما يمكن أن تملكه.", "هيفاء في أعلى مراتب المجد."],
  "المنتخب": ["⚽ لباس رياضي والملكة في الملعب.", "أندر من هدف في الدقيقة 90.", "الكرت الذي يطلبه الجميع."],
};

const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

function weightedRarity(): Rarity {
  const total = RARITY_ORDER.reduce((s, r) => s + RARITIES[r].weight, 0);
  let roll = Math.random() * total;
  for (const r of RARITY_ORDER) {
    roll -= RARITIES[r].weight;
    if (roll < 0) return r;
  }
  return RARITY_ORDER[0]!;
}

function pickName(rarity: Rarity, taken: Set<string>): string {
  const free = TITLES[rarity].filter((t) => !taken.has(t));
  if (free.length) return pick(free);
  const base = pick(TITLES[rarity]);
  let n = 2;
  while (taken.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** Register every image in images/ that isn't in the DB yet. Returns the new cards. */
export async function scanNewImages(): Promise<db.Card[]> {
  const known = db.knownFiles();
  const taken = new Set(db.allNames());
  const seed = new Map<string, SeedCard>();
  if (existsSync(SEED_FILE)) {
    for (const c of (await Bun.file(SEED_FILE).json()) as SeedCard[]) seed.set(c.file, c);
  }
  const added: db.Card[] = [];
  for (const file of readdirSync(IMAGES_DIR).sort()) {
    if (!IMAGE_EXTS.has(extname(file).toLowerCase())) continue;
    if (known.has(file)) {
      // Already registered: only pick up rarity changes made in seed.json.
      const s = seed.get(file);
      if (s && db.setRarity(file, s.rarity)) console.log(`card ${file} -> rarity ${s.rarity}`);
      continue;
    }
    let rarity: Rarity, name: string, desc: string;
    const s = seed.get(file);
    if (s) {
      ({ rarity, description: desc } = s);
      name = taken.has(s.name) ? pickName(rarity, taken) : s.name;
    } else {
      rarity = weightedRarity();
      name = pickName(rarity, taken);
      desc = pick(DESCRIPTIONS[rarity]);
    }
    taken.add(name);
    const id = db.addCard(file, name, rarity, desc);
    added.push(db.getCard(id)!);
    console.log(`card ${join(IMAGES_DIR, file)} -> ${name} [${rarity}]`);
  }
  return added;
}
