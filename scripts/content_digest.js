/**
 * content_digest.js — LiveGMP Agent 4 (daily worklist, READ-ONLY)
 *
 * Answers one question each morning: which IPO pages still need an article,
 * and which of those can actually be generated right now?
 *
 * A page is "pending" if it still carries the AUTO_STUB marker — i.e. the
 * pipeline created it but no human-approved prose has ever been merged.
 *
 * For each pending page it works out:
 *   - type (Mainboard / SME) and status (active / upcoming / closed)
 *   - how many days until the IPO opens or closes  -> urgency
 *   - whether a SEBI filing exists for it in data/filings.json -> actionable
 *
 * Then sends ONE Telegram message, ordered so the top line is the thing most
 * worth writing today. Errors are the watchdog's job; this only reports work.
 *
 * Writes nothing. Sends nothing if there is nothing to do.
 */

const fs = require("fs").promises;

// ---------------- config ----------------
const GMP_JSON    = "gmp.json";
const FILINGS     = "data/filings.json";
const IPO_DIR     = "ipo";
const STUB_MARK   = "<!-- AUTO_STUB -->";
const MAX_LINES   = 14;          // Telegram message stays readable
const SKIP_CLOSED_OLDER_THAN_DAYS = 21;

const clean = (s = "") => String(s ?? "").replace(/\s+/g, " ").trim();

