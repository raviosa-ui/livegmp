/**
 * build_gmp.js — LiveGMP pipeline builder (v5, two-zone IPO pages)
 *
 * Flow:  fetch source (tiered) -> parse by HEADER NAME -> validate ->
 *        write gmp.json -> rebuild homepage between GMP_START/GMP_END ->
 *        create/refresh per-IPO pages -> /ipo/ index -> sitemap.
 *
 * TWO-ZONE IPO PAGES (new in v5)
 * ------------------------------
 * Every /ipo/<slug>/index.html contains two zones:
 *
 *   <!-- LIVE_START --> ... <!-- LIVE_END -->
 *       Machine-owned. GMP, status, dates, price band, key-details table.
 *       Rewritten on EVERY run, forever, on every page — stub or hand-written.
 *
 *   <!-- PROSE_START --> ... <!-- PROSE_END -->
 *       Human-owned. DRHP analysis, business, financials, risks, verdict.
 *       NEVER touched by this script once written.
 *
 * Page lifecycle:
 *   1. IPO appears in the GMP table  -> full page generated, PROSE zone holds
 *      a "coming soon" placeholder, page carries <!-- AUTO_STUB -->.
 *   2. You publish real analysis via PR -> remove the AUTO_STUB marker, write
 *      your prose inside the PROSE zone, set your own <title>/<meta>.
 *   3. From then on this script only ever rewrites the LIVE zone. Your prose,
 *      title, meta and schema are yours. GMP keeps updating underneath.
 *
 * This is what lets a DRHP-stage page keep its URL and accumulate age while
 * its live data stays current all the way through listing.
 *
 * Safety rules (unchanged):
 *  - A row is accepted only if GMP parses as a number or an explicit blank.
 *  - A source is accepted only if it yields >= MIN_ROWS valid rows.
 *  - If ALL sources fail, exit nonzero and touch nothing.
 *  - If parsed data is identical to committed gmp.json, exit 0 without writing.
 *  - Status is computed from the DATE (IST), not from the source's status text.
 *
 * Requires: cheerio. Node 20+ (global fetch).
 */

const fs = require("fs").promises;
const { load } = require("cheerio");

// ---------------- config ----------------
const MAX_PER_GROUP = 10;
const MIN_ROWS = 8;
const MIN_VALID_RATIO = 0.7;
const GMP_JSON = "gmp.json";
const INDEX_HTML = "index.html";
const UA = "Mozilla/5.0 (compatible; LiveGMPBot/2.0; +https://livegmp.in)";
const SITE = "https://livegmp.in";
let NSE_NAMES = new Set();   // filled at startup from the NSE API

// zone markers
const STUB_MARK   = "<!-- AUTO_STUB -->";      // page has no human prose yet
const LIVE_START  = "<!-- LIVE_START -->";     // machine-owned zone
const LIVE_END    = "<!-- LIVE_END -->";
const PROSE_START = "<!-- PROSE_START -->";    // human-owned zone
const PROSE_END   = "<!-- PROSE_END -->";

const SOURCES = [
  { name: "ipowatch", url: "https://ipowatch.in/ipo-grey-market-premium-latest-ipo-gmp/" },
  { name: "ipowala",  url: "https://ipowala.in/ipo-grey-market-premium-gmp/" },
  { name: "chanakya", url: "https://chanakyanipothi.com/ipo-gmp-today/" },
];

const HEADER_MAP = [
  { field: "ipo",     keys: ["ipo name", "company", "ipo"] },
  { field: "gmp",     keys: ["ipo gmp", "gmp", "premium"] },
  { field: "price",   keys: ["price band", "ipo price", "issue price", "price"] },
  { field: "listing", keys: ["est. listing", "est listing", "estimated listing", "listing price", "listing gain", "listing"] },
  { field: "date",    keys: ["date", "open", "close"] },
  { field: "type",    keys: ["type", "board", "exchange"] },
  { field: "status",  keys: ["status", "stage"] },
  { field: "updated", keys: ["last updated", "updated"] },
];

// ---------------- helpers ----------------
const esc = (s = "") =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const clean = (s = "") => String(s ?? "").replace(/\s+/g, " ").trim();

function parseGmpNumber(raw) {
  const s = clean(raw);
  if (s === "") return { n: NaN, blank: false };
  if (/^₹?\s*[-–—]\s*$/.test(s)) return { n: NaN, blank: true };
  const norm = s.replace(/[,₹\s]/g, "").replace(/[^\d.\-+]/g, "");
  if (norm === "" || norm === "-" || norm === "+") return { n: NaN, blank: false };
  const n = Number(norm);
  return Number.isFinite(n) ? { n, blank: false } : { n: NaN, blank: false };
}

function normalizeStatus(raw) {
  const s = clean(raw).toLowerCase();
  if (!s) return "";
  if (s.includes("upcom")) return "upcoming";
  if (s.includes("open") || s.includes("active") || s.includes("live") || s.includes("current")) return "active";
  if (s.includes("clos") || s.includes("list") || s.includes("allot")) return "closed";
  return "";
}

function normalizeType(raw) {
  const s = clean(raw).toLowerCase();
  if (!s) return "";
  if (s.includes("sme")) return "SME";
  if (s.includes("main")) return "Mainboard";
  return "";
}

function slugify(name) {
  return clean(name).toLowerCase()
    .replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-").replace(/^-|-$/g, "");
}

