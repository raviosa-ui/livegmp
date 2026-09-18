/**
 * health_check.js — LiveGMP Agent 3 (site health / self-heal, READ-ONLY)
 *
 * Compares the LIVE site against the repo's committed gmp.json and reports
 * drift. Writes a markdown report to health_report.md and sets GitHub Action
 * outputs. NEVER writes to the site, the repo content, or gmp.json.
 *
 * Checks:
 *   C1  homepage reachable + GMP wrapper present
 *   C2  every gmp.json row appears on the live page
 *   C3  GMP value on live page matches gmp.json
 *   C4  status badge on live page matches gmp.json
 *   C5  status is still correct for TODAY (catches stale Active/Upcoming)
 *   C6  gmp.json freshness (data age)
 *   C7  static assets reachable (css / client js)
 *   C8  sample /ipo/<slug>/ pages + /ipo/ index reachable
 *   C9  sitemap.xml reachable and non-trivial
 *
 * Optional: if GEMINI_API_KEY is set, asks Gemini Flash-Lite for a short
 * diagnosis + suggested fix. Failure of that call is non-fatal.
 *
 * Exit code is ALWAYS 0 unless the script itself crashes — findings are
 * reported via outputs, not by failing the job. A red job would be noise.
 */

const fs = require("fs").promises;
const { load } = require("cheerio");

// ---------------- config ----------------
const SITE = process.env.SITE_URL || "https://livegmp.in";
const GMP_JSON = "gmp.json";
const REPORT = "health_report.md";
const DATA_STALE_HOURS = 36;   // gmp.json older than this = finding
const SAMPLE_IPO_PAGES = 100;    // how many /ipo/<slug>/ pages to spot-check
const UA = "Mozilla/5.0 (compatible; LiveGMPHealthBot/1.0; +https://livegmp.in)";
const GEMINI_MODEL = "gemini-2.5-flash-lite";

const clean = (s = "") => String(s ?? "").replace(/\s+/g, " ").trim();
const slugify = (n) => clean(n).toLowerCase()
  .replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")
  .replace(/-+/g, "-").replace(/^-|-$/g, "");

// ---------------- findings ----------------
const findings = [];
const add = (sev, code, msg, detail) =>
  findings.push({ sev, code, msg, detail: detail || "" });

// ---------------- fetch helpers ----------------
async function get(url, { asText = true } = {}) {
  // cache-bust so we test origin truth, not a Cloudflare edge copy
  const bust = url + (url.includes("?") ? "&" : "?") + "_hc=" + Date.now();
  const res = await fetch(bust, {
    headers: { "User-Agent": UA, "Cache-Control": "no-cache", "Pragma": "no-cache" },
    redirect: "follow",
  });
  return { ok: res.ok, status: res.status, body: asText ? await res.text() : null };
}

async function head(url) {
  const bust = url + (url.includes("?") ? "&" : "?") + "_hc=" + Date.now();
  try {
    const res = await fetch(bust, { method: "GET", headers: { "User-Agent": UA }, redirect: "follow" });
    return res.status;
  } catch (e) {
    return 0;
  }
}

// ---------------- date -> expected status (mirrors build_gmp.js) ----------------
const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };

function parseDayMonth(token, defYear) {
  token = clean(token).replace(/\./g, "");
  let m = token.match(/^(\d{1,2})[-\/](\d{1,2})(?:[-\/](\d{2,4}))?$/);
  if (m) return new Date(m[3] ? +m[3] : defYear, +m[2] - 1, +m[1]);
  m = token.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s*(\d{2,4})?$/);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo !== undefined) return new Date(m[3] ? +m[3] : defYear, mo, +m[1]);
  }
  m = token.match(/^([A-Za-z]{3,})\s+(\d{1,2})\s*(\d{2,4})?$/);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo !== undefined) return new Date(m[3] ? +m[3] : defYear, mo, +m[2]);
  }
  return null;
}

