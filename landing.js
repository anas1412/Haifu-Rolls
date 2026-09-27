// Haifu Rolls landing page. Plain JavaScript, no framework and no build step.
// The deck comes straight from seed.json in this repo, so new cards show up here on their own.

// Public tiers, rarest last. Mirrors RARITIES in src/config.ts (weight is per card; points = 100 / weight;
// claimHours = the wait before your next claim after claiming one).
// The secret tiers are left out on purpose: the page never names or rolls them.
const TIERS = [
  { key: "عادية", weight: 100, points: 1, claimHours: 1, color: "#95a5a6" },
  { key: "مميزة", weight: 50, points: 2, claimHours: 1, color: "#2ecc71" },
  { key: "نادرة", weight: 25, points: 4, claimHours: 1, color: "#3498db" },
  { key: "أسطورية", weight: 10, points: 10, claimHours: 3, color: "#9b59b6" },
  { key: "الملكة", weight: 4, points: 25, claimHours: 3, color: "#f1c40f" },
];
const RULES = { rolls: 5, rollResetHours: 2, claimWindowSeconds: 30 };
const SHOWCASE = "h52.jpg"; // الهاربة مالمتحف, the card shown before the first roll

const tierOf = (key) => TIERS.find((t) => t.key === key);
const img = (file) => `images/${file}`; // relative: GitHub Pages serves the site from /Haifu-Rolls/
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Arabic counts agree with the number: 1 and 2 have their own forms, 3 to 10 take the plural.
function count(n, one, two, few) {
  if (n === 1) return one;
  if (n === 2) return two;
  if (n >= 3 && n <= 10) return `${n} ${few}`;
  return `${n} ${one}`;
}
const hours = (n) => count(n, "ساعة", "ساعتين", "ساعات");
const points = (n) => (n === 1 ? "نقطة وحدة" : count(n, "نقطة", "نقطتين", "نقاط"));
const rollsLeft = (n) => count(n, "رمية", "رميتين", "رميات");
const times = (n) => (n === 2 ? "مرتين" : n >= 3 && n <= 10 ? `${n} مرات` : `${n} مرة`);

