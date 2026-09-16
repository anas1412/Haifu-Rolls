// Haifu Rolls - Mudae-style rolling and claiming for Haifa Wehbe cards. No currency.
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  DiscordAPIError,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  type Guild,
  type Interaction,
  type Message,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  User,
} from "discord.js";
import { join } from "node:path";
import * as db from "./db";
import { scanNewImages } from "./scanner";
import {
  CLAIM_WINDOW_SECONDS,
  COLLECTION_IDLE_SECONDS,
  DUEL_SUSPENSE_MS,
  DUEL_WINDOW_SECONDS,
  DUELS_PER_DAY,
  EXCHANGE_WINDOW_SECONDS,
  IMAGE_BASE_URL,
  IMAGES_DIR,
  RARITIES,
  RARITY_ORDER,
  ROLL_ONLY_UNCLAIMED,
  ROLLS_PER_DAY,
  RUSH_MAX_HOURS,
  RUSH_MIN_HOURS,
  RUSH_MIN_RARITY,
  SECRET_RARITIES,
} from "./config";

const token = process.env.DISCORD_TOKEN; // Bun loads .env automatically
if (!token) {
  console.error("DISCORD_TOKEN not set. Put it in .env as DISCORD_TOKEN=... or export it.");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const Ephemeral = { flags: MessageFlags.Ephemeral } as const;

/**
 * Discord lays text out left-to-right, which scrambles Arabic lines that contain mentions,
 * Latin names or numbers. Wrapping each line in a right-to-left isolate (U+2067 ... U+2069)
 * makes it read in natural Arabic order while mentions still render as pills.
 */
// A run of Latin/digit tokens joined by neutral punctuation ("5 · 4 · 3", "Send Messages").
// Inside an RTL line these reverse, so each run gets its own left-to-right isolate.
const LTR_RUN = /[0-9A-Za-z]+(?:[ \t·•\-–—,:/]+[0-9A-Za-z]+)+/g;

export const ar = (s: string): string =>
  s
    .split("\n")
    .map((l) => (l ? `\u2067${l.replace(LTR_RUN, (run) => `\u2066${run}\u2069`)}\u2069` : l))
    .join("\n");

const COLOR = { info: 0xe91e63, warn: 0xe67e22, ok: 0x2ecc71, gold: 0xf1c40f } as const;

/** Wrap a one-liner in an embed so no reply ever looks like a raw text dump. */
function note(text: string, color: number = COLOR.info) {
  return { embeds: [arEmbed(new EmbedBuilder().setDescription(text).setColor(color))] };
}

/** Apply ar() to every text part of an embed. */
function arEmbed(e: EmbedBuilder): EmbedBuilder {
  const d = e.data;
  if (d.title) e.setTitle(ar(d.title));
  if (d.description) e.setDescription(ar(d.description));
  if (d.footer?.text) e.setFooter({ text: ar(d.footer.text) });
  if (d.fields) e.setFields(d.fields.map((f) => ({ ...f, name: ar(f.name), value: ar(f.value) })));
  return e;
}

// ---------- helpers ----------

function cardEmbed(card: db.Card, ownerId: string | null = null): EmbedBuilder {
  const r = RARITIES[card.rarity];
  return new EmbedBuilder()
    .setTitle(ar(`${r.emoji} ${card.name}`))
    .setDescription(ar(card.description))
    .setColor(r.color)
    .addFields(
      { name: ar("الرقم"), value: ar(`#${card.id}`), inline: true },
      { name: ar("الندرة"), value: ar(card.rarity), inline: true },
      { name: ar("المالك"), value: ar(ownerId ? `<@${ownerId}>` : "متاحة 💍"), inline: true },
    )
    .setImage(IMAGE_BASE_URL ? `${IMAGE_BASE_URL.replace(/\/$/, "")}/${card.file}` : `attachment://${card.file}`);
}

/** The image as an attachment unless IMAGE_BASE_URL serves it. */
function cardFiles(card: db.Card): AttachmentBuilder[] {
  return IMAGE_BASE_URL ? [] : [new AttachmentBuilder(join(IMAGES_DIR, card.file), { name: card.file })];
}

/** Weighted pick across the tiers that still have a candidate once `skip` is removed. */
function weightedPick(scope: string | undefined, minRarity: db.Card["rarity"] | undefined, skip: Set<number>): db.Card | null {
  const floor = minRarity ? RARITY_ORDER.indexOf(minRarity) : 0;
  const tiers = RARITY_ORDER.slice(floor)
    .map((tier) => ({ tier, cards: db.cardsInRarity(tier, scope).filter((c) => !skip.has(c.id)) }))
    .filter((t) => t.cards.length);
  if (!tiers.length) return null;
  let roll = Math.random() * tiers.reduce((sum, t) => sum + RARITIES[t.tier].weight, 0);
  let chosen = tiers[tiers.length - 1]!;
  for (const t of tiers) {
    roll -= RARITIES[t.tier].weight;
    if (roll < 0) { chosen = t; break; }
  }
  return chosen.cards[Math.floor(Math.random() * chosen.cards.length)]!;
}

/**
 * Pick a card to show. `exclude` holds cards the player has already seen today: they are skipped
 * so the same card is not rolled twice, unless skipping them would leave nothing to roll at all.
 */
export function pickCard(guildId: string, minRarity?: db.Card["rarity"], exclude: Iterable<number> = []): db.Card | null {
  const scope = ROLL_ONLY_UNCLAIMED ? guildId : undefined;
  const skip = new Set(exclude);
  const fresh = weightedPick(scope, minRarity, skip);
  if (fresh || !skip.size) return fresh;
  return weightedPick(scope, minRarity, new Set()); // nothing new left, repeats are allowed again
}

/**
 * People recognise each other by their server nickname, not their global Discord name.
 * User.displayName is the global one, so prefer the guild member whenever we have it.
 */
type MemberLike = { displayName?: string; nick?: string | null } | null;
const memberName = (member: MemberLike, fallback: User): string => member?.displayName ?? member?.nick ?? fallback.displayName;

/** Nickname of whoever ran the command. */
const callerName = (i: ChatInputCommandInteraction): string => memberName(i.member as MemberLike, i.user);

/** Nickname of a user passed in a command option. */
const optionName = (i: ChatInputCommandInteraction, option: string, user: User): string =>
  memberName(i.options.getMember(option) as MemberLike, user);

function fmtWait(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)} س ${m % 60} د` : `${m} د`;
}

function claimRow(cardId: number, expiresAt: number, disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`claim:${cardId}:${expiresAt}`).setLabel("اطلبها 💍").setStyle(ButtonStyle.Success).setDisabled(disabled),
  );
}

function exchangeRow(offerer: string, target: string, mine: number, theirs: number, expiresAt: number, disabled = false) {
  const tail = `${offerer}:${target}:${mine}:${theirs}:${expiresAt}`;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`xchg:a:${tail}`).setLabel("قبول 🤝").setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`xchg:d:${tail}`).setLabel("رفض").setStyle(ButtonStyle.Danger).setDisabled(disabled),
  );
}

function duelRow(challenger: string, target: string, mine: number, theirs: number, expiresAt: number, disabled = false) {
  const tail = `${challenger}:${target}:${mine}:${theirs}:${expiresAt}`;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`duel:a:${tail}`).setLabel("قبول التحدي ⚔️").setStyle(ButtonStyle.Danger).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`duel:d:${tail}`).setLabel("رفض").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The coin is already flipped and the cards already awarded before any of this runs: the spin is
 * only theatre. Three frames alternate the spotlight between the two players, then the result lands.
 */
const SPIN_FRAMES = 3;
const spinBar = (frame: number) => "▰".repeat(frame + 1) + "▱".repeat(SPIN_FRAMES - frame);

function spinEmbed(frame: number, spotlight: string, stakes: string): EmbedBuilder {
  return new EmbedBuilder()
    .setAuthor({ name: ar("⚔️ التحدي") })
    .setTitle(ar("🎲 القرعة تدور..."))
    .setDescription(ar(`${spinBar(frame)}\n✨ **${spotlight}**`))
    .setColor(COLOR.warn)
    .addFields({ name: ar("على المحك"), value: stakes });
}

/**
 * A staked card on a single line. Splitting it over two lines staggers them, because each line
 * gets its own direction, and a line starting with a code chip lands on the opposite side.
 * Leading with the Arabic name keeps the whole line unambiguously right-to-left.
 */
const stakeLine = (c: db.Card) => `${RARITIES[c.rarity].emoji} ${c.name} · ${RARITIES[c.rarity].points} نقطة · #${c.id}`;

