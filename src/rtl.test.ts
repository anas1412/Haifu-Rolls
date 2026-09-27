// Arabic lines carry an RTL isolate; Latin/number runs inside them need their own LTR isolate
// or they render backwards ("5 · 4 · 3" showing up as "3 · 4 · 5").
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "haifu-rtl-")), "t.db");
process.env.DISCORD_TOKEN = "dummy";
const { ar } = await import("./index");

const RLI = "⁧", LRI = "⁦", PDI = "⁩";

test("a plain Arabic line only gets the RTL isolate", () => {
  expect(ar("ما حد طلب شي بعد")).toBe(`${RLI}ما حد طلب شي بعد${PDI}`);
});

test("a run of numbers keeps its own left-to-right order", () => {
  expect(ar("الجوائز: 5 · 4 · 3 · 2 · 1")).toBe(`${RLI}الجوائز: ${LRI}5 · 4 · 3 · 2 · 1${PDI}${PDI}`);
});

test("Latin words stay in order", () => {
  expect(ar("يطلب Send Messages فقط")).toBe(`${RLI}يطلب ${LRI}Send Messages${PDI} فقط${PDI}`);
});

test("mentions are never split open", () => {
  const line = ar("<@111111111111111111> حصل على الكرت");
  expect(line).toContain("<@111111111111111111>");
  expect(line).not.toContain(`<@${LRI}`);
  expect(line).not.toContain(`${PDI}>`);
});

test("numbers separated by Arabic words are left alone", () => {
  // "5 نقطة · 2 كرت" already renders correctly; wrapping it would be wrong.
  expect(ar("<@1> — 5 نقطة · 2 كرت")).not.toContain(LRI);
});

test("each line is isolated separately", () => {
  expect(ar("سطر أول\nسطر ثاني").split("\n")).toEqual([`${RLI}سطر أول${PDI}`, `${RLI}سطر ثاني${PDI}`]);
});

test("empty lines are left untouched", () => {
  expect(ar("أول\n\nثاني")).toBe(`${RLI}أول${PDI}\n\n${RLI}ثاني${PDI}`);
});

test("a stake line stays a single right-to-left line", () => {
  // Two-line stakes staggered in Discord: one line leaned left, the other right.
  const out = ar("🟢 الدانتيل العاجي · 3 نقطة · #32");
  expect(out.split("\n")).toHaveLength(1);
  expect(out).not.toContain(LRI); // numbers fenced by Arabic words need no extra isolate
  expect(out.startsWith(RLI) && out.endsWith(PDI)).toBe(true);
});

test("the season-end post tags everyone and every player, right to left", async () => {
  const { seasonEndMessage } = await import("./index");
  const ids = ["111111111111111111", "222222222222222222", "333333333333333333", "444444444444444444", "555555555555555555", "666666666666666666"];
  const standings = ids.map((userId, i) => ({ userId, points: 600 - i * 100, count: 60 - i * 10, firstAt: i }));
  const medals = ids.slice(0, 5).map((userId, i) => ({ userId, place: i + 1, points: 5 - i }));
  const msg = seasonEndMessage(1, standings, medals, { claimed: 248, total: 507 });

  const [announce, ping] = msg.content.split("\n");
  expect(ping).toBe("@everyone");                          // alone on its line, no isolate around it
  expect(announce!.startsWith(RLI)).toBe(true);
  expect(msg.allowedMentions.parse).toEqual(["everyone", "users"]);

  const embed = msg.embeds[0]!.data;
  const lines = embed.description!.split("\n").filter(Boolean);
  for (const id of ids) expect(embed.description).toContain(`<@${id}>`); // all six tagged, pills intact
  for (const line of lines) expect(line.startsWith(RLI) && line.endsWith(PDI)).toBe(true);
  expect(embed.title).not.toContain("<@");                  // titles never render mentions
  expect(lines[0]).toContain("+5 نقاط دائمة");
  expect(lines[3]).toContain("+نقطتان دائمة");              // 2 is a dual in Arabic, not "2 نقاط"
  expect(lines[4]).toContain("+1 نقطة دائمة");
  expect(lines.some((l) => l.includes("6️⃣ <@666666666666666666>"))).toBe(true); // 6th listed, no medal
});

test("waits read naturally: no zero minutes on whole hours", async () => {
  const { fmtWait } = await import("./index");
  expect(fmtWait(3600)).toBe("1 س");
  expect(fmtWait(3 * 3600 - 1)).toBe("3 س");     // a second short of 3 hours rounds up, and reads clean
  expect(fmtWait(5 * 3600)).toBe("5 س");
  expect(fmtWait(2 * 3600 + 14 * 60)).toBe("2 س 14 د");
  expect(fmtWait(45 * 60)).toBe("45 د");
  expect(fmtWait(10)).toBe("1 د");               // never "0 د" while still waiting
});
