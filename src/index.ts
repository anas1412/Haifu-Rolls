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
  EXCHANGE_WINDOW_SECONDS,
  IMAGE_BASE_URL,
  IMAGES_DIR,
  RARITIES,
  RARITY_ORDER,
  ROLL_ONLY_UNCLAIMED,
  ROLLS_PER_DAY,
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
const ar = (s: string): string => s.split("\n").map((l) => (l ? `\u2067${l}\u2069` : l)).join("\n");

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
    .addFields({ name: ar("الندرة"), value: ar(card.rarity), inline: true }, { name: ar("المالك"), value: ar(ownerId ? `<@${ownerId}>` : "متاحة 💍"), inline: true })
    .setImage(IMAGE_BASE_URL ? `${IMAGE_BASE_URL.replace(/\/$/, "")}/${card.file}` : `attachment://${card.file}`);
}

/** The image as an attachment unless IMAGE_BASE_URL serves it. */
function cardFiles(card: db.Card): AttachmentBuilder[] {
  return IMAGE_BASE_URL ? [] : [new AttachmentBuilder(join(IMAGES_DIR, card.file), { name: card.file })];
}

function pickCard(guildId: string): db.Card | null {
  const scope = ROLL_ONLY_UNCLAIMED ? guildId : undefined;
  const pool = db.poolCounts(scope);
  const tiers = RARITY_ORDER.filter((t) => pool[t]);
  if (!tiers.length) return null;
  let roll = Math.random() * tiers.reduce((s, t) => s + RARITIES[t].weight, 0);
  let tier = tiers[tiers.length - 1]!;
  for (const t of tiers) {
    roll -= RARITIES[t].weight;
    if (roll < 0) { tier = t; break; }
  }
  const cards = db.cardsInRarity(tier, scope);
  return cards[Math.floor(Math.random() * cards.length)] ?? null;
}

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
      const names = cards.filter((c) => c.rarity === tier).map((c) => c.name);
      if (!names.length) continue;
      const more = names.length > 15 ? `\n… و${names.length - 15} غيرها` : "";
      embed.addFields({ name: `${RARITIES[tier].emoji} ${tier} (${names.length})`, value: names.slice(0, 15).join("\n") + more });
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

// ---------- slash command definitions ----------

const commands = [
  new SlashCommandBuilder().setName("roll").setDescription("ارمي كرت هيفاء عشوائي"),
  new SlashCommandBuilder()
    .setName("collection")
    .setDescription("شوف مجموعتك أو مجموعة عضو")
    .addUserOption((o) => o.setName("member").setDescription("العضو (اختياري)")),
  new SlashCommandBuilder()
    .setName("card")
    .setDescription("ابحث عن كرت بالاسم")
    .addStringOption((o) => o.setName("name").setDescription("اسم الكرت أو جزء منه").setRequired(true)),
  new SlashCommandBuilder().setName("top").setDescription("قائمة المتصدرين"),
  new SlashCommandBuilder()
    .setName("divorce")
    .setDescription("تخلَّ عن كرت من مجموعتك")
    .addStringOption((o) => o.setName("name").setDescription("اسم الكرت").setRequired(true)),
  new SlashCommandBuilder()
    .setName("gift")
    .setDescription("اهدِ كرت لعضو")
    .addUserOption((o) => o.setName("member").setDescription("المستلم").setRequired(true))
    .addStringOption((o) => o.setName("name").setDescription("اسم الكرت").setRequired(true)),
  new SlashCommandBuilder()
    .setName("exchange")
    .setDescription("اعرض تبادل كرت بكرت مع عضو")
    .addUserOption((o) => o.setName("member").setDescription("الطرف الآخر").setRequired(true))
    .addStringOption((o) => o.setName("my_card").setDescription("كرتك الذي تعرضه").setRequired(true))
    .addStringOption((o) => o.setName("their_card").setDescription("كرته الذي تريده").setRequired(true)),
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
});