// ---------- /collection browsing ----------

const byRarityDesc = (a: db.Card, b: db.Card) =>
  RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity) || a.name.localeCompare(b.name, "ar");

function pageRow(userId: string, page: number, total: number, expiresAt: number, disabled = false) {
  const id = (p: number) => `col:${userId}:${p}:${expiresAt}`;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(id(page - 1)).setLabel("◀ السابق").setStyle(ButtonStyle.Secondary).setDisabled(disabled || page === 0),
    new ButtonBuilder().setCustomId("col:label").setLabel(page === 0 ? `الملخص · ${total} كرت` : `${page} / ${total}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(id(page + 1)).setLabel("التالي ▶").setStyle(ButtonStyle.Secondary).setDisabled(disabled || page === total),
  );
}

/** Page 0 is the summary, pages 1..N are the cards. Returns null when the collection is empty. */
export function collectionPage(gid: string, user: Pick<User, "id" | "displayName">, page: number, expiresAt: number) {
  const cards = db.collection(gid, user.id).sort(byRarityDesc);
  if (!cards.length) return null;
  page = Math.min(Math.max(page, 0), cards.length);
  let embed: EmbedBuilder;
  if (page === 0) {
    const points = cards.reduce((s, c) => s + RARITIES[c.rarity].points, 0);
    embed = new EmbedBuilder().setTitle(`مجموعة ${user.displayName}`).setColor(0xe91e63).setFooter({ text: `${cards.length} كرت · ${points} نقطة` });
    for (const tier of [...RARITY_ORDER].reverse()) {
      const owned = cards.filter((c) => c.rarity === tier);
      if (!owned.length) continue;
      const more = owned.length > 15 ? `\n… و${owned.length - 15} غيرها` : "";
      const names = owned.slice(0, 15).map((c) => `\`#${c.id}\` ${c.name}`);
      embed.addFields({ name: `${RARITIES[tier].emoji} ${tier} (${owned.length})`, value: names.join("\n") + more });
    }
    arEmbed(embed);
  } else {
    embed = cardEmbed(cards[page - 1]!, user.id);
  }
  const card = page ? cards[page - 1]! : null;
  return {
    payload: { embeds: [embed], components: [pageRow(user.id, page, cards.length, expiresAt)], files: card ? cardFiles(card) : [], attachments: [] },
    idle: { components: [pageRow(user.id, page, cards.length, expiresAt, true)] },
  };
}

