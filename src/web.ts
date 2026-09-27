/**
 * The web server on Railway: the admin dashboard (a React app in dashboard/), its JSON API, and
 * the card images it shows. The public landing page is separate: a static site on GitHub Pages.
 *
 * It starts before the bot logs in, so the dashboard is reachable while Discord is still connecting.
 */
import type { Client } from "discord.js";
import dashboard from "../dashboard/index.html";
import { adminApi, adminEnabled } from "./admin";
import type { SeasonEnd } from "./index";

const ROOT = new URL("../", import.meta.url);
const CARD_IMAGE = /^\/images\/[\w-]+\.(jpe?g|png|webp)$/; // one plain file name: nothing outside images/

export function startWeb(client: Client, endSeason: (guildId: string) => Promise<SeasonEnd | null>): void {
  const port = Number(process.env.PORT ?? 8080);
  if (!adminEnabled()) {
    console.log("web: dashboard disabled (set ADMIN_PASSWORD to enable)");
    return;
  }
  try {
    Bun.serve({
      port,
      idleTimeout: 30,
      development: !process.env.RAILWAY_ENVIRONMENT,
      routes: { "/": dashboard },
      async fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname.startsWith("/api/")) return adminApi(req, client, endSeason);
        if (CARD_IMAGE.test(pathname)) {
          const file = Bun.file(new URL(`.${pathname}`, ROOT));
          if (await file.exists()) return new Response(file, { headers: { "cache-control": "public, max-age=604800" } });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    console.log(`web: dashboard on :${port}`);
  } catch (err) {
    // The dashboard is a convenience; never let it take the bot down with it.
    console.error("web server failed to start:", err);
  }
}