// ---------------- alias resolution ----------------
// SEBI calls a company "Iberia Pharmaceuticals India Limited"; ipowatch may
// call it "Iberia Pharma". Left alone, that creates TWO pages for one company
// and throws away the URL age the DRHP-first strategy exists to build.
//
// data/ipo_aliases.json maps a normalised name key -> canonical slug:
//   { "iberia pharmaceuticals india": "iberia-pharmaceuticals-india",
//     "iberia pharma":                "iberia-pharmaceuticals-india" }
//
// Agent 2 writes the DRHP-name key when it creates a page. You add the
// ipowatch variant by hand when this script warns about a near-duplicate.
const ALIAS_FILE = "data/ipo_aliases.json";

// Strip the noise that differs between sources but never identifies a company.
function normalizeKey(name) {
  return clean(name).toLowerCase()
    .replace(/[.,'’&()]/g, " ")
    .replace(/\b(private|pvt|limited|ltd|company|co|corporation|corp|industries|enterprises|the)\b/g, " ")
    .replace(/\bipo\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function loadAliases() {
  try {
    const raw = JSON.parse(await fs.readFile(ALIAS_FILE, "utf8"));
    const map = {};
    for (const [k, v] of Object.entries(raw)) map[normalizeKey(k)] = v;
    return map;
  } catch { return {}; }
}

function resolveSlug(name, aliases) {
  const hit = aliases[normalizeKey(name)];
  return hit || slugify(name);
}

// Shared name matcher. Sources shorten names ("NSE" vs "National Stock
// Exchange of India Limited"), so a single technique is not enough:
//   - exact normalised key
//   - containment either way
//   - acronym / initials
//   - token overlap
// Returns {score, how}. Used for duplicate detection AND the NSE authority
// check, so both stay consistent.
function nameMatch(a, b) {
  const ka = normalizeKey(a), kb = normalizeKey(b);
  if (!ka || !kb) return { score: 0, how: "" };
  if (ka === kb) return { score: 1, how: "exact" };

  if (ka.length > 6 && kb.length > 6 && (ka.includes(kb) || kb.includes(ka))) {
    return { score: 0.95, how: "containment" };
  }

  // acronym: "nse" vs "national stock exchange india"
  const initials = (k) => k.split(" ").filter(Boolean).map(w => w[0]).join("");
  const shortSide = ka.length <= 6 && !ka.includes(" ") ? ka
                  : kb.length <= 6 && !kb.includes(" ") ? kb : null;
  if (shortSide) {
    const other = shortSide === ka ? kb : ka;
    const ini = initials(other);
    if (ini.length >= 2 && (ini.startsWith(shortSide) || shortSide.startsWith(ini.slice(0, Math.max(2, shortSide.length))))) {
      return { score: 0.9, how: "acronym" };
    }
  }

  const ta = new Set(ka.split(" ").filter(w => w.length > 2));
  const tb = new Set(kb.split(" ").filter(w => w.length > 2));
  if (!ta.size || !tb.size) return { score: 0, how: "" };
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  let score = shared / Math.min(ta.size, tb.size);
  // Guard: a single shared token against a much longer name is weak evidence.
  // "NSE" vs "Nse Infra Projects" would otherwise score 1.00 and merge two
  // unrelated companies. Cap it below every decision threshold.
  if (Math.min(ta.size, tb.size) === 1) {
    score = Math.min(score, 0.55);
  }
  return { score, how: score ? "tokens" : "" };
}

function similarity(a, b) { return nameMatch(a, b).score; }

// ---- date -> status ----
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

function computeStatusFromDate(text) {
  const raw = clean(text);
  if (!raw || /tba|announc|n\/a/i.test(raw)) return "upcoming";
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

  if (!start && !end) return "upcoming";
  if (!start) start = end;
  if (!end) end = start;

  const s = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 10, 0);
  const e = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 17, 0); // closes 5:00 PM IST
  if (nowIST < s) return "upcoming";
  if (nowIST <= e) return "active";
  return "closed";
}

// ---------------- fetch ----------------
async function fetchHtml(url, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, "Accept": "text/html,*/*" },
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      console.log(`  fetch attempt ${i}/${attempts} failed: ${e.message}`);
      if (i < attempts) await new Promise(r => setTimeout(r, 1500 * i));
    }
  }
  throw new Error(`fetch failed after ${attempts} attempts: ${url}`);
}

// ---------------- header-mapped parsing ----------------
function mapHeaders(headerTexts) {
  const map = {};
  headerTexts.forEach((h, idx) => {
    const hl = h.toLowerCase();
    for (const { field, keys } of HEADER_MAP) {
      if (map[field] !== undefined) continue;
      if (keys.some(k => hl.includes(k))) { map[field] = idx; break; }
    }
  });
  return map;
}

function scoreTable($, $t) {
  const first = $t.find("tr").first();
  const cells = first.find("th").length ? first.find("th") : first.find("td");
  const headers = [];
  cells.each((_, c) => headers.push(clean($(c).text())));
  const map = mapHeaders(headers);
  const ok = map.ipo !== undefined && map.gmp !== undefined;
  const score = Object.keys(map).length;
  return { ok, map, headers, score, rows: $t.find("tr").length };
}