// ponytail: idle timers live in memory. After a restart, stale buttons still expire through the
// timestamp in their customId; they just aren't greyed out.
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Grey out the browsing buttons once nobody has clicked for COLLECTION_IDLE_SECONDS. Renewed on every click. */
function armIdle(msg: Message, idle: { components: ActionRowBuilder<ButtonBuilder>[] }) {
  clearTimeout(idleTimers.get(msg.id));
  idleTimers.set(
    msg.id,
    setTimeout(() => {
      idleTimers.delete(msg.id);
      msg.edit(idle).catch(() => {});
    }, COLLECTION_IDLE_SECONDS * 1000),
  );
}

// ---------- card rush ----------

function rushRow(cardId: number, disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`rush:${cardId}`).setLabel("خذها مجاناً ⚡").setStyle(ButtonStyle.Primary).setDisabled(disabled),
  );
}

const rushTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Arm the next drop for one server, at a random point inside the configured window. */
function scheduleRush(guildId: string): void {
  clearTimeout(rushTimers.get(guildId));
  const hours = RUSH_MIN_HOURS + Math.random() * (RUSH_MAX_HOURS - RUSH_MIN_HOURS);
  rushTimers.set(guildId, setTimeout(() => dropRush(guildId), hours * 3600 * 1000));
}

/** Drop a free card in the channel the bot was last used in. Always re-arms, even on failure. */
async function dropRush(guildId: string): Promise<void> {
  try {
    const channelId = db.getLastChannel(guildId); // no activity yet -> nowhere to drop
    const card = channelId ? pickCard(guildId, RUSH_MIN_RARITY) : null;
    if (channelId && card) {
      const channel = await client.channels.fetch(channelId);
      if (channel?.isSendable()) {
        const embed = cardEmbed(card)
          .setAuthor({ name: ar("⚡ كرت طائر") })
          .setFooter({ text: ar("مجاني · لا يستهلك طلبك اليومي · أول من يضغط يربحه") });
        await channel.send({ embeds: [embed], components: [rushRow(card.id)], files: cardFiles(card) });
        console.log(`rush drop in ${guildId}: ${card.name} [${card.rarity}]`);
      }
    }
  } catch (err) {
    console.error(`rush drop failed for ${guildId}:`, err);
  } finally {
    scheduleRush(guildId);
  }
}

// ---------- seasons ----------

const PLACE_ICONS = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];

/** Once the last free card is claimed, award medals, announce, and let the next season open. */
async function checkSeasonEnd(guildId: string): Promise<void> {
  if (Object.values(db.poolCounts(guildId)).some((n) => n)) return; // cards still available
  const season = db.currentSeason(guildId);
  const medals = db.closeSeason(guildId);
  if (!medals.length) return;
  console.log(`season ${season} closed in ${guildId}`);
  try {
    const channelId = db.getLastChannel(guildId);
    const channel = channelId ? await client.channels.fetch(channelId) : null;
    if (!channel?.isSendable()) return;
    const lines = medals.map((m) => `${PLACE_ICONS[m.place - 1]} <@${m.userId}> — +${m.points} نقطة دائمة`);
    const embed = new EmbedBuilder()
      .setTitle(`🏁 انتهى الموسم ${season}`)
      .setDescription(lines.join("\n"))
      .setColor(0xf1c40f)
      .setFooter({ text: `الموسم ${season + 1} بدأ · كل الكروت متاحة من جديد · /leaderboard للترتيب العام` });
    await channel.send({ embeds: [arEmbed(embed.setAuthor({ name: ar("خلصت الكروت") }))] });
  } catch (err) {
    console.error(`season ${season} announcement failed for ${guildId}:`, err);
  }
}

// ---------- slash command definitions ----------