function expectedStatus(text) {
  const raw = clean(text);
  if (!raw || /tba|announc|n\/a/i.test(raw)) return null; // can't judge
  const nowIST = new Date(Date.now() + 5.5 * 3600 * 1000);
  const year = nowIST.getUTCFullYear();
  const norm = raw.replace(/[\u2013\u2014–]/g, "-").replace(/\s+to\s+/i, "-");
  const parts = norm.split("-").map(clean);

  let end = parts.length > 1 ? parseDayMonth(parts[parts.length - 1], year) : null;
  let start = parseDayMonth(parts[0], year);

  if (!start && /^\d{1,2}$/.test(parts[0]) && end) {
    start = new Date(end.getFullYear(), end.getMonth(), +parts[0]);
    if (start > end) start = new Date(end.getFullYear(), end.getMonth() - 1, +parts[0]);
  }
  if (!end && parts.length > 1 && /^\d{1,2}$/.test(parts[parts.length - 1]) && start) {
    end = new Date(start.getFullYear(), start.getMonth(), +parts[parts.length - 1]);
    if (end < start) end = new Date(start.getFullYear(), start.getMonth() + 1, +parts[parts.length - 1]);
  }
  if (!start && !end) return null;
  if (!start) start = end;
  if (!end) end = start;

  const s = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 10, 0);
  const e = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 17, 0);
  if (nowIST < s) return "upcoming";
  if (nowIST <= e) return "active";
  return "closed";
}

// ---------------- live page parsing ----------------
function parseLiveCards(html) {
  const $ = load(html);
  const cards = [];
  $("#gmp-cards .ipo-card").each((_, el) => {
    const $c = $(el);
    cards.push({
      name: clean($c.find(".ipo-title").first().text()),
      gmpText: clean($c.find(".gmp-value").first().text()),
      status: clean($c.attr("data-status") || ""),
      badge: clean($c.find(".badge").first().text()).toLowerCase(),
      type: clean($c.attr("data-type") || ""),
      date: clean($c.find(".col-meta .meta-value").first().text()),
    });
  });
  return { $, cards };
}

// GMP label on the page is "▲ 34" / "▼ 12" / "0" / "—"
function gmpFromLabel(label) {
  const t = clean(label);
  if (!t || t === "—") return null;
  const m = t.match(/(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return t.includes("▼") ? -Math.abs(n) : n;
}

// ---------------- Gemini diagnosis (optional) ----------------
async function diagnose(reportMd) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const prompt = `You are a site-reliability assistant for livegmp.in, a static IPO grey-market-premium site.

Pipeline: a GitHub Actions cron scrapes ipowatch.in hourly with scripts/build_gmp.js, writes gmp.json, injects cards into index.html between GMP_START/GMP_END markers, generates per-IPO stub pages under ipo/<slug>/, regenerates sitemap.xml, commits only when data changed, and Cloudflare Pages deploys on push to main. IPO status is computed from the date range (opens 10:00 IST, closes 17:00 IST on the last day), NOT from the source site's own status column.

Below is an automated health report. In under 200 words: state the single most likely root cause, and the concrete next check or fix. Be specific about files and steps. Do not restate the findings. If the findings look like normal behaviour (e.g. data simply unchanged), say so plainly.

${reportMd}`;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 600, temperature: 0.2 },
        }),
      }
    );
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || "gemini error");
    const cand = data.candidates && data.candidates[0];
    if (!cand || !cand.content || !cand.content.parts) throw new Error("empty response");
    return cand.content.parts.map(p => p.text || "").join("").trim();
  } catch (e) {
    console.log("Gemini diagnosis unavailable:", e.message);
    return null;
  }
}