client.on(Events.GuildCreate, async (guild) => {
  await syncGuild(guild);
  console.log(`joined ${guild.name}, commands synced`);
});

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
  if (!i.inGuild()) return void i.reply({ content: ar("هذا البوت يعمل داخل السيرفرات فقط"), ...Ephemeral });
  const gid = i.guildId, uid = i.user.id;

  switch (i.commandName) {
    case "roll": {
      const used = db.rollsToday(gid, uid);
      if (used >= ROLLS_PER_DAY) return void i.reply({ content: ar(`⏳ خلصت رميّات اليوم. تتجدد بعد ${fmtWait(db.secondsUntilMidnight())}`), ...Ephemeral });
      const card = pickCard(gid);
      if (!card) {
        const any = Object.keys(db.poolCounts()).length > 0;
        return void i.reply({ content: ar(any ? "كل الكروت مملوكة في هذا السيرفر. انتظر /divorce من أحد" : "ما في كروت بعد. حطّ صور في مجلد images وجرّب /rescan"), ...Ephemeral });
      }
      await i.deferReply(); // acknowledge within Discord's 3-second window
      db.recordRoll(gid, uid);
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
      const user = i.options.getUser("member") ?? i.user;
      const view = collectionPage(gid, user, 0, Date.now() + COLLECTION_IDLE_SECONDS * 1000);
      if (!view) return void i.editReply(ar(`${user.displayName} ما عنده كروت بعد`));
      armIdle(await i.editReply(view.payload), view.idle);
      return;
    }

    case "card": {
      const c = db.findCard(i.options.getString("name", true));
      if (!c) return void i.reply({ content: ar("ما لقيت كرت بهذا الاسم"), ...Ephemeral });
      await i.deferReply();
      return void i.editReply({ embeds: [cardEmbed(c, db.ownerOf(gid, c.id))], files: cardFiles(c) });
    }

    case "top": {
      await i.deferReply();
      const board = db.leaderboard(gid);
      if (!board.length) return void i.editReply(ar("ما حد طلب شي بعد"));
      const medals = ["🥇", "🥈", "🥉"];
      const lines = board.map((r, n) => `${medals[n] ?? `${n + 1}.`} <@${r.userId}> — ${r.points} نقطة · ${r.count} كرت`);
      return void i.editReply({ embeds: [arEmbed(new EmbedBuilder().setTitle("👑 المتصدرون").setDescription(lines.join("\n")).setColor(0xf1c40f))] });
    }

    case "divorce": {
      const c = db.findCard(i.options.getString("name", true));
      if (!c || !db.release(gid, c.id, uid)) return void i.reply({ content: ar("هذا الكرت ليس في مجموعتك"), ...Ephemeral });
      return void i.reply(ar(`💔 ${i.user} تخلّى عن **${c.name}**`));
    }

    case "gift": {
      const target = i.options.getUser("member", true);
      const c = db.findCard(i.options.getString("name", true));
      if (!c || !db.transfer(gid, c.id, uid, target.id)) return void i.reply({ content: ar("هذا الكرت ليس في مجموعتك"), ...Ephemeral });
      return void i.reply(ar(`🎁 ${i.user} أهدى **${c.name}** إلى ${target}`));
    }

    case "exchange": {
      const target = i.options.getUser("member", true);
      if (target.id === uid) return void i.reply({ content: ar("ما تقدر تتبادل مع نفسك"), ...Ephemeral });
      const mine = db.findCard(i.options.getString("my_card", true));
      const theirs = db.findCard(i.options.getString("their_card", true));
      if (!mine || db.ownerOf(gid, mine.id) !== uid) return void i.reply({ content: ar("الكرت الأول ليس في مجموعتك"), ...Ephemeral });
      if (!theirs || db.ownerOf(gid, theirs.id) !== target.id) return void i.reply({ content: ar(`الكرت الثاني ليس في مجموعة ${target.displayName}`), ...Ephemeral });
      const e = new EmbedBuilder()
        .setTitle("🤝 عرض تبادل")
        .setColor(0x3498db)
        .addFields(
          { name: `${i.user.displayName} يعطي`, value: `${RARITIES[mine.rarity].emoji} ${mine.name}`, inline: true },
          { name: `${target.displayName} يعطي`, value: `${RARITIES[theirs.rarity].emoji} ${theirs.name}`, inline: true },
        )
        .setFooter({ text: "العرض صالح 5 دقائق" });
      const expiresAt = Date.now() + EXCHANGE_WINDOW_SECONDS * 1000;
      const msg = await i.reply({ content: `${target}`, embeds: [arEmbed(e)], components: [exchangeRow(uid, target.id, mine.id, theirs.id, expiresAt)], withResponse: true });
      setTimeout(() => {
        // Still pending? Only then mark it expired (accept/decline already rewrote the message).
        if (db.ownerOf(gid, mine.id) === uid && db.ownerOf(gid, theirs.id) === target.id)
          msg.resource?.message?.edit({ content: ar("⌛ انتهى وقت العرض"), embeds: [], components: [] }).catch(() => {});
      }, EXCHANGE_WINDOW_SECONDS * 1000);
      return;
    }

    case "backup": {
      if (!ownerIds.has(uid)) return void i.reply({ content: ar("هذا الأمر لصاحب البوت فقط"), ...Ephemeral });
      await i.deferReply(Ephemeral);
      const file = new AttachmentBuilder(Buffer.from(db.backupBytes()), { name: "haifa.db" });
      return void i.editReply({ content: ar("نسخة قاعدة البيانات. احتفظ بها في مكان آمن."), files: [file] });
    }

    case "restore": {
      if (!ownerIds.has(uid)) return void i.reply({ content: ar("هذا الأمر لصاحب البوت فقط"), ...Ephemeral });
      await i.deferReply(Ephemeral);
      const att = i.options.getAttachment("file", true);
      const res = await fetch(att.url);
      if (!res.ok) return void i.editReply(ar("ما قدرت أنزّل الملف"));
      try {
        db.replaceDatabase(new Uint8Array(await res.arrayBuffer()));
      } catch (e) {
        return void i.editReply(ar(`الملف ليس قاعدة بيانات صالحة (${(e as Error).message})`));
      }
      const pool = db.poolCounts();
      const total = Object.values(pool).reduce((a, b) => a + (b ?? 0), 0);
      return void i.editReply(ar(`✅ تم الاستبدال. ${total} كرت في القاعدة الجديدة.`));
    }

    case "rescan": {
      await i.deferReply(Ephemeral);
      const added = await scanNewImages();
      const pool = db.poolCounts();
      const lines = [`✅ ${added.length} كرت جديد`, ...added.slice(0, 20).map((c) => `${RARITIES[c.rarity].emoji} ${c.name} — ${c.rarity}`)];
      lines.push("\nالمجموع: " + RARITY_ORDER.map((t) => `${RARITIES[t].emoji} ${pool[t] ?? 0}`).join(" · "));
      return void i.editReply(ar(lines.join("\n")));
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
    if (Date.now() > expiresAt) return void i.reply({ content: ar("⌛ انتهى وقت الطلب"), ...Ephemeral });
    if (db.claimedToday(gid, uid)) return void i.reply({ content: ar(`⏳ استخدمت طلب اليوم. يتجدد بعد ${fmtWait(db.secondsUntilMidnight())}`), ...Ephemeral });
    if (!db.claim(gid, cardId, uid)) return void i.reply({ content: ar("💔 سبقك أحد إليها"), ...Ephemeral });
    const footer = i.message.embeds[0]?.footer?.text;
    const embed = cardEmbed(card, uid);
    if (footer) embed.setFooter({ text: footer });
    await i.update({ embeds: [embed], components: [claimRow(cardId, expiresAt, true)] });
    return void i.followUp(ar(`💍 ${i.user} حصل على **${card.name}**!`));
  }

  if (kind === "col") {
    const [userId, pageStr, expStr] = rest as [string, string, string];
    if (Date.now() > Number(expStr)) return void i.reply({ content: ar("⌛ انتهت الجلسة. اكتب /collection من جديد"), ...Ephemeral });
    const user = await client.users.fetch(userId);
    const view = collectionPage(gid, user, Number(pageStr), Date.now() + COLLECTION_IDLE_SECONDS * 1000);
    if (!view) return void i.update({ content: ar(`${user.displayName} ما عنده كروت بعد`), embeds: [], components: [] });
    await i.update(view.payload);
    return void armIdle(i.message, view.idle);
  }

  if (kind === "xchg") {
    const [action, offerer, target, mineId, theirsId, expiresAt] = rest as [string, string, string, string, string, string];
    if (uid !== target) return void i.reply({ content: ar("هذا العرض ليس لك"), ...Ephemeral });
    const finish = (content: string) => i.update({ content: ar(content), embeds: [], components: [] });
    if (Date.now() > Number(expiresAt)) return void finish("⌛ انتهى وقت العرض");
    if (action === "d") return void finish(`❌ <@${target}> رفض التبادل`);
    const mine = db.getCard(Number(mineId)), theirs = db.getCard(Number(theirsId));
    if (!mine || !theirs) return;
    try {
      db.swap(gid, mine.id, offerer, theirs.id, target);
    } catch {
      return void finish("❌ تغيّرت الملكية، العرض لم يعد صالحاً");
    }
    return void finish(`🤝 تم التبادل! <@${offerer}> أخذ **${theirs.name}** و<@${target}> أخذ **${mine.name}**`);
  }
}

if (import.meta.main) client.login(token); // importable without connecting (tests)