const commands = [
  new SlashCommandBuilder().setName("roll").setDescription("ارمي كرت هيفاء عشوائي"),
  new SlashCommandBuilder()
    .setName("collection")
    .setDescription("شوف مجموعتك أو مجموعة عضو")
    .addUserOption((o) => o.setName("member").setDescription("العضو (اختياري)")),
  new SlashCommandBuilder()
    .setName("card")
    .setDescription("ابحث عن كرت بالرقم أو الاسم")
    .addStringOption((o) => o.setName("name").setDescription("رقم الكرت أو اسمه").setRequired(true)),
  new SlashCommandBuilder()
    .setName("top")
    .setDescription("متصدرو الموسم")
    .addIntegerOption((o) => o.setName("season").setDescription("رقم موسم سابق (اختياري)").setMinValue(1)),
  new SlashCommandBuilder().setName("leaderboard").setDescription("الترتيب العام عبر كل المواسم"),
  new SlashCommandBuilder()
    .setName("divorce")
    .setDescription("تخلَّ عن كرت من مجموعتك")
    .addStringOption((o) => o.setName("name").setDescription("رقم الكرت أو اسمه").setRequired(true)),
  new SlashCommandBuilder()
    .setName("gift")
    .setDescription("اهدِ كرت لعضو")
    .addUserOption((o) => o.setName("member").setDescription("المستلم").setRequired(true))
    .addStringOption((o) => o.setName("name").setDescription("رقم الكرت أو اسمه").setRequired(true)),
  new SlashCommandBuilder()
    .setName("exchange")
    .setDescription("اعرض تبادل كرت بكرت مع عضو")
    .addUserOption((o) => o.setName("member").setDescription("الطرف الآخر").setRequired(true))
    .addStringOption((o) => o.setName("my_card").setDescription("رقم كرتك أو اسمه").setRequired(true))
    .addStringOption((o) => o.setName("their_card").setDescription("رقم كرته أو اسمه").setRequired(true)),
  new SlashCommandBuilder().setName("deck").setDescription("كل الدرجات: كم كرت مطلوب وكم باقي"),
  new SlashCommandBuilder()
    .setName("duel")
    .setDescription("تحدَّ عضواً: كرتك مقابل كرته، والفائز يأخذ الاثنين")
    .addUserOption((o) => o.setName("member").setDescription("الخصم").setRequired(true))
    .addStringOption((o) => o.setName("my_card").setDescription("رقم كرتك أو اسمه").setRequired(true))
    .addStringOption((o) => o.setName("their_card").setDescription("رقم كرته أو اسمه").setRequired(true)),
  new SlashCommandBuilder()
    .setName("rescan")
    .setDescription("(إدارة) افحص الصور الجديدة في مجلد images")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName("backup")
    .setDescription("(صاحب البوت) نزّل نسخة من قاعدة البيانات")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName("restore")
    .setDescription("(صاحب البوت) استبدل قاعدة البيانات بملف haifa.db")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addAttachmentOption((o) => o.setName("file").setDescription("ملف haifa.db").setRequired(true)),
].map((c) => c.toJSON());

// Bot owner(s): whoever owns the Discord application (a user or every member of its team).
const ownerIds = new Set<string>();

// ---------- command registration ----------

const rest = new REST().setToken(token);

/** Per-server registration shows commands instantly (global sync can take up to an hour). */
async function syncGuild(guild: Guild) {
  await rest.put(Routes.applicationGuildCommands(client.application!.id, guild.id), { body: commands });
}

client.once(Events.ClientReady, async (c) => {
  db.init();
  const app = await c.application.fetch();
  if (app.owner instanceof User) ownerIds.add(app.owner.id);
  else if (app.owner) for (const m of app.owner.members.values()) ownerIds.add(m.id);
  // Drop any global copies on Discord, otherwise every command would appear twice.
  await rest.put(Routes.applicationCommands(c.application.id), { body: [] });
  for (const guild of c.guilds.cache.values()) await syncGuild(guild);
  console.log(`logged in as ${c.user.tag}, commands synced to ${c.guilds.cache.size} server(s)`);
  const added = await scanNewImages();
  console.log(`startup scan: ${added.length} new cards`);
  for (const id of c.guilds.cache.keys()) scheduleRush(id);
});

client.on(Events.GuildCreate, async (guild) => {
  try {
    await syncGuild(guild);
    scheduleRush(guild.id);
    console.log(`joined ${guild.name} (${guild.id}), commands synced`);
  } catch (err) {
    // Usually the invite link lacked the applications.commands scope: Discord answers 403 Missing Access.
    console.error(`joined ${guild.name} (${guild.id}) but could not register commands:`, err);
  }
});

client.on(Events.GuildDelete, (guild) => console.log(`removed from ${guild.name ?? guild.id}`));

process.on("unhandledRejection", (err) => console.error("unhandled rejection", err));

// ---------- interaction routing ----------

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) await handleCommand(interaction);
    else if (interaction.isButton()) await handleButton(interaction);
  } catch (err) {
    if (err instanceof DiscordAPIError && err.code === 10062) {
      console.warn("Discord dropped the interaction before we answered (slow connection). Ignored.");
      return;
    }
    console.error("interaction failed", err);
  }
});

