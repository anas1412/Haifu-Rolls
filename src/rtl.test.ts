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