// ---------------- main ----------------
(async () => {
  console.log(`Health check: ${SITE}`);

  // --- load repo gmp.json (source of truth for what SHOULD be live) ---
  let data = null;
  try {
    data = JSON.parse(await fs.readFile(GMP_JSON, "utf8"));
  } catch (e) {
    add("error", "C0", "gmp.json missing or unparseable in repo", e.message);
  }

  // --- C6 data freshness ---
  if (data && data.updatedIso) {
    const ageH = (Date.now() - Date.parse(data.updatedIso)) / 3600000;
    console.log(`gmp.json age: ${ageH.toFixed(1)}h`);
    if (ageH > DATA_STALE_HOURS) {
      add("warn", "C6",
        `gmp.json is ${ageH.toFixed(1)}h old (threshold ${DATA_STALE_HOURS}h)`,
        "Either the scrape workflow is not running, or scraped data has been byte-identical for that long. Since status is date-derived, it should change at least daily as IPOs cross their open/close boundaries.");
    }
  }

  // --- C1 homepage ---
  let live = null;
  try {
    const r = await get(SITE + "/");
    if (!r.ok) {
      add("error", "C1", `Homepage returned HTTP ${r.status}`);
    } else {
      live = parseLiveCards(r.body);
      if (!r.body.includes('id="gmp-wrapper"')) {
        add("error", "C1", "Homepage loaded but #gmp-wrapper is missing",
          "The GMP_START/GMP_END injection may have failed, or an un-built index.html was deployed.");
      } else if (live.cards.length === 0) {
        add("error", "C1", "Homepage has #gmp-wrapper but zero .ipo-card elements");
      } else {
        console.log(`Live cards: ${live.cards.length}`);
      }
    }
  } catch (e) {
    add("error", "C1", "Homepage fetch failed", e.message);
  }

  // --- C2/C3/C4 compare repo data vs live page ---
  if (live && data && Array.isArray(data.rows)) {
    const liveBySlug = new Map(live.cards.map(c => [slugify(c.name), c]));
    // only the rows that should be rendered: build_gmp caps each group at 10
    const groups = { active: [], upcoming: [], closed: [] };
    for (const r of data.rows) (groups[r.status] || groups.upcoming).push(r);
    const byGmp = (a, b) => {
      if (a.gmp === null && b.gmp === null) return a.ipo.localeCompare(b.ipo);
      if (a.gmp === null) return 1;
      if (b.gmp === null) return -1;
      return b.gmp - a.gmp;
    };
    const expectedRows = []
      .concat(groups.active.sort(byGmp).slice(0, 10))
      .concat(groups.upcoming.sort(byGmp).slice(0, 10))
      .concat(groups.closed.sort(byGmp).slice(0, 10));

    const missing = [];
    for (const row of expectedRows) {
      const slug = slugify(row.ipo);
      const card = liveBySlug.get(slug);
      if (!card) { missing.push(row.ipo); continue; }

      const liveGmp = gmpFromLabel(card.gmpText);
      if (liveGmp !== row.gmp) {
        add("error", "C3", `GMP mismatch: ${row.ipo}`,
          `repo gmp.json = ${row.gmp === null ? "—" : row.gmp}, live page = ${liveGmp === null ? "—" : liveGmp}`);
      }
      if (card.status !== row.status) {
        add("error", "C4", `Status mismatch: ${row.ipo}`,
          `repo gmp.json = ${row.status}, live page = ${card.status}`);
      }
    }
    if (missing.length) {
      add("error", "C2", `${missing.length} IPO(s) in gmp.json are absent from the live page`,
        missing.join(", "));
    }
    // reverse: live shows something the data no longer has
    const expectedSlugs = new Set(expectedRows.map(r => slugify(r.ipo)));
    const extra = live.cards.map(c => c.name).filter(n => !expectedSlugs.has(slugify(n)));
    if (extra.length) {
      add("warn", "C2", `${extra.length} IPO(s) on the live page are not in the current gmp.json`,
        extra.join(", ") + " — usually means a stale index.html is deployed.");
    }
  }

  // --- C5 status still correct for today (catches the stale-Active class of bug) ---
  if (data && Array.isArray(data.rows)) {
    const wrong = [];
    for (const row of data.rows) {
      const exp = expectedStatus(row.date);
      if (exp && exp !== row.status) wrong.push(`${row.ipo} (${row.date}): is "${row.status}", should be "${exp}"`);
    }
    if (wrong.length) {
      add("error", "C5", `${wrong.length} IPO(s) have a status that is wrong for today's date`,
        wrong.join("\n") + "\n\nThe scrape workflow has not run (or not committed) since these crossed their boundary. Check Actions for 'Update GMP'.");
    }
  }

  // --- C7 static assets ---
  for (const path of ["/static/gmp.css", "/static/gmp-client.js"]) {
    const s = await head(SITE + path);
    if (s !== 200) add("error", "C7", `Static asset not reachable: ${path}`, `HTTP ${s}`);
  }

  // --- C8 ipo index + sample stub pages ---
  {
    const s = await head(SITE + "/ipo/");
    if (s !== 200) add("error", "C8", "/ipo/ index not reachable", `HTTP ${s}`);
  }
  if (data && Array.isArray(data.rows) && data.rows.length) {
    const pool = [...data.rows];
    const picks = [];
    for (let i = 0; i < Math.min(SAMPLE_IPO_PAGES, pool.length); i++) {
      picks.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    for (const r of picks) {
      const slug = slugify(r.ipo);
      const s = await head(`${SITE}/ipo/${slug}/`);
      if (s !== 200) add("error", "C8", `IPO page not reachable: /ipo/${slug}/`, `HTTP ${s} (${r.ipo})`);
    }
  }

  // --- C9 sitemap ---
  try {
    const r = await get(SITE + "/sitemap.xml");
    if (!r.ok) add("warn", "C9", `sitemap.xml returned HTTP ${r.status}`);
    else {
      const count = (r.body.match(/<url>/g) || []).length;
      if (count < 4) add("warn", "C9", `sitemap.xml has only ${count} URLs`, "Expected static pages plus one per IPO.");
    }
  } catch (e) {
    add("warn", "C9", "sitemap.xml fetch failed", e.message);
  }

  // ---------------- report ----------------
  const errors = findings.filter(f => f.sev === "error");
  const warns = findings.filter(f => f.sev === "warn");
  const healthy = findings.length === 0;

  const now = new Date();
  const stamp = now.toLocaleString("en-GB", { timeZone: "Asia/Kolkata" }) + " IST";

  let md = `## LiveGMP health check — ${stamp}\n\n`;
  if (healthy) {
    md += `All checks passed.\n\n`;
    md += `- Live cards: ${live ? live.cards.length : "n/a"}\n`;
    md += `- gmp.json rows: ${data && data.rows ? data.rows.length : "n/a"}\n`;
    md += `- Data timestamp: ${data ? data.updatedLocal || data.updatedIso : "n/a"}\n`;
  } else {
    md += `**${errors.length} error(s), ${warns.length} warning(s).**\n\n`;
    const render = (list, heading) => {
      if (!list.length) return "";
      let s = `### ${heading}\n\n`;
      for (const f of list) {
        s += `- **[${f.code}] ${f.msg}**\n`;
        if (f.detail) s += `\n  \`\`\`\n  ${f.detail.split("\n").join("\n  ")}\n  \`\`\`\n`;
      }
      return s + "\n";
    };
    md += render(errors, "Errors");
    md += render(warns, "Warnings");
    md += `### Context\n\n`;
    md += `- gmp.json rows: ${data && data.rows ? data.rows.length : "n/a"}\n`;
    md += `- gmp.json timestamp: ${data ? data.updatedLocal || data.updatedIso : "n/a"}\n`;
    md += `- Live cards rendered: ${live ? live.cards.length : "n/a"}\n`;
    md += `- Checked against: ${SITE}\n`;
  }

  if (!healthy) {
    const dx = await diagnose(md);
    if (dx) md += `\n### Suggested diagnosis (Gemini ${GEMINI_MODEL})\n\n${dx}\n`;
  }

  md += `\n---\n<sub>Agent 3 · read-only health check · nothing was modified.</sub>\n`;

  await fs.writeFile(REPORT, md, "utf8");
  console.log("\n" + md);

  // GitHub Action outputs
  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT,
      `healthy=${healthy}\nerrors=${errors.length}\nwarnings=${warns.length}\n`, "utf8");
  }
})().catch(async (err) => {
  console.error("Health check crashed:", err && err.stack ? err.stack : err);
  try {
    await fs.writeFile(REPORT,
      `## LiveGMP health check — CRASHED\n\nThe health check script itself failed:\n\n\`\`\`\n${String(err && err.stack || err)}\n\`\`\`\n`, "utf8");
    if (process.env.GITHUB_OUTPUT) {
      await fs.appendFile(process.env.GITHUB_OUTPUT, `healthy=false\nerrors=1\nwarnings=0\n`, "utf8");
    }
  } catch {}
  process.exit(0); // never fail the job; the issue carries the signal
});