async function handleCommand(i: ChatInputCommandInteraction) {
  if (!i.inGuild()) return void i.reply({ ...note("هذا البوت يعمل داخل السيرفرات فقط", COLOR.warn), ...Ephemeral });
  const gid = i.guildId, uid = i.user.id;
  if (i.channelId) db.setLastChannel(gid, i.channelId); // rush cards drop wherever the bot is being used

  switch (i.commandName) {
    case "roll": {
      const used = db.rollsToday(gid, uid);
      if (used >= ROLLS_PER_DAY) return void i.reply({ ...note(`⏳ خلصت رميّات اليوم. تتجدد بعد ${fmtWait(db.secondsUntilMidnight())}`, COLOR.warn), ...Ephemeral });
      const card = pickCard(gid, undefined, db.cardsRolledToday(gid, uid));
      if (!card) {
        const any = Object.keys(db.poolCounts()).length > 0;
        return void i.reply({ ...note(any ? "كل الكروت مملوكة في هذا السيرفر. انتظر /divorce من أحد" : "ما في كروت بعد. حطّ صور في مجلد images وجرّب /rescan", COLOR.warn), ...Ephemeral });
      }
      await i.deferReply(); // acknowledge within Discord's 3-second window
      db.recordRoll(gid, uid, card.id);
      const owner = db.ownerOf(gid, card.id);
      const embed = cardEmbed(card, owner).setFooter({ text: ar(`رميّات متبقية اليوم: ${ROLLS_PER_DAY - used - 1}/${ROLLS_PER_DAY}`) });
      if (owner) return void (await i.editReply({ embeds: [embed], files: cardFiles(card) }));
      const expiresAt = Date.now() + CLAIM_WINDOW_SECONDS * 1000;
      const msg = await i.editReply({ embeds: [embed], components: [claimRow(card.id, expiresAt)], files: cardFiles(card) });
      setTimeout(() => {
        // Only disable if nobody claimed it (a claim already replaced the row).
        if (!db.ownerOf(gid, card.id)) msg.edit({ components: [claimRow(card.id, expiresAt, true)] }).catch(() => {});
      }, CLAIM_WINDOW_SECONDS * 1000);
      return;
    }

    case "collection": {
      await i.deferReply();
      const picked = i.options.getUser("member");
      const user = { id: (picked ?? i.user).id, displayName: picked ? optionName(i, "member", picked) : callerName(i) };
      const view = collectionPage(gid, user, 0, Date.now() + COLLECTION_IDLE_SECONDS * 1000);
      if (!view) return void i.editReply(note(`${user.displayName} ما عنده كروت بعد`));
      armIdle(await i.editReply(view.payload), view.idle);
      return;
    }

    case "card": {
      const c = db.findCard(i.options.getString("name", true));
      if (!c) return void i.reply({ ...note("ما لقيت كرت بهذا الرقم أو الاسم", COLOR.warn), ...Ephemeral });
      await i.deferReply();
      return void i.editReply({ embeds: [cardEmbed(c, db.ownerOf(gid, c.id))], files: cardFiles(c) });
    }

    case "top": {
      await i.deferReply();
      const live = db.currentSeason(gid);
      const season = i.options.getInteger("season") ?? live;
      if (season > live) return void i.editReply(note(`لا يوجد موسم ${season}. المواسم المتاحة من 1 إلى ${live}`, COLOR.warn));
      const board = db.seasonTop(gid, season);
      if (!board.length) return void i.editReply(note(`ما حد طلب شي في الموسم ${season}`));
      const lines = board.map((r, n) => `${PLACE_ICONS[n] ?? `${n + 1}.`} <@${r.userId}> — ${r.points} نقطة · ${r.count} كرت`);
      const done = season < live;
      const embed = new EmbedBuilder()
        .setTitle(`👑 متصدرو الموسم ${season}`)
        .setDescription(lines.join("\n"))
        .setColor(0xf1c40f)
        .setFooter({ text: done ? `الموسم ${season} · انتهى` : `الموسم ${season} · جارٍ الآن` });
      return void i.editReply({ embeds: [arEmbed(embed)] });
    }

    case "leaderboard": {
      await i.deferReply();
      const live = db.currentSeason(gid);
      const board = db.allTimeLeaderboard(gid);
      if (!board.length) {
        const left = Object.values(db.poolCounts(gid)).reduce((a, b) => a + (b ?? 0), 0);
        const prizes = ["5 نقاط", "4 نقاط", "3 نقاط", "نقطتان", "نقطة واحدة"];
        const empty = new EmbedBuilder()
          .setTitle("🏆 الترتيب العام")
          .setDescription("لم ينتهِ أي موسم بعد، فالجدول ما زال فارغاً.\nيمتلئ تلقائياً لحظة انتهاء الموسم.")
          .setColor(COLOR.gold)
          .addFields(
            { name: "الجوائز الدائمة", value: PLACE_ICONS.map((icon, n) => `${icon} ${prizes[n]}`).join("\n"), inline: true },
            { name: "متى ينتهي الموسم", value: `عندما يُطلب آخر كرت.\nباقي **${left}** كرت.`, inline: true },
          )
          .setFooter({ text: `الموسم ${live} جارٍ الآن · اكتب /top لترتيب هذا الموسم` });
        return void i.editReply({ embeds: [arEmbed(empty)] });
      }
      const lines = board.map(
        (r, n) => `${PLACE_ICONS[n] ?? `${n + 1}.`} <@${r.userId}> — ${r.points} نقطة · ${r.seasons} موسم${r.golds ? ` · ${r.golds} 🥇` : ""}`,
      );
      const embed = new EmbedBuilder()
        .setTitle("🏆 الترتيب العام")
        .setDescription(lines.join("\n"))
        .setColor(0xe67e22)
        .setFooter({ text: `كل المواسم · لا يُصفَّر أبداً · نحن الآن في الموسم ${live}` });
      return void i.editReply({ embeds: [arEmbed(embed)] });
    }

    case "divorce": {
      const c = db.findCard(i.options.getString("name", true));
      if (!c || !db.release(gid, c.id, uid)) return void i.reply({ ...note("هذا الكرت ليس في مجموعتك", COLOR.warn), ...Ephemeral });
      return void i.reply(note(`💔 ${i.user} تخلّى عن **${c.name}**`, COLOR.warn));
    }

    case "gift": {
      const target = i.options.getUser("member", true);
      const c = db.findCard(i.options.getString("name", true));
      if (!c || !db.transfer(gid, c.id, uid, target.id)) return void i.reply({ content: ar("هذا الكرت ليس في مجموعتك"), ...Ephemeral });
      return void i.reply(note(`🎁 ${i.user} أهدى **${c.name}** إلى ${target}`, COLOR.ok));
    }

    case "exchange": {
      const target = i.options.getUser("member", true);
      if (target.id === uid) return void i.reply({ ...note("ما تقدر تتبادل مع نفسك", COLOR.warn), ...Ephemeral });
      const mine = db.findCard(i.options.getString("my_card", true));
      const theirs = db.findCard(i.options.getString("their_card", true));
      if (!mine || db.ownerOf(gid, mine.id) !== uid) return void i.reply({ ...note("الكرت الأول ليس في مجموعتك", COLOR.warn), ...Ephemeral });
      if (!theirs || db.ownerOf(gid, theirs.id) !== target.id) return void i.reply({ ...note(`الكرت الثاني ليس في مجموعة ${optionName(i, "member", target)}`, COLOR.warn), ...Ephemeral });
      const e = new EmbedBuilder()
        .setTitle("🤝 عرض تبادل")
        .setColor(0x3498db)
        .addFields(
          { name: `${callerName(i)} يعطي`, value: `${RARITIES[mine.rarity].emoji} ${mine.name} \`#${mine.id}\``, inline: true },
          { name: `${optionName(i, "member", target)} يعطي`, value: `${RARITIES[theirs.rarity].emoji} ${theirs.name} \`#${theirs.id}\``, inline: true },
        )
        .setFooter({ text: "العرض صالح 5 دقائق" });
      const expiresAt = Date.now() + EXCHANGE_WINDOW_SECONDS * 1000;
      const msg = await i.reply({ content: `${target}`, embeds: [arEmbed(e)], components: [exchangeRow(uid, target.id, mine.id, theirs.id, expiresAt)], withResponse: true });
      setTimeout(() => {
        // Still pending? Only then mark it expired (accept/decline already rewrote the message).
        if (db.ownerOf(gid, mine.id) === uid && db.ownerOf(gid, theirs.id) === target.id)
          msg.resource?.message?.edit({ content: "", ...note("⌛ انتهى وقت العرض", COLOR.warn), components: [] }).catch(() => {});
      }, EXCHANGE_WINDOW_SECONDS * 1000);
      return;
    }

    case "backup": {
      if (!ownerIds.has(uid)) return void i.reply({ ...note("هذا الأمر لصاحب البوت فقط", COLOR.warn), ...Ephemeral });
      await i.deferReply(Ephemeral);
      const file = new AttachmentBuilder(Buffer.from(db.backupBytes()), { name: "haifa.db" });
      return void i.editReply({ ...note("نسخة قاعدة البيانات. احتفظ بها في مكان آمن.", COLOR.ok), files: [file] });
    }

    case "restore": {
      if (!ownerIds.has(uid)) return void i.reply({ content: ar("هذا الأمر لصاحب البوت فقط"), ...Ephemeral });
      await i.deferReply(Ephemeral);
      const att = i.options.getAttachment("file", true);
      const res = await fetch(att.url);
      if (!res.ok) return void i.editReply(note("ما قدرت أنزّل الملف", COLOR.warn));
      try {
        db.replaceDatabase(new Uint8Array(await res.arrayBuffer()));
      } catch (e) {
        return void i.editReply(note(`الملف ليس قاعدة بيانات صالحة (${(e as Error).message})`, COLOR.warn));
      }
      const pool = db.poolCounts();
      const total = Object.values(pool).reduce((a, b) => a + (b ?? 0), 0);
      return void i.editReply(note(`✅ تم الاستبدال. ${total} كرت في القاعدة الجديدة.`, COLOR.ok));
    }

    case "deck": {
      await i.deferReply();
      const rows = db.deckBreakdown(gid);
      if (!rows.length) return void i.editReply(note("ما في كروت بعد", COLOR.warn));
      const by = new Map(rows.map((r) => [r.rarity, r]));
      const total = rows.reduce((n, r) => n + r.total, 0);
      const claimed = rows.reduce((n, r) => n + r.claimed, 0);
      const embed = new EmbedBuilder()
        .setTitle("🎴 الكروت")
        .setDescription(`**${total - claimed}** متاح · **${claimed}** مملوك · **${total}** الإجمالي`)
        .setColor(COLOR.info)
        .setFooter({ text: `الموسم ${db.currentSeason(gid)} · ينتهي عندما يُطلب آخر كرت` });
      for (const tier of [...RARITY_ORDER].reverse()) {
        const r = by.get(tier);
        if (!r || SECRET_RARITIES.includes(tier)) continue; // counted in the totals, just not named
        embed.addFields({
          name: `${RARITIES[tier].emoji} ${tier}`,
          value: `**${r.total - r.claimed}** متاح من **${r.total}**`,
          inline: true,
        });
      }
      return void i.editReply({ embeds: [arEmbed(embed)] });
    }

    case "duel": {
      const target = i.options.getUser("member", true);
      if (target.id === uid) return void i.reply({ ...note("ما تقدر تتحدى نفسك", COLOR.warn), ...Ephemeral });
      if (target.bot) return void i.reply({ ...note("ما تقدر تتحدى بوت", COLOR.warn), ...Ephemeral });
      const used = db.duelsToday(gid, uid);
      if (used >= DUELS_PER_DAY) {
        return void i.reply({
          ...note(`⏳ خلصت تحدياتك اليوم. تتجدد بعد ${fmtWait(db.secondsUntilMidnight())}`, COLOR.warn),
          ...Ephemeral,
        });
      }
      const mine = db.findCard(i.options.getString("my_card", true));
      const theirs = db.findCard(i.options.getString("their_card", true));
      if (!mine || db.ownerOf(gid, mine.id) !== uid) return void i.reply({ ...note("الكرت الأول ليس في مجموعتك", COLOR.warn), ...Ephemeral });
      if (!theirs || db.ownerOf(gid, theirs.id) !== target.id) {
        return void i.reply({ ...note(`الكرت الثاني ليس في مجموعة ${optionName(i, "member", target)}`, COLOR.warn), ...Ephemeral });
      }
      db.recordDuel(gid, uid);
      const expiresAt = Date.now() + DUEL_WINDOW_SECONDS * 1000;
      const embed = new EmbedBuilder()
        .setAuthor({ name: ar("⚔️ تحدٍ") })
        .setTitle(ar(`${callerName(i)} ضد ${optionName(i, "member", target)}`))
        .setDescription(ar(`الفائز يأخذ الكرتين. القرعة عادلة: ${50}/${50}`))
        .setColor(COLOR.warn)
        .addFields(
          { name: `${callerName(i)} يراهن بـ`, value: stakeLine(mine), inline: true },
          { name: `${optionName(i, "member", target)} يراهن بـ`, value: stakeLine(theirs), inline: true },
        )
        .setFooter({ text: `متبقي ${DUELS_PER_DAY - used - 1} تحدٍ لك اليوم · العرض صالح 5 دقائق` });
      const msg = await i.reply({
        content: `${target}`,
        embeds: [arEmbed(embed)],
        components: [duelRow(uid, target.id, mine.id, theirs.id, expiresAt)],
        withResponse: true,
      });
      setTimeout(() => {
        // Still pending only if neither card has moved; otherwise the duel already resolved.
        if (db.ownerOf(gid, mine.id) === uid && db.ownerOf(gid, theirs.id) === target.id) {
          msg.resource?.message
            ?.edit({ content: "", ...note("⌛ انتهى وقت التحدي", COLOR.warn), components: [] })
            .catch(() => {});
        }
      }, DUEL_WINDOW_SECONDS * 1000);
      return;
    }

    case "rescan": {
      await i.deferReply(Ephemeral);
      const added = await scanNewImages();
      const pool = db.poolCounts();
      const lines = [`✅ ${added.length} كرت جديد`, ...added.slice(0, 20).map((c) => `${RARITIES[c.rarity].emoji} ${c.name} — ${c.rarity}`)];
      lines.push("\nالمجموع: " + RARITY_ORDER.map((t) => `${RARITIES[t].emoji} ${pool[t] ?? 0}`).join(" · "));
      return void i.editReply(note(lines.join("\n"), COLOR.ok));
    }
  }
}