function normalizeKey(name) {
  return clean(name).toLowerCase()
    .replace(/[.,'’&()]/g, " ")
    .replace(/\b(private|pvt|limited|ltd|company|co|corporation|corp|industries|enterprises|the)\b/g, " ")
    .replace(/\bipo\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Same matcher shape as the pipeline: exact, containment, acronym, tokens.
function nameMatch(a, b) {
  const ka = normalizeKey(a), kb = normalizeKey(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  if (ka.length > 6 && kb.length > 6 && (ka.includes(kb) || kb.includes(ka))) return 0.95;
  // whole-word prefix: "kmc" vs "kmc aluminium", "solanki" vs "solanki mechanic works"
  if (ka.length >= 3 && kb.length >= 3) {
    if (kb.startsWith(ka + " ") || ka.startsWith(kb + " ")) return 0.9;
    if (kb.endsWith(" " + ka) || ka.endsWith(" " + kb)) return 0.9;
  }
  const initials = (k) => k.split(" ").filter(Boolean).map(w => w[0]).join("");
  const short = ka.length <= 6 && !ka.includes(" ") ? ka
              : kb.length <= 6 && !kb.includes(" ") ? kb : null;
  if (short) {
    const other = short === ka ? kb : ka;
    const ini = initials(other);
    // The name must spell the initials, not merely share their first letter or
    // two: "ardee" vs "asset reconstruction" (initials "ar") is not a match,
    // "smwl" vs "solanki mechanic works" (initials "smw", L = Limited) is.
    if (ini.startsWith(short) ||
        (ini.length >= 3 && short.length - ini.length <= 1 && short.startsWith(ini))) return 0.9;
  }
  const ta = new Set(ka.split(" ").filter(w => w.length > 2));
  const tb = new Set(kb.split(" ").filter(w => w.length > 2));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  let score = shared / Math.min(ta.size, tb.size);
  if (Math.min(ta.size, tb.size) === 1) score = Math.min(score, 0.55);
  return score;
}

// ---------------- dates ----------------
const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };

function parseDayMonth(token, defYear) {
  token = clean(token).replace(/\./g, "");
  let m = token.match(/^(\d{1,2})[-\/](\d{1,2})(?:[-\/](\d{2,4}))?$/);
  if (m) return new Date(m[3] ? +m[3] : defYear, +m[2] - 1, +m[1]);
  m = token.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s*(\d{2,4})?$/);
  if (m) { const mo = MONTHS[m[2].slice(0,3).toLowerCase()]; if (mo !== undefined) return new Date(m[3]?+m[3]:defYear, mo, +m[1]); }
  m = token.match(/^([A-Za-z]{3,})\s+(\d{1,2})\s*(\d{2,4})?$/);
  if (m) { const mo = MONTHS[m[1].slice(0,3).toLowerCase()]; if (mo !== undefined) return new Date(m[3]?+m[3]:defYear, mo, +m[2]); }
  return null;
}

// Days until the IPO opens (positive) / days since it closed (negative).
function timing(dateText) {
  const raw = clean(dateText);
  if (!raw || /tba|announc|n\/a/i.test(raw)) return { open: null, close: null };
  const nowIST = new Date(Date.now() + 5.5 * 3600 * 1000);
  const year = nowIST.getUTCFullYear();
  const parts = raw.replace(/[\u2013\u2014–]/g, "-").replace(/\s+to\s+/i, "-").split("-").map(clean);
  let end = parts.length > 1 ? parseDayMonth(parts[parts.length - 1], year) : null;
  let start = parseDayMonth(parts[0], year);
  if (!start && /^\d{1,2}$/.test(parts[0]) && end) {
    start = new Date(end.getFullYear(), end.getMonth(), +parts[0]);
    if (start > end) start = new Date(end.getFullYear(), end.getMonth() - 1, +parts[0]);
  }
  if (!start && !end) return { open: null, close: null };
  if (!start) start = end;
  if (!end) end = start;
  const day = 86400000;
  return {
    open:  Math.round((start - nowIST) / day),
    close: Math.round((end - nowIST) / day),
  };
}


// ---------------- duplicate page detection ----------------
// A DRHP page published months early under the company's full legal name, and
// the same company later appearing in the GMP table under a short name or an
// acronym, produce TWO pages for one company — splitting the URL age the
// early-publish strategy exists to build.
//
// Reported, never merged automatically: a wrong merge would overwrite one
// company's page with another's data and cannot be undone.
function findDuplicates(dirs, rows, aliases) {
  const known = new Set(Object.values(aliases || {}));
  const out = [];

  // (a) two existing page directories that look like the same company
  for (let i = 0; i < dirs.length; i++) {
    for (let j = i + 1; j < dirs.length; j++) {
      const a = dirs[i].replace(/-/g, " "), b = dirs[j].replace(/-/g, " ");
      const score = nameMatch(a, b);
      if (score >= 0.8) out.push({ kind: "pages", a: dirs[i], b: dirs[j], score });
    }
  }

  // (b) a tracked IPO whose slug has no page, but which resembles one that does
  for (const r of rows) {
    const slug = r.slug || slugify(r.ipo);
    if (dirs.includes(slug)) continue;
    for (const d of dirs) {
      const score = nameMatch(r.ipo, d.replace(/-/g, " "));
      if (score >= 0.8) { out.push({ kind: "incoming", name: r.ipo, slug, existing: d, score }); break; }
    }
  }

  // anything already resolved by an alias is not a problem
  return out.filter(x => !(x.kind === "incoming" && known.has(x.slug)));
}

// ---------------- telegram ----------------
async function telegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat  = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) { console.log("Telegram not configured — digest printed to the log only."); return false; }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  const j = await res.json();
  if (!j.ok) { console.log("Telegram rejected: " + (j.description || "unknown")); return false; }
  return true;
}

// ---------------- main ----------------
(async () => {
  // gmp.json — the IPOs we currently track
  let rows = [];
  try {
    rows = (JSON.parse(await fs.readFile(GMP_JSON, "utf8")).rows) || [];
  } catch (e) {
    console.log(`Cannot read ${GMP_JSON}: ${e.message} — nothing to report.`);
    return;
  }

  // SEBI filings Agent 1 has seen
  let filings = [];
  try {
    const st = JSON.parse(await fs.readFile(FILINGS, "utf8"));
    filings = Object.values(st.seen || {}).map(f => ({ title: f.title || "", kind: f.kind || "", date: f.date || "" }));
  } catch { /* fine — just means nothing matched */ }

  // which pages are still stubs?
  let dirs = [];
  try {
    dirs = (await fs.readdir(IPO_DIR, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name);
  } catch { console.log("No ipo/ directory."); return; }

  let aliases = {};
  try { aliases = JSON.parse(await fs.readFile("data/ipo_aliases.json", "utf8")); } catch {}

  const stubs = new Set();
  for (const d of dirs) {
    try {
      const html = await fs.readFile(`${IPO_DIR}/${d}/index.html`, "utf8");
      if (html.includes(STUB_MARK)) stubs.add(d);
    } catch {}
  }
  const written = dirs.length - stubs.size;
  console.log(`Pages: ${dirs.length} total, ${written} with articles, ${stubs.size} stubs`);

  const dupes = findDuplicates(dirs, rows, aliases);
  if (dupes.length) {
    console.log(`Possible duplicate pages: ${dupes.length}`);
    for (const d of dupes) console.log("  " + JSON.stringify(d));
  }

  // build the worklist
  const slugify = (n) => clean(n).toLowerCase().replace(/\s+/g,"-").replace(/[^a-z0-9-]/g,"").replace(/-+/g,"-").replace(/^-|-$/g,"");
  const items = [];
  for (const r of rows) {
    const slug = r.slug || slugify(r.ipo);
    if (!stubs.has(slug)) continue;                       // already has an article

    const t = timing(r.date);
    if (r.status === "closed" && t.close !== null && t.close < -SKIP_CLOSED_OLDER_THAN_DAYS) continue;

    // does SEBI have a filing for it?
    let filing = null;
    for (const f of filings) {
      if (nameMatch(r.ipo, f.title.replace(/\s*[-–—]\s*(drhp|udrhp.*|rhp|addendum.*|corrigendum.*)$/i, "")) >= 0.8) { filing = f; break; }
    }

    // urgency: smaller = more urgent
    let urgency;
    if (r.status === "active")        urgency = 0 + Math.max(0, t.close ?? 0);
    else if (r.status === "upcoming") urgency = 10 + Math.max(0, t.open ?? 30);
    else                              urgency = 100 + Math.abs(t.close ?? 0);

    items.push({ ...r, slug, filing, t, urgency,
      actionable: !!filing,
      mainboard: r.type === "Mainboard" });
  }

  if (!items.length && !dupes.length) {
    console.log("Nothing pending — every tracked IPO already has an article, no duplicates.");
    return;
  }

  // actionable mainboard first, then urgency
  items.sort((a, b) =>
    (b.actionable - a.actionable) ||
    (b.mainboard - a.mainboard) ||
    (a.urgency - b.urgency));

  const ready   = items.filter(i => i.actionable);
  const noDoc   = items.filter(i => !i.actionable);
  const mainNo  = noDoc.filter(i => i.mainboard);
  const smeNo   = noDoc.filter(i => !i.mainboard);

  const when = (i) => {
    if (i.status === "active")   return i.t.close === null ? "open now" : `closes in ${i.t.close}d`;
    if (i.status === "upcoming") return i.t.open === null ? "date TBA" : `opens in ${i.t.open}d`;
    return i.t.close === null ? "closed" : `closed ${Math.abs(i.t.close)}d ago`;
  };
  const esc = (s) => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

  let msg = `📝 <b>LiveGMP — daily digest</b>\n`;
  msg += `${stubs.size} stub page(s), ${written} written${dupes.length ? `, ${dupes.length} possible duplicate(s)` : ""}\n`;

  if (ready.length) {
    msg += `\n<b>Ready to generate</b> (SEBI filing found)\n`;
    for (const i of ready.slice(0, MAX_LINES)) {
      msg += `• ${esc(i.ipo)} — ${i.type}, ${when(i)} [${esc(i.filing.kind)}]\n`;
    }
  }
  if (mainNo.length) {
    msg += `\n<b>Mainboard, no filing matched</b>\n`;
    for (const i of mainNo.slice(0, 6)) msg += `• ${esc(i.ipo)} — ${when(i)}\n`;
  }
  if (smeNo.length) {
    msg += `\n<b>SME</b> (no reachable document — manual source needed)\n`;
    for (const i of smeNo.slice(0, 6)) msg += `• ${esc(i.ipo)} — ${when(i)}\n`;
    if (smeNo.length > 6) msg += `…and ${smeNo.length - 6} more\n`;
  }
  if (dupes.length) {
    msg += `\n⚠️ <b>Possible duplicate pages</b>\n`;
    for (const d of dupes.slice(0, 5)) {
      if (d.kind === "pages") {
        msg += `• /ipo/${esc(d.a)}/ and /ipo/${esc(d.b)}/ look like one company\n`;
      } else {
        msg += `• "${esc(d.name)}" will create /ipo/${esc(d.slug)}/ but /ipo/${esc(d.existing)}/ exists\n`;
        msg += `  fix: add "${esc(d.name)}": "${esc(d.existing)}" to ipo_aliases.json\n`;
      }
    }
    if (dupes.length > 5) msg += `…and ${dupes.length - 5} more\n`;
  }
  msg += `\nhttps://github.com/${process.env.GITHUB_REPOSITORY || "raviosa-ui/livegmp"}/issues`;

  console.log("\n" + msg.replace(/<[^>]+>/g, ""));
  await telegram(msg);

  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT,
      `pending=${items.length}\nready=${ready.length}\n`, "utf8");
  }
})().catch(err => {
  console.error("Digest failed:", err && err.stack ? err.stack : err);
  process.exit(0);   // never red: this is a worklist, not a health check
});
