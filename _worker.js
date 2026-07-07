// Salv Pundit Cup — Cloudflare Pages advanced-mode Worker (drag-and-drop friendly).
// Place this file at the ROOT of the uploaded folder next to index.html.
// It serves the static page AND proxies /api/* to Notion using the secret env.NOTION_TOKEN.

const PLAYERS_DB = "f936f2eda5c8461395ba78dcd662d91c";   // Players database
const FIXTURES_DB = "6dabff47331c4fdcb97c4bda5ad1177e";  // Fixtures & Results database
const NOTION = "https://api.notion.com/v1";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Anything that is not /api/* is a static file (index.html, etc.)
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    const path = url.pathname.replace(/\/+$/, "");
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    const json = (o, s = 200) =>
      new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", ...cors } });

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (!env.NOTION_TOKEN) return json({ error: "NOTION_TOKEN not set" }, 500);

    const H = {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    };

    try {
      // ---- GET /api/state ----
      if (path.endsWith("/api/state") && request.method === "GET") {
        const results = {};
        let cursor;
        do {
          const body = { page_size: 100 };
          if (cursor) body.start_cursor = cursor;
          const r = await fetch(`${NOTION}/databases/${FIXTURES_DB}/query`, { method: "POST", headers: H, body: JSON.stringify(body) });
          const d = await r.json();
          for (const p of d.results || []) {
            const pr = p.properties;
            const no = pr.MatchNo && pr.MatchNo.number;
            const hg = pr.HomeGoals && pr.HomeGoals.number;
            const ag = pr.AwayGoals && pr.AwayGoals.number;
            if (no != null && hg != null && ag != null) {
              const r = { h: hg, a: ag };
              const ph = pr.PenHome && pr.PenHome.number;
              const pa = pr.PenAway && pr.PenAway.number;
              if (ph != null && pa != null) { r.ph = ph; r.pa = pa; r.pw = ph > pa ? "h" : "a"; }
              results[no] = r;
            }
          }
          cursor = d.has_more ? d.next_cursor : null;
        } while (cursor);

        const players = [];
        cursor = undefined;
        do {
          const body = { page_size: 100 };
          if (cursor) body.start_cursor = cursor;
          const r = await fetch(`${NOTION}/databases/${PLAYERS_DB}/query`, { method: "POST", headers: H, body: JSON.stringify(body) });
          const d = await r.json();
          for (const p of d.results || []) {
            const pr = p.properties;
            const name = (pr.Name && pr.Name.title && pr.Name.title[0] && pr.Name.title[0].plain_text) || "";
            const raw = ((pr.Predictions && pr.Predictions.rich_text) || []).map((t) => t.plain_text).join("");
            let preds = {};
            try { preds = raw ? JSON.parse(raw) : {}; } catch (e) { preds = {}; }
            if (name) players.push({ name, preds });
          }
          cursor = d.has_more ? d.next_cursor : null;
        } while (cursor);

        return json({ results, players });
      }

      // ---- POST /api/predict ----
      if (path.endsWith("/api/predict") && request.method === "POST") {
        const { name, preds } = await request.json();
        if (!name || typeof name !== "string") return json({ error: "name required" }, 400);
        const incoming = (preds && typeof preds === "object") ? preds : {};
        // Split into <2000-char rich_text chunks so long prediction sets are never truncated.
        const chunk = (s) => { const a = []; for (let i = 0; i < s.length; i += 1900) a.push({ type: "text", text: { content: s.slice(i, i + 1900) } }); return a.length ? a : [{ type: "text", text: { content: "{}" } }]; };

        const q = await fetch(`${NOTION}/databases/${PLAYERS_DB}/query`, {
          method: "POST", headers: H,
          body: JSON.stringify({ filter: { property: "Name", title: { equals: name } }, page_size: 1 }),
        });
        const qd = await q.json();

        if (qd.results && qd.results.length) {
          // Merge onto existing so a stale or partial client can never wipe saved picks.
          const pr = qd.results[0].properties;
          const raw = ((pr.Predictions && pr.Predictions.rich_text) || []).map((t) => t.plain_text).join("");
          let existing = {};
          try { existing = raw ? JSON.parse(raw) : {}; } catch (e) { existing = {}; }
          const merged = Object.assign({}, existing, incoming);
          await fetch(`${NOTION}/pages/${qd.results[0].id}`, {
            method: "PATCH", headers: H,
            body: JSON.stringify({ properties: { Predictions: { rich_text: chunk(JSON.stringify(merged)) } } }),
          });
        } else {
          await fetch(`${NOTION}/pages`, {
            method: "POST", headers: H,
            body: JSON.stringify({
              parent: { database_id: PLAYERS_DB },
              properties: { Name: { title: [{ text: { content: name } }] }, Predictions: { rich_text: chunk(JSON.stringify(incoming)) } },
            }),
          });
        }
        return json({ ok: true });
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  },
};