async function handleButton(i: ButtonInteraction) {
  if (!i.inGuild()) return;
  const gid = i.guildId, uid = i.user.id;
  const [kind, ...rest] = i.customId.split(":");

  if (kind === "claim") {
    const cardId = Number(rest[0]), expiresAt = Number(rest[1]);
    const card = db.getCard(cardId);
    if (!card) return;
    if (Date.now() > expiresAt) return void i.reply({ ...note("⌛ انتهى وقت الطلب", COLOR.warn), ...Ephemeral });
    if (db.claimedToday(gid, uid)) return void i.reply({ ...note(`⏳ استخدمت طلب اليوم. يتجدد بعد ${fmtWait(db.secondsUntilMidnight())}`, COLOR.warn), ...Ephemeral });
    if (!db.claim(gid, cardId, uid)) return void i.reply({ ...note("💔 سبقك أحد إليها", COLOR.warn), ...Ephemeral });
    const footer = i.message.embeds[0]?.footer?.text;
    const embed = cardEmbed(card, uid);
    if (footer) embed.setFooter({ text: footer });
    await i.update({ embeds: [embed], components: [claimRow(cardId, expiresAt, true)] });
    await i.followUp(note(`💍 ${i.user} حصل على **${card.name}**!`, COLOR.ok));
    return void (await checkSeasonEnd(gid));
  }

  if (kind === "col") {
    const [userId, pageStr, expStr] = rest as [string, string, string];
    if (Date.now() > Number(expStr)) return void i.reply({ ...note("⌛ انتهت الجلسة. اكتب /collection من جديد", COLOR.warn), ...Ephemeral });
    const member = await i.guild?.members.fetch(userId).catch(() => null);
    const user = member ?? (await client.users.fetch(userId));
    const view = collectionPage(gid, user, Number(pageStr), Date.now() + COLLECTION_IDLE_SECONDS * 1000);
    if (!view) return void i.update({ content: "", ...note(`${user.displayName} ما عنده كروت بعد`), components: [] });
    await i.update(view.payload);
    return void armIdle(i.message, view.idle);
  }

  if (kind === "rush") {
    const card = db.getCard(Number(rest[0]));
    if (!card) return;
    // No expiry and no daily cost: the whole point of a rush card.
    if (!db.claimFree(gid, card.id, uid)) return void i.reply({ content: ar("💔 سبقك أحد إليها"), ...Ephemeral });
    await i.update({ embeds: [cardEmbed(card, uid)], components: [rushRow(card.id, true)] });
    await i.followUp(note(`⚡ ${i.user} خطف **${card.name}** مجاناً!`, COLOR.ok));
    return void (await checkSeasonEnd(gid));
  }

  if (kind === "duel") {
    const [action, challenger, target, aStr, bStr, expStr] = rest as [string, string, string, string, string, string];
    if (uid !== target) return void i.reply({ ...note("هذا التحدي ليس لك", COLOR.warn), ...Ephemeral });
    const close = (text: string, color: number) => i.update({ content: "", ...note(text, color), components: [] });
    if (Date.now() > Number(expStr)) return void close("⌛ انتهى وقت التحدي", COLOR.warn);
    if (action === "d") return void close(`❌ <@${target}> رفض التحدي`, COLOR.warn);

    const mine = db.getCard(Number(aStr)), theirs = db.getCard(Number(bStr));
    if (!mine || !theirs) return;
    const challengerWins = Math.random() < 0.5;
    const winner = challengerWins ? challenger : target;
    try {
      db.awardDuel(gid, mine.id, challenger, theirs.id, target, winner);
    } catch {
      return void close("❌ تغيّرت الملكية، التحدي لم يعد صالحاً", COLOR.warn);
    }
    // Discord renders mentions in descriptions and fields, but never in a title: use a plain name there.
    const loser = challengerWins ? target : challenger;
    const nameOf = async (id: string) => (await i.guild?.members.fetch(id).catch(() => null))?.displayName ?? "لاعب";
    const [challengerName, targetName] = await Promise.all([nameOf(challenger), nameOf(target)]);
    const [winnerName, loserName] = challengerWins ? [challengerName, targetName] : [targetName, challengerName];
    const stakes = `${stakeLine(mine)}\n${stakeLine(theirs)}`;

    // Spin first, reveal after. Every edit is best-effort: the cards are already awarded, so a
    // dropped frame costs nothing but a little drama.
    // The spotlight alternates, then settles on the winner so the spin looks like it lands on them.
    const spotlights = [challengerName, targetName, winnerName];
    await i.update({ content: "", embeds: [arEmbed(spinEmbed(0, spotlights[0]!, stakes))], components: [] });
    for (let frame = 1; frame < SPIN_FRAMES; frame++) {
      await sleep(DUEL_SUSPENSE_MS);
      await i.editReply({ embeds: [arEmbed(spinEmbed(frame, spotlights[frame]!, stakes))] }).catch(() => {});
    }
    await sleep(DUEL_SUSPENSE_MS);

    const result = new EmbedBuilder()
      .setAuthor({ name: ar("⚔️ نتيجة التحدي") })
      .setTitle(ar(`🎉 فاز ${winnerName}`))
      .setDescription(ar(`<@${winner}> أخذ الكرتين، و<@${loser}> خسر رهانه.\nحظ أوفر يا ${loserName}.`))
      .setColor(COLOR.gold)
      .addFields({ name: ar("الغنيمة"), value: stakes });
    await i.editReply({ embeds: [arEmbed(result)], components: [] }).catch(() => {});
    return;
  }

  if (kind === "xchg") {
    const [action, offerer, target, mineId, theirsId, expiresAt] = rest as [string, string, string, string, string, string];
    if (uid !== target) return void i.reply({ ...note("هذا العرض ليس لك", COLOR.warn), ...Ephemeral });
    const finish = (content: string, color: number = COLOR.ok) => i.update({ content: "", ...note(content, color), components: [] });
    if (Date.now() > Number(expiresAt)) return void finish("⌛ انتهى وقت العرض", COLOR.warn);
    if (action === "d") return void finish(`❌ <@${target}> رفض التبادل`, COLOR.warn);
    const mine = db.getCard(Number(mineId)), theirs = db.getCard(Number(theirsId));
    if (!mine || !theirs) return;
    try {
      db.swap(gid, mine.id, offerer, theirs.id, target);
    } catch {
      return void finish("❌ تغيّرت الملكية، العرض لم يعد صالحاً", COLOR.warn);
    }
    return void finish(`🤝 تم التبادل! <@${offerer}> أخذ **${theirs.name}** و<@${target}> أخذ **${mine.name}**`);
  }
}

// Railway sends SIGTERM to the old container on every redeploy. Without this the process is
// killed and reported as a crash; exiting 0 makes a normal swap look like the normal event it is.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    console.log(`${signal} received, shutting down cleanly`);
    void client.destroy();
    process.exit(0);
  });
}

if (import.meta.main) client.login(token); // importable without connecting (tests)