function parseSourceHtml(html) {
  const $ = load(html);

  // Inventory every table so a layout change is visible in the log.
  const cands = [];
  $("table").each((idx, t) => {
    const $t = $(t);
    const info = scoreTable($, $t);
    cands.push({ idx, $t, ...info });
  });
  console.log(`  tables on page: ${cands.length}`);
  for (const c of cands) {
    console.log(`    [${c.idx}] rows=${c.rows} score=${c.score} ok=${c.ok} headers=[${c.headers.join(" | ")}]`);
  }

  // A LIVE table needs company + GMP + a date column. History/performance
  // tables lack the date column, which is what keeps them out.
  const live = cands.filter(c => c.ok && c.map.date !== undefined && c.rows > 1);
  if (!live.length) {
    // fall back to the old behaviour: best-scoring table, whatever it is
    const best = cands.filter(c => c.ok && c.rows > 1)
      .sort((a, b) => b.score - a.score || b.rows - a.rows)[0];
    if (!best) throw new Error("no table with recognizable IPO+GMP headers");
    console.log(`  WARNING: no table had a date column; falling back to table [${best.idx}]`);
    return extractRows($, best);
  }

  // MERGE every live table. ipowatch (and others) split Mainboard and SME
  // into separate tables with identical headers — taking only the biggest
  // one silently drops an entire category.
  // Tables are NOT split by type on ipowatch — a single table held both NSE
  // (mainboard) and SME issuers. Type is therefore decided per ROW later,
  // never from which table a row came from.
  const all = [];
  for (const c of live) {
    const rows = extractRows($, c);
    console.log(`  table [${c.idx}] contributed ${rows.length} rows`);
    all.push(...rows);
  }

  // de-dupe by company name, keeping the first occurrence
  const seen = new Set(), out = [];
  for (const r of all) {
    const k = slugify(r.ipo);
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(r);
  }
  console.log(`  merged ${live.length} live table(s) -> ${out.length} unique rows`);
  const withHref = out.filter(r => r.href).slice(0, 4);
  if (withHref.length) {
    console.log(`  sample row links (to confirm a per-row type signal):`);
    for (const r of withHref) console.log(`    ${r.ipo} -> ${r.href}`);
  }
  return out;
}

// ============================================================
// NSE authority: which companies are MAINBOARD, from the exchange itself.
// ipowatch has no Type column and no category headings, so table position is
// the only local signal — and position silently inverted on 20 Sep 2026,
// mislabelling all 31 rows. Position can never be trusted again; this labels
// the tables by their CONTENT instead.
// ============================================================
const NSE_HOME = "https://www.nseindia.com/";
const NSE_REF  = "https://www.nseindia.com/market-data/all-upcoming-issues-ipo";
const NSE_ENDPOINTS = [
  "https://www.nseindia.com/api/all-upcoming-issues?category=ipo",
  "https://www.nseindia.com/api/public-past-issues",
];

// NSE rejects Node's HTTP client at the connection level ("fetch failed"),
// but answers curl from the same runner — proven by the probe workflows.
// So NSE is called through curl, with a cookie jar seeded from the homepage.
const { execFileSync } = require("child_process");

function curl(args) {
  try {
    return execFileSync("curl", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 40000 });
  } catch (e) {
    return (e && e.stdout) ? String(e.stdout) : "";
  }
}

