# Haifu Rolls

![Haifu Rolls](haifu-cover.jpg)

**[➕ Add Haifu Rolls to your server](https://discord.com/oauth2/authorize?client_id=1545127309353287761&scope=bot%20applications.commands&permissions=2147534848)**
The bot is hosted and online 24/7. No setup needed. It asks only for Send Messages, Embed Links, Attach Files, and slash commands. No admin.

Mudae-style card game for Discord. Every card is a Haifa Wehbe photo.
**500 cards are included** in `images/` with hand-picked rarities and Arabic names (`seed.json`).
Any new photo you drop in later gets a random **rarity** (weighted dice) and a name from a curated list.

## Commands

| Command | What it does |
|---|---|
| `/roll` | Roll a random card. Unclaimed cards show a claim button for 30 seconds |
| `/collection [member]` | Summary page plus one card per page with its photo. Prev / next buttons, greyed out after 2 idle minutes |
| `/card <id or name>` | Look up a card and see who owns it |
| `/deck` | How many cards exist, how many are claimed, and how many are left per rarity |
| `/top [season]` | This season's standings. Pass a number to see a finished season |
| `/leaderboard` | All-time table of season medals. Never resets |
| `/divorce <id or name>` | Release a card you own |
| `/gift <member> <id or name>` | Give a card away |
| `/exchange <member> <my_card> <their_card>` | Propose a trade by id or name. The other member gets Accept / Decline buttons (5 min) |
| `/duel <member> <my_card> <their_card>` | Stake up to 10 cards against theirs, comma-separated. A draw decides, winner takes all |
| `/rescan` | (Manage Server) register new photos in `images/` |
| `/backup` | (bot owner) download the database file |
| `/restore <file>` | (bot owner) replace the database with an uploaded `haifa.db` |

## Rarity

| Tier | Roll chance | Points |
|---|---|---|
| ⚪ عادية | 50% | 1 |
| 🟢 مميزة | 28% | 3 |
| 🔵 نادرة | 14% | 8 |
| 🟣 أسطورية | 6% | 20 |
| 👑 الملكة | 2% | 50 |

**Card Rush:** every 2-6 hours the bot drops a card in the channel it was last used in. It is نادرة or better,
costs nothing, never expires, and the first person to press the button keeps it. Late joiners catch up here.
Tune it with `RUSH_MIN_HOURS`, `RUSH_MAX_HOURS`, and `RUSH_MIN_RARITY` in `config.ts`.

A player is never shown the same card twice in one day's rolls, unless every remaining card has
already been shown to them.

Rolls only show cards nobody in the server owns yet (`ROLL_ONLY_UNCLAIMED` in `src/config.ts`; set to `False` to roll owned cards too).

Limits: **3 rolls per day**, **1 claim per day**. Both reset at **midnight**, local time of the machine running the bot. Numbers live in `src/config.ts`.

## Run your own copy (optional)

1. Create the bot at https://discord.com/developers/applications → New Application → Bot → **Reset Token**, copy it.
2. Same page → OAuth2 → URL Generator: scope `bot` + `applications.commands`,
   permissions `Send Messages`, `Embed Links`, `Attach Files`. Open the URL to invite the bot to your server.
3. Install [Bun](https://bun.sh) (one command, no admin rights), then install the two dependencies:

```bash
bun install
```

4. Create a file named `.env` in this folder with one line. Bun loads it automatically.

```
DISCORD_TOKEN=paste_token_here
```

5. Start the bot:

```bash
bun start
```

`bun start` runs with `--smol`, which trades a little speed for a smaller memory footprint. Handy on free hosts.

On first start the bot registers the 500 seeded cards. Add more photos to `images/` later and run `/rescan`.

Slash commands can take up to an hour to appear the first time. Kick the bot and re-invite it if they don't show.

Every card has a **number** shown on its embed and next to its name in `/collection`.
Anywhere a command asks for a card you can type the number instead of the Arabic name: `/card 42` or `/gift @someone 42`.

## Duels

`/duel` stakes your cards against someone else's. Either side can put up **several cards at once**,
separated by commas: `/duel @them 42,43,44 322`. They get Accept / Decline buttons, and on accept a
straight **50/50 coin flip** decides it. The winner takes everything staked.

- Stakes are **free**: anything against anything. The defender has to accept, and each side's cards are
  listed with a running total (`5 كرت · 15 نقطة`), so a lopsided offer is obvious before they decide.
- No limit on how many cards a side may stake. Offers longer than `DUEL_LIST_LIMIT` (10) list the
  first ten and summarise the rest, but the totals always count every card.
- Every card's owner is re-checked at the moment of the flip, and the whole duel is one atomic write:
  if any single card moved while the offer was open, nothing changes at all.
- On accept the message spins for a few seconds, then reveals the result. Every spin frame is
  identical for both players, so nothing in it hints at the outcome. The winner is decided and the
  cards awarded **before** the spin, so a dropped frame or a restart never changes who won.
- No daily cap: the other side has to agree to every duel, so consent is the throttle.
- Tune it with `DUEL_LIST_LIMIT`, `DUEL_WINDOW_SECONDS`, and `DUEL_SUSPENSE_MS` (0 for an instant reveal) in `config.ts`.
- Pending offers live in memory, so a restart cancels any that are still open. They only last 5 minutes anyway.

## Admin dashboard

A web page for managing the game without touching SQL. It only runs when `ADMIN_PASSWORD` is set.

- Lists every server, with players, cards claimed, and the season.
- Per server: every player's collection size and points, and every card with its owner.
- Filter cards by number or name, by rarity, and by owner (including unclaimed only).
- Give a card to anyone, or send one back to the pool.
- Sign in once; a cookie keeps you signed in on that device for 30 days.

Set `ADMIN_PASSWORD` in the host's variables and open the service's public URL.

## Seasons

A season runs until the **last unclaimed card in that server is taken**. Then:

- The top five get permanent medal points: **5, 4, 3, 2, 1**.
- The bot announces the winners and the next season opens, with every card rollable again.
- Old claims are **archived, not deleted**, so past standings and collections stay readable.

Seasons are per server, so one server can be on season 3 while another is still on season 1.
`/top` shows the live season, `/top 1` a finished one, and `/leaderboard` the all-time medal table.
There is no way to end a season by hand; it only ends when the cards run out.

## Card images: attachments or URLs

Card images are served from this repo's raw GitHub URLs (`IMAGE_BASE_URL` in `src/config.ts`). This only works while
the repo is **public**. If you make it private, set `IMAGE_BASE_URL = ""` and the bot uploads images as attachments instead.
New photos added with `/rescan` must also be pushed to GitHub before their URL works.

## Images are compressed before commit

`scripts/optimize-images.ts` resizes card images to 1280 px max and re-encodes them as progressive JPEG.
A git hook runs it on every staged image automatically. Enable the hook once per clone:

```bash
git config core.hooksPath hooks
```

To compress everything by hand:

```bash
bun run optimize
```

## Hosting on Railway (persistent database)

Railway wipes the container disk on every deploy, so the database must live on a **Volume**:

1. In your Railway service: **Volumes → Add Volume**, mount path `/data`.
2. **Variables**: add `DB_PATH=/data/haifa.db` (and `DISCORD_TOKEN` if not set yet). Redeploy.
3. Move your existing database from your PC: stop the local bot, then in Discord run
   `/restore` and attach your local `haifa.db`. The bot swaps the file in place and confirms the card count.
4. Any time: `/backup` sends you the current database as a file. Keep one somewhere safe.

`/backup` and `/restore` only work for the owner of the Discord application.

## Files

- `src/index.ts` – Discord bot and commands (discord.js)
- `src/scanner.ts` – registers new photos: uses `seed.json` if the file is listed there, else random (edit the name lists here)
- `seed.json` – the 500 curated cards: file, name, rarity, description. Edit names or rarities here before first run
- `src/db.ts` – SQLite via `bun:sqlite` (`haifa.db`): cards, owners, daily limits. Ownership is per server.
- `src/config.ts` – rarities, weights, points, daily limits, `ROLL_ONLY_UNCLAIMED`, `IMAGE_BASE_URL`
- `scripts/optimize-images.ts` + `hooks/pre-commit` – image compression (sharp), automatic on commit
- `index.html` – landing page with the invite link (open it locally, or serve it from anywhere)