function sample(xs, n) {
  const copy = [...xs];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

// The bot's own odds: each card carries its tier's weight, so a tier's share grows with its size.
function pickCard(deck, skip) {
  const pool = deck.filter((c) => !skip.has(c.file));
  const from = pool.length ? pool : deck;
  let roll = Math.random() * from.reduce((n, c) => n + tierOf(c.rarity).weight, 0);
  for (const c of from) {
    roll -= tierOf(c.rarity).weight;
    if (roll < 0) return c;
  }
  return from[from.length - 1];
}

// ---------- the /roll demo ----------

function rollDemo(deck) {
  const root = document.getElementById("demo");
  const $ = (sel) => root.querySelector(sel);
  const field = (name) => root.querySelector(`[data-f="${name}"]`);
  const embed = $(".embed"), dot = $(".embed-title .dot");
  const buttons = $(".buttons"), claimBtn = $(".claim"), claimLabel = $(".claim span"), timer = $(".claim .timer");
  const rollBtn = $(".btn-roll"), rollLabel = $(".btn-roll span"), left = $(".left"), status = $(".demo-status");

  let state;
  function reset() {
    state = { left: RULES.rolls, rolled: null, claimed: null, seen: new Set([SHOWCASE]), spinning: false };
    show(deck.find((c) => c.file === SHOWCASE) || deck[0]);
    buttons.hidden = true;
    field("owner").textContent = "متاحة";
    rollLabel.textContent = "ارمي";
    left.textContent = `باقيلك ${rollsLeft(state.left)}`;
    status.textContent = "";
  }

  function show(card) {
    const t = tierOf(card.rarity);
    embed.style.setProperty("--bar", t.color);
    dot.style.background = t.color;
    field("name").textContent = card.name;
    field("desc").textContent = card.description;
    field("tier").textContent = t.key;
    field("tier").style.color = t.color;
    field("points").textContent = points(t.points);
    const pic = field("img");
    pic.src = img(card.file);
    pic.alt = card.name;
    pic.style.animation = "none";
    void pic.offsetWidth; // restart the landing animation
    pic.style.animation = "";
  }

  function paintClaim() {
    const r = state.rolled;
    if (!r) return;
    const secs = Math.max(0, Math.ceil((r.expiresAt - Date.now()) / 1000));
    const live = !r.claimed && secs > 0;
    claimBtn.disabled = !live;
    claimLabel.textContent = r.claimed ? "طلبتها" : live ? `اطلبها · ${secs}` : "فات الوقت";
    timer.style.display = live ? "" : "none";
    timer.style.inlineSize = `${(secs / RULES.claimWindowSeconds) * 100}%`;
    if (!r.claimed && secs === 0 && !r.expiredShown) {
      r.expiredShown = true;
      status.textContent = "فات الوقت. في السيرفر، أي واحد في القناة كان ينجم يطلبها قبلك.";
    }
    if (live) r.tick = setTimeout(paintClaim, 250);
  }

  async function roll() {
    if (state.spinning) return;
    if (state.left === 0) return reset();
    state.spinning = true;
    rollBtn.disabled = true;
    clearTimeout(state.rolled?.tick);
    const card = pickCard(deck, state.seen);
    state.seen.add(card.file);
    status.textContent = "";
    const ready = new Promise((done) => {
      const pic = new Image();
      pic.onload = pic.onerror = done;
      pic.src = img(card.file);
      setTimeout(done, 1500); // never hold the reveal on a slow image
    });
    if (!reducedMotion()) {
      // The one flourish on the page: tier colours flicker like a slot before the card lands.
      embed.classList.add("spinning");
      field("name").textContent = "…";
      for (let i = 0; i < 9; i++) {
        const c = TIERS[Math.floor(Math.random() * TIERS.length)].color;
        embed.style.setProperty("--bar", c);
        dot.style.background = c;
        await sleep(55 + i * 12);
      }
    }
    await ready;
    embed.classList.remove("spinning");
    show(card);
    field("owner").textContent = "متاحة";
    state.rolled = { card, expiresAt: Date.now() + RULES.claimWindowSeconds * 1000, claimed: false };
    buttons.hidden = false;
    paintClaim();
    state.left -= 1;
    state.spinning = false;
    rollBtn.disabled = false;
    rollLabel.textContent = state.left > 0 ? "ارمي مرة أخرى" : "عاود من الأول";
    left.textContent = state.left > 0 ? `باقيلك ${rollsLeft(state.left)}` : "ما عادش عندك رميات";
    if (state.left === 0) status.textContent = `خلصو رمياتك. في السيرفر يرجعولك بعد ${hours(RULES.rollResetHours)}.`;
  }

  function claim() {
    const r = state.rolled;
    if (!r || r.claimed || Date.now() >= r.expiresAt) return;
    if (state.claimed) {
      const t = tierOf(state.claimed.rarity);
      status.textContent = `طلبت ${t.key} توّا، تستنى ${hours(t.claimHours)} قبل الطلب الجاي. خلّيها لغيرك.`;
      return;
    }
    r.claimed = true;
    state.claimed = r.card;
    clearTimeout(r.tick);
    paintClaim();
    field("owner").textContent = "إنتي";
    const t = tierOf(r.card.rarity);
    status.textContent = `${r.card.name} ولّات متاعك، وزادتك ${points(t.points)}. طلبك الجاي بعد ${hours(t.claimHours)}.`;
  }

  rollBtn.addEventListener("click", roll);
  claimBtn.addEventListener("click", claim);
  reset();
}

// ---------- rarity picker ----------

function rarity(deck) {
  const panel = document.querySelector(".tier-panel");
  const list = panel.querySelector(".tier-cards");
  let active = "الملكة";

  function paint() {
    const t = tierOf(active);
    panel.style.setProperty("--tc", t.color);
    panel.querySelector(".tier-name").textContent = t.key;
    const rarer = TIERS[0].weight / t.weight;
    panel.querySelector(".tier-rule").textContent =
      rarer === 1 ? "الدرجة الأساسية، واللي تطلع أكثر من غيرها." : `كل كرت منها أندر من العادية بـ${times(rarer)}.`;
    panel.querySelector(".pts").textContent = points(t.points);
    panel.querySelector(".tier-wait").textContent = `كي تطلبها، تستنى ${hours(t.claimHours)} قبل الطلب الجاي.`;
    list.replaceChildren(...sample(deck.filter((c) => c.rarity === active), 5).map((c) => {
      const li = document.createElement("li");
      const pic = Object.assign(document.createElement("img"), { src: img(c.file), alt: "", loading: "lazy" });
      const name = Object.assign(document.createElement("b"), { textContent: c.name });
      const desc = Object.assign(document.createElement("span"), { textContent: c.description });
      li.append(pic, name, desc);
      return li;
    }));
  }

  document.querySelectorAll(".rung").forEach((b) =>
    b.addEventListener("click", () => {
      active = b.dataset.tier;
      document.querySelectorAll(".rung").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      paint();
    }),
  );
  panel.querySelector("[data-shuffle]").addEventListener("click", paint);
  paint();
}

// ---------- commands ----------

function commands() {
  const chips = document.querySelectorAll(".chips button");
  chips.forEach((chip) =>
    chip.addEventListener("click", () => {
      chips.forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
      document.querySelectorAll(".cmd-list li").forEach((li) => {
        li.hidden = chip.dataset.group !== "all" && li.dataset.group !== chip.dataset.group;
      });
    }),
  );
  document.querySelectorAll(".copy").forEach((btn) =>
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        btn.textContent = "تنسخ";
        setTimeout(() => (btn.textContent = "انسخ"), 1400);
      } catch {
        btn.textContent = btn.dataset.copy; // no clipboard access: at least show what to type
      }
    }),
  );
}

// ---------- start ----------

commands();
fetch("seed.json")
  .then((r) => r.json())
  .then((seed) => {
    const deck = seed.filter((c) => tierOf(c.rarity)); // public tiers only
    rollDemo(deck);
    rarity(deck);
  })
  .catch(() => {
    // Offline or blocked: the page still reads fine, only the demo stays on its first card.
    document.querySelector("#demo .demo-bar").hidden = true;
  });