async function nseFetchJson() {
  const jar = "/tmp/nse_cookies.txt";
  const base = ["-s", "-L", "--max-time", "30", "-A", UA, "-H", "Accept-Language: en-US,en;q=0.9"];
  curl([...base, "-c", jar, "-o", "/dev/null", "-H", "Accept: text/html,*/*", NSE_HOME]);

  const names = new Set();
  for (const url of NSE_ENDPOINTS) {
    const label = url.split("/api/")[1];
    const txt = curl([...base, "-b", jar, "-c", jar, "-H", "Accept: application/json, text/plain, */*",
                      "-H", `Referer: ${NSE_REF}`, url]).trim();
    if (!txt || !/^[\[{]/.test(txt)) { console.log(`    NSE ${label}: not JSON (${txt.length} bytes)`); continue; }
    try {
      const data = JSON.parse(txt);
      const arr = Array.isArray(data) ? data : (data.data || []);
      let n = 0;
      for (const row of arr) {
        const nm = row.companyName || row.company || "";
        if (nm) { names.add(normalizeKey(nm)); n++; }
      }
      console.log(`    NSE ${label}: ${n} companies`);
    } catch (e) {
      console.log(`    NSE ${label}: bad JSON (${e.message})`);
    }
  }
  return names;
}

// Fuzzy containment: ipowatch shortens names ("NSE" vs "National Stock
// Exchange of India Limited"), so exact keys alone would miss most matches.
function nseMatches(rowName, nseNames) {
  const k = normalizeKey(rowName);
  if (!k) return false;
  if (nseNames.has(k)) return true;
  for (const n of nseNames) if (nameMatch(rowName, n).score >= 0.75) return true;
  return false;
}

function extractRows($, c) {
  const rows = [];
  c.$t.find("tr").slice(1).each((_, tr) => {
    const tds = $(tr).find("td");
    if (!tds.length) return;
    const cell = i => (i === undefined || i >= tds.length) ? "" : clean($(tds[i]).text());
    const m = c.map;
    const href = (m.ipo !== undefined && tds[m.ipo]) ? ($(tds[m.ipo]).find("a").attr("href") || "") : "";
    rows.push({
      ipo: cell(m.ipo), gmpRaw: cell(m.gmp), price: cell(m.price),
      listing: cell(m.listing), date: cell(m.date), type: cell(m.type),
      status: cell(m.status), updated: cell(m.updated), href,
    });
  });
  return rows;
}

// ---------------- validation ----------------
// Per-row type, in order of authority:
//   1. an explicit Type column, if the source has one
//   2. NSE's mainboard list — authoritative when it loaded
//   3. "sme" in the row's own link URL (secondary signal)
//   4. Unknown — never a positional guess
function resolveRowType(r) {
  const col = normalizeType(r.type);
  if (col) return col;
  if (NSE_NAMES && NSE_NAMES.size) return nseMatches(r.ipo, NSE_NAMES) ? "Mainboard" : "SME";
  if (r.href && /(^|[\/_-])sme([\/_.-]|$)/i.test(r.href)) return "SME";
  return "Unknown";
}


function validateAndNormalize(rawRows, sourceName) {
  const out = [];
  let considered = 0;
  for (const r of rawRows) {
    if (!r.ipo) continue;
    considered++;
    const { n, blank } = parseGmpNumber(r.gmpRaw);
    if (isNaN(n) && !blank) { console.log(`  drop (bad GMP "${r.gmpRaw}"): ${r.ipo}`); continue; }
    const dateStatus = computeStatusFromDate(r.date);
    const hasParsableDate = r.date && !/tba|announc|n\/a/i.test(r.date);
    const status = hasParsableDate ? dateStatus : (normalizeStatus(r.status) || dateStatus);
    out.push({
      ipo: clean(r.ipo).replace(/\s+ipo$/i, ""),
      gmp: blank ? null : n,
      gmpRaw: clean(r.gmpRaw),
      price: clean(r.price),
      listing: clean(r.listing),
      date: clean(r.date),
      type: resolveRowType(r),
      status,
    });
  }
  if (considered === 0) throw new Error(`${sourceName}: 0 data rows`);
  if (out.length < MIN_ROWS) throw new Error(`${sourceName}: only ${out.length} valid rows (< ${MIN_ROWS})`);
  if (out.length / considered < MIN_VALID_RATIO)
    throw new Error(`${sourceName}: valid ratio ${(out.length / considered).toFixed(2)} < ${MIN_VALID_RATIO}`);
  const seen = new Set(), dedup = [];
  for (const r of out) {
    const k = slugify(r.ipo);
    if (seen.has(k)) continue;
    seen.add(k); dedup.push(r);
  }

  // Same company appearing twice under different name forms in ONE run
  // (e.g. "NSE" in one table, "National Stock Exchange of India" in another).
  // Reported, never auto-merged: a wrong merge would delete a real company.
  for (let i = 0; i < dedup.length; i++) {
    for (let j = i + 1; j < dedup.length; j++) {
      const m = nameMatch(dedup[i].ipo, dedup[j].ipo);
      if (m.score >= 0.8) {
        console.log(`  POSSIBLE DUPLICATE IN THIS RUN (${m.how}, ${m.score.toFixed(2)}): "${dedup[i].ipo}" and "${dedup[j].ipo}"`);
        console.log(`    Both will get their own card and page. If they are the same company, add to ${ALIAS_FILE}:`);
        console.log(`      ${JSON.stringify(dedup[j].ipo)}: ${JSON.stringify(slugify(dedup[i].ipo))}`);
      }
    }
  }

  // Type-skew guard. If essentially every row lands in one bucket, the Type
  // column probably was not read and normalizeType fell through to its
  // default — which is exactly how "no Mainboard IPOs exist" happens.
  const sme = dedup.filter(r => r.type === "SME").length;
  const main = dedup.filter(r => r.type === "Mainboard").length;
  const unk = dedup.filter(r => r.type === "Unknown").length;
  console.log(`  type split: ${main} Mainboard / ${sme} SME${unk ? ` / ${unk} Unknown` : ""}`);
  if (unk) console.log(`  WARNING: ${unk} row(s) have no usable type — they will not appear under the Mainboard or SME filters.`);
  // Post-hoc cross-check: whatever labelled the tables, NSE is the authority.
  // Any row we call SME that the exchange lists as mainboard means the
  // labelling inverted — the exact failure that shipped 31 wrong rows.
  if (NSE_NAMES && NSE_NAMES.size) {
    const wrong = dedup.filter(r => r.type === "SME" && nseMatches(r.ipo, NSE_NAMES));
    if (wrong.length) {
      console.log(`  TYPE MISMATCH: ${wrong.length} row(s) typed SME but present in NSE's mainboard list:`);
      for (const w of wrong) console.log(`    - ${w.ipo}`);
      console.log(`  Table labelling is probably inverted. Do not trust the Mainboard/SME filters until this is fixed.`);
    }
  }
  if (dedup.length >= 5 && unk === 0 && (main === 0 || sme === 0)) {
    console.log(`  WARNING: every row is ${main === 0 ? "SME" : "Mainboard"}. Either the Type column was not parsed, or a whole table was missed. Check the table inventory above.`);
  }
  return dedup;
}

// ---------------- shared render bits ----------------
function gmpLabelAndClass(row) {
  if (row.gmp === null) return { label: "—", cls: "gmp-neutral" };
  if (row.gmp > 0) return { label: `▲ ${row.gmp}`, cls: "gmp-up" };
  if (row.gmp < 0) return { label: `▼ ${Math.abs(row.gmp)}`, cls: "gmp-down" };
  return { label: "0", cls: "gmp-neutral" };
}

const priceOf = r => (r.price && r.price !== "₹-")
  ? (r.price.startsWith("₹") ? r.price : "₹" + r.price)
  : "To be announced";

// ---------------- homepage cards ----------------
function cardHtml(r) {
  const g = gmpLabelAndClass(r);
  const typeAttr = r.type.toLowerCase() === "sme" ? "sme" : "mainboard";
  const slug = r.slug || slugify(r.ipo);
  const price = r.price ? (r.price.startsWith("₹") ? r.price : "₹" + r.price) : "—";
  return `
  <div class="ipo-card" data-status="${r.status}" data-type="${typeAttr}">
    <div class="card-grid">
      <div class="col col-name">
        <div class="ipo-title">${esc(r.ipo)}</div>
        <div class="gmp-row">
          <span class="gmp-label meta-label">GMP</span>
          <span class="meta-value gmp-value ${g.cls}">${esc(g.label)}</span>
        </div>
      </div>
      <div class="col col-status">
        <span class="badge ${r.status}">${r.status[0].toUpperCase() + r.status.slice(1)}</span>
      </div>
      <div class="col col-meta">
        <div class="meta-item-inline">
          <span class="meta-label">Date</span>
          <span class="meta-value">${esc(r.date) || "—"}</span>
        </div>
      </div>
      <div class="col col-link">
        <a class="ipo-link" href="/ipo/${slug}/" rel="noopener" title="Open ${esc(r.ipo)} page">View</a>
      </div>
    </div>
    <div class="card-row-details" aria-hidden="true">
      <div><strong>IPO Price:</strong> ${esc(price)}</div>
      <div style="margin-top:6px;"><strong>Est. Listing:</strong> ${esc(r.listing) || "—"}</div>
      <div style="margin-top:6px;"><strong>Type:</strong> ${esc(r.type) || "—"}</div>
    </div>
  </div>`;
}

function buildWrapper(rows, meta) {
  const groups = { active: [], upcoming: [], closed: [] };
  for (const r of rows) (groups[r.status] || groups.upcoming).push(r);
  const byGmp = (a, b) => {
    if (a.gmp === null && b.gmp === null) return a.ipo.localeCompare(b.ipo);
    if (a.gmp === null) return 1;
    if (b.gmp === null) return -1;
    return b.gmp - a.gmp;
  };
  for (const k of Object.keys(groups)) groups[k] = groups[k].sort(byGmp).slice(0, MAX_PER_GROUP);
  const section = (title, list) =>
    list.length ? `<h3 class="section-heading">${title}</h3>\n${list.map(cardHtml).join("\n")}` : "";

  return `
  <div id="gmp-wrapper">
<div id="gmp-controls" class="sticky-filters">
  <button class="filter-btn active" data-filter="all">All</button>
  <button class="filter-btn" data-filter="active">Active</button>
  <button class="filter-btn" data-filter="upcoming">Upcoming</button>
  <button class="filter-btn" data-filter="closed">Closed</button>
  <span class="filter-sep" aria-hidden="true"></span>
  <button class="filter-btn type-btn active" data-type-filter="all">All Types</button>
  <button class="filter-btn type-btn" data-type-filter="mainboard">Mainboard</button>
  <button class="filter-btn type-btn" data-type-filter="sme">SME</button>
</div>

<div class="gmp-meta-line">
  <div class="updated">Updated automatically every hour</div>
</div>

<div id="gmp-cards">
${section("Active IPOs", groups.active)}
${section("Upcoming IPOs", groups.upcoming)}
${section("Closed / Listed", groups.closed)}
</div>
<div id="load-more-wrap" style="text-align:center;margin-top:12px;"><button id="load-more-btn" class="load-more-btn">Load more</button></div>
    <div style="display:none" id="gmp-meta" data-updated="${meta.updatedIso}" data-source="${esc(meta.source)}"></div>
  </div>`;
}

// ================= IPO PAGE: LIVE ZONE (machine-owned) =================
// Rewritten on every run, on every page, stub or hand-written.
function liveZone(r, payload) {
  const g = gmpLabelAndClass(r);
  const price = priceOf(r);
  const typeAttr = r.type.toLowerCase() === "sme" ? "sme" : "mainboard";
  return `${LIVE_START}
<div class="ipo-card expanded" data-status="${r.status}" data-type="${typeAttr}">
  <div class="card-grid">
    <div class="col col-name">
      <div class="ipo-title">${esc(r.ipo)}</div>
      <div class="gmp-row"><span class="gmp-label meta-label">GMP</span>
      <span class="meta-value gmp-value ${g.cls}">${esc(g.label)}</span></div>
    </div>
    <div class="col col-status"><span class="badge ${r.status}">${r.status[0].toUpperCase() + r.status.slice(1)}</span></div>
    <div class="col col-meta"><div class="meta-item-inline"><span class="meta-label">Date</span><span class="meta-value">${esc(r.date) || "—"}</span></div></div>
    <div class="col col-link"><a class="ipo-link" href="/">All GMPs</a></div>
  </div>
  <div class="card-row-details" aria-hidden="false" style="display:block">
    <div><strong>IPO Price:</strong> ${esc(price)}</div>
    <div style="margin-top:6px;"><strong>Est. Listing:</strong> ${esc(r.listing) || "—"}</div>
    <div style="margin-top:6px;"><strong>Type:</strong> ${esc(r.type)}</div>
  </div>
</div>

<h2>${esc(r.ipo)} IPO GMP Today</h2>
<p>${r.gmp === null
  ? `The grey market premium for the ${esc(r.ipo)} IPO is not being quoted right now. GMP activity usually picks up closer to the IPO opening date — this page updates automatically every hour.`
  : `The current grey market premium (GMP) of the ${esc(r.ipo)} IPO is <strong>₹${r.gmp}</strong>. GMP reflects unofficial demand for the shares before listing and moves with market sentiment and subscription numbers. This figure updates automatically every hour.`}</p>

<h2>Key Details</h2>
<table class="stub-table">
  <tr><th>IPO Name</th><td>${esc(r.ipo)}</td></tr>
  <tr><th>Type</th><td>${esc(r.type)}</td></tr>
  <tr><th>IPO Dates</th><td>${esc(r.date) || "To be announced"}</td></tr>
  <tr><th>Price Band</th><td>${esc(price)}</td></tr>
  <tr><th>GMP Today</th><td>${r.gmp === null ? "Not quoted yet" : "₹" + r.gmp}</td></tr>
  <tr><th>Estimated Listing</th><td>${esc(r.listing) || "—"}</td></tr>
  <tr><th>Status</th><td>${r.status[0].toUpperCase() + r.status.slice(1)}</td></tr>
</table>
<p class="stub-updated">Live data last refreshed: <strong>${esc(payload.updatedLocal)}</strong></p>
${LIVE_END}`;
}

// ================= IPO PAGE: PROSE ZONE (human-owned) =================
// Written ONCE at page creation as a placeholder. Never rewritten afterwards.
function prosePlaceholder(r) {
  return `${PROSE_START}
<div class="coming-soon-note">📝 <strong>Full analysis coming soon</strong> — a detailed review of ${esc(r.ipo)}'s business, financials, objects of the issue, strengths and risks will be published here. The live GMP and key details above update automatically every hour.</div>

<h2>FAQ</h2>
<h3>What is the GMP of ${esc(r.ipo)} IPO today?</h3>
<p>The current GMP is shown in the Key Details table above and refreshes every hour.</p>
<h3>Is ${esc(r.ipo)} a Mainboard or SME IPO?</h3>
<p>${esc(r.ipo)} is a ${esc(r.type)} IPO.</p>
<h3>Does GMP guarantee listing gains?</h3>
<p>No. GMP is an unofficial, unregulated indicator and can change quickly. Always evaluate the company's fundamentals before investing.</p>
${PROSE_END}`;
}

function siteShell({ title, desc, canonical, body, jsonld, stub }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <link rel="canonical" href="${canonical}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:url" content="${canonical}">
  <meta property="og:type" content="article">
  <link rel="stylesheet" href="/static/gmp.css">
  <script type="application/ld+json">${jsonld}</script>
</head>
<body>
${stub ? STUB_MARK + "\n" : ""}<header class="site-header">
  <a class="brand" href="/">LiveGMP<span class="brand-dot">.in</span></a>
  <nav class="site-nav">
    <a href="/">Live GMP</a>
    <a href="/ipo/">IPO Analysis</a>
    <a href="/what-is-gmp.html">What is GMP?</a>
    <a href="/ipo-allotment-status.html">Allotment</a>
  </nav>
</header>
<main class="container" style="max-width:900px;margin:20px auto;padding:16px;">
${body}
</main>
<footer class="site-footer">
  <p>GMP figures are unofficial, informational estimates from grey-market sources. We do not deal in grey market. Investments are subject to market risk — consult a SEBI-registered advisor.</p>
  <p>&copy; LiveGMP.in · <a href="/">Live IPO GMP</a> · <a href="/ipo/">All IPO Pages</a></p>
</footer>
</body>
</html>`;
}

function stubJsonLd(r, url, payload) {
  const faq = {
    "@context": "https://schema.org", "@type": "FAQPage",
    "mainEntity": [
      { "@type": "Question", "name": `What is the GMP of ${r.ipo} IPO today?`,
        "acceptedAnswer": { "@type": "Answer", "text": r.gmp === null
          ? `${r.ipo} IPO GMP is not yet quoted in the grey market.`
          : `${r.ipo} IPO GMP today is ₹${r.gmp}.` } },
      { "@type": "Question", "name": `What are the ${r.ipo} IPO dates?`,
        "acceptedAnswer": { "@type": "Answer", "text": r.date
          ? `${r.ipo} IPO dates: ${r.date}.` : `${r.ipo} IPO dates are yet to be announced.` } },
      { "@type": "Question", "name": `Is ${r.ipo} a Mainboard or SME IPO?`,
        "acceptedAnswer": { "@type": "Answer", "text": `${r.ipo} is a ${r.type} IPO.` } }
    ]
  };
  const article = {
    "@context": "https://schema.org", "@type": "Article",
    "headline": `${r.ipo} IPO GMP Today, Price Band, Dates`,
    "dateModified": payload.updatedIso, "mainEntityOfPage": url,
    "author": { "@type": "Organization", "name": "LiveGMP.in" },
    "publisher": { "@type": "Organization", "name": "LiveGMP.in" }
  };
  return JSON.stringify([article, faq]);
}

function fullStubPage(r, payload) {
  const slug = r.slug || slugify(r.ipo);
  const url = `${SITE}/ipo/${slug}/`;
  const body = `
<nav class="breadcrumbs"><a href="/">Live GMP</a> › <a href="/ipo/">IPO Analysis</a> › ${esc(r.ipo)}</nav>
<h1>${esc(r.ipo)} IPO — GMP Today, Price Band &amp; Dates</h1>

${liveZone(r, payload)}

${prosePlaceholder(r)}
`;
  return siteShell({
    title: `${r.ipo} IPO GMP Today, Price Band, Dates | LiveGMP`,
    desc: `${r.ipo} IPO grey market premium today${r.gmp !== null ? ` is ₹${r.gmp}` : ""}. ${r.type} IPO${r.date ? `, dates ${r.date}` : ""}. Live GMP, price band and listing estimate.`,
    canonical: url,
    jsonld: stubJsonLd(r, url, payload),
    body,
    stub: true,
  });
}

// Splice a fresh LIVE zone into an existing page, leaving everything else alone.
function spliceLiveZone(html, r, payload) {
  const si = html.indexOf(LIVE_START);
  const ei = html.indexOf(LIVE_END);
  if (si === -1 || ei === -1 || ei < si) return null; // no zone -> caller warns
  return html.slice(0, si) + liveZone(r, payload) + html.slice(ei + LIVE_END.length);
}

async function generateStubs(rows, payload) {
  let created = 0, stubRefreshed = 0, liveUpdated = 0, noZone = [];
  for (const r of rows) {
    const slug = r.slug || slugify(r.ipo);
    if (!slug) continue;
    const dir = `ipo/${slug}`;
    const file = `${dir}/index.html`;

    let existing = null;
    try { existing = await fs.readFile(file, "utf8"); } catch {}

    if (!existing) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file, fullStubPage(r, payload), "utf8");
      created++;
      continue;
    }

    if (existing.includes(STUB_MARK)) {
      // still a pure stub: regenerate whole page so title/meta/schema track status
      await fs.writeFile(file, fullStubPage(r, payload), "utf8");
      stubRefreshed++;
      continue;
    }

    // hand-written page: refresh ONLY the live zone, never the prose
    const updated = spliceLiveZone(existing, r, payload);
    if (updated === null) {
      noZone.push(slug);
      continue;
    }
    if (updated !== existing) {
      await fs.writeFile(file, updated, "utf8");
      liveUpdated++;
    }
  }
  console.log(`Pages: ${created} created, ${stubRefreshed} stubs refreshed, ${liveUpdated} live-zones updated on published pages.`);
  if (noZone.length) {
    console.log(`  WARNING: ${noZone.length} published page(s) have no LIVE_START/LIVE_END zone and got no data update:`);
    for (const s of noZone) console.log(`    - ipo/${s}/index.html`);
    console.log(`  Add the markers around the data block to re-enable automatic GMP updates on those pages.`);
  }
}

// ---------------- /ipo/ index + sitemap ----------------
async function listIpoDirs() {
  try {
    const entries = await fs.readdir("ipo", { withFileTypes: true });
    const dirs = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try { await fs.access(`ipo/${e.name}/index.html`); dirs.push(e.name); } catch {}
    }
    return dirs.sort();
  } catch { return []; }
}

async function generateIpoIndex(payload) {
  const dirs = await listIpoDirs();
  const items = [];
  for (const d of dirs) {
    let title = d.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    let isStub = true;
    try {
      const c = await fs.readFile(`ipo/${d}/index.html`, "utf8");
      isStub = c.includes(STUB_MARK);
      const m = c.match(/<title>([^<]+)<\/title>/i);
      if (m) title = m[1].replace(/\s*\|\s*LiveGMP.*/i, "");
    } catch {}
    items.push(`<li><a href="/ipo/${d}/">${esc(title)}</a>${isStub ? ' <span class="tag-stub">GMP page</span>' : ' <span class="tag-analysis">Full analysis</span>'}</li>`);
  }
  const body = `
<h1>IPO Analysis &amp; GMP Pages</h1>
<p>Every IPO we track gets its own page with live GMP, key details and (for selected IPOs) a full analysis. ${items.length} pages and counting.</p>
<ul class="ipo-index-list">
${items.join("\n")}
</ul>
<p>Looking for today's numbers? See the <a href="/">live IPO GMP table</a>.</p>`;
  const page = siteShell({
    title: "IPO Analysis, Reviews & GMP Pages | LiveGMP",
    desc: "Index of all IPO pages on LiveGMP — live grey market premium, key details, dates and full IPO analysis for Mainboard and SME IPOs.",
    canonical: `${SITE}/ipo/`,
    jsonld: JSON.stringify({ "@context": "https://schema.org", "@type": "CollectionPage",
      "name": "IPO Analysis & GMP Pages", "url": `${SITE}/ipo/`, "dateModified": payload.updatedIso }),
    body,
    stub: false,
  });
  await fs.mkdir("ipo", { recursive: true });
  await fs.writeFile("ipo/index.html", page, "utf8");
  console.log(`ipo/index.html regenerated (${items.length} entries).`);
}

async function generateSitemap(payload) {
  const dirs = await listIpoDirs();
  const today = payload.updatedIso.slice(0, 10);
  const staticUrls = [
    { loc: `${SITE}/`, freq: "hourly", pri: "1.0" },
    { loc: `${SITE}/ipo/`, freq: "daily", pri: "0.8" },
    { loc: `${SITE}/what-is-gmp.html`, freq: "monthly", pri: "0.6" },
    { loc: `${SITE}/ipo-allotment-status.html`, freq: "monthly", pri: "0.6" },
  ];
  const urls = staticUrls.map(u =>
    `  <url><loc>${u.loc}</loc><lastmod>${today}</lastmod><changefreq>${u.freq}</changefreq><priority>${u.pri}</priority></url>`)
    .concat(dirs.map(d =>
    `  <url><loc>${SITE}/ipo/${d}/</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.7</priority></url>`));
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>\n`;
  await fs.writeFile("sitemap.xml", xml, "utf8");
  console.log(`sitemap.xml regenerated (${urls.length} URLs).`);
}

// ---------------- main ----------------
(async () => {
  // Pull the exchange's own mainboard list first; used to label scraped tables.
  console.log("Fetching NSE mainboard list (authority for IPO type)…");
  try {
    NSE_NAMES = await nseFetchJson();
    console.log(`  NSE knows ${NSE_NAMES.size} company name(s)`);
  } catch (e) {
    NSE_NAMES = new Set();
    console.log(`  NSE unavailable: ${e.message} — types will come from row links, else Unknown`);
  }

  let rows = null, sourceUsed = null;
  for (const src of SOURCES) {
    try {
      console.log(`Trying source: ${src.name} (${src.url})`);
      const html = await fetchHtml(src.url);
      const raw = parseSourceHtml(html);
      rows = validateAndNormalize(raw, src.name);
      sourceUsed = src.name;
      console.log(`  OK: ${rows.length} valid rows from ${src.name}`);
      break;
    } catch (e) {
      console.log(`  source ${src.name} rejected: ${e.message}`);
    }
  }
  if (!rows) {
    console.error("FATAL: all sources failed validation. Keeping last-good data untouched.");
    process.exit(1);
  }

  // resolve each row to its canonical slug before anything else uses it
  const aliases = await loadAliases();
  const existingDirs = await listIpoDirs();
  const aliasHits = [];
  const suspects = [];
  for (const r of rows) {
    const plain = slugify(r.ipo);
    r.slug = resolveSlug(r.ipo, aliases);
    if (r.slug !== plain) { aliasHits.push(`${r.ipo} -> ${r.slug}`); continue; }
    // no alias: is there an existing page that looks like the same company?
    for (const d of existingDirs) {
      if (d === r.slug) break;                       // exact page already exists
      const m = nameMatch(r.ipo, d.replace(/-/g, " "));
      if (m.score >= 0.6) { suspects.push({ name: r.ipo, slug: plain, existing: d, sim: m.score, how: m.how }); break; }
    }
  }
  if (aliasHits.length) {
    console.log(`Alias map applied to ${aliasHits.length} row(s):`);
    for (const h of aliasHits) console.log(`  ${h}`);
  }
  if (suspects.length) {
    console.log(`POSSIBLE DUPLICATE PAGES — not merged automatically:`);
    for (const s2 of suspects) {
      console.log(`  "${s2.name}" would create ipo/${s2.slug}/ but ipo/${s2.existing}/ already exists (${s2.how}, ${s2.sim.toFixed(2)})`);
    }
    console.log(`  If these are the same company, add to ${ALIAS_FILE}:`);
    for (const s2 of suspects) {
      console.log(`    ${JSON.stringify(s2.name)}: ${JSON.stringify(s2.existing)}`);
    }
  }

  const newData = { source: sourceUsed, rows };
  let oldData = null;
  try { oldData = JSON.parse(await fs.readFile(GMP_JSON, "utf8")); } catch {}
  const stripped = j => JSON.stringify({ source: j.source, rows: j.rows });
  if (oldData && stripped(oldData) === stripped(newData)) {
    console.log("No data change since last run — nothing to write, nothing to deploy.");
    return;
  }

  const html = await fs.readFile(INDEX_HTML, "utf8");
  const re = /<!--\s*GMP_START\s*-->[\s\S]*?<!--\s*GMP_END\s*-->/;
  if (!re.test(html)) {
    console.error(`FATAL: GMP_START/GMP_END markers not found in ${INDEX_HTML}. Aborting without changes.`);
    process.exit(1);
  }

  const now = new Date();
  const payload = {
    updatedIso: now.toISOString(),
    updatedLocal: now.toLocaleString("en-GB", { timeZone: "Asia/Kolkata" }) + " IST",
    source: sourceUsed,
    rows,
  };
  const wrapper = buildWrapper(rows, payload);
  await fs.writeFile(GMP_JSON, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Wrote ${GMP_JSON} (${rows.length} rows, source=${sourceUsed})`);
  await fs.writeFile(INDEX_HTML, html.replace(re, `<!-- GMP_START -->\n${wrapper}\n<!-- GMP_END -->`), "utf8");
  console.log(`Injected ${rows.length}-row wrapper into ${INDEX_HTML}.`);

  await generateStubs(rows, payload);
  await generateIpoIndex(payload);
  await generateSitemap(payload);
  console.log("Done.");
})().catch(err => {
  console.error("FATAL:", err && err.stack ? err.stack : err);
  process.exit(1);
});
