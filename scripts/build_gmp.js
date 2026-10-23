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
const { fetchInvestorGainRows } = require("./sources/investorgain");

// ---------------- config ----------------
const MAX_PER_GROUP = 15;
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
  // Primary: structured JSON feed (scripts/sources/investorgain.js).
  // ipowatch and the rest stay as fallbacks — independent second opinion.
  { name: "investorgain", fetchRaw: fetchInvestorGainRows },
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
// Inverse of esc(): text read back out of an existing page is already escaped,
// and must be decoded before esc() runs again, or "&amp;" becomes "&amp;amp;".
const unesc = (s = "") =>
  String(s ?? "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

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
// Estimated listing = issue price + GMP, as a rupee figure and a % of price.
//
// Computed here instead of scraped. ipowatch's own "Est. Listing" cell is just
// price + GMP (it matched to the paisa on every sample checked), and it has
// come back empty before — every card showed "—" on 4 Oct. Price and GMP are
// the two cells this pipeline already depends on, so deriving it removes one
// more thing that can silently break.
function estimateListing(priceText, gmp) {
  if (gmp === null || gmp === undefined || !Number.isFinite(gmp)) return "";
  const txt = String(priceText || "").replace(/,/g, "");
  // prefer figures marked as rupees, so "₹85 (1200 shares)" reads 85, not 1200
  let nums = [...txt.matchAll(/(?:₹|Rs\.?)\s*(\d+(?:\.\d+)?)/gi)].map(m => Number(m[1]));
  if (!nums.length) nums = (txt.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  if (!nums.length) return "";
  const price = Math.max(...nums);          // upper band (cap price) when a range
  if (!(price > 0)) return "";
  const est = Math.round((price + gmp) * 100) / 100;
  const pct = (gmp / price) * 100;
  return `₹${est} (${pct.toFixed(2)}%)`;
}

// A scraped value is only worth keeping when it carries a real number.
const usableScrapedListing = (t) => (/\d/.test(t) && !/^₹?\s*[-–—]/.test(t)) ? t : "";


// ipowatch began appending a status letter and the board to the name cell:
//   "EverestIMS Technologies (O) SME", "Vishal Nirmiti (O) Mainboard".
// Left in, those suffixes change every slug and create a duplicate page for
// every IPO. Strip them, and keep the board — it is ipowatch's own label and
// more reliable than anything inferred.
function splitIpoName(raw) {
  // Status words ipowatch has appended to the name cell. Stripped only when
  // a real name remains (3+ characters), so a company genuinely called
  // "Open" or "Listed" could never be reduced to nothing. Names without
  // spaces, like "R.K.Fashion", must still qualify.
  const STATUS_WORDS = /\s+(Upcoming|Open|Opened|Closing\s+Today|Closing|Closed|Close|Listed|Listing|Active|Allotment|Allotted|Withdrawn)$/i;
  let name = clean(raw);
  let type = "";
  // Up to 6 passes: a cell may carry several suffixes at once, e.g.
  // "Acme India Industries (O) SME IPO".
  for (let i = 0; i < 6; i++) {
    let m = name.match(/\s+(SME|Main\s*board)$/i);
    if (m) { type = /sme/i.test(m[1]) ? "SME" : "Mainboard"; name = name.slice(0, m.index).trim(); continue; }
    m = name.match(/\s*\(([A-Za-z]{1,2})\)$/);            // (O) (U) (C) (L) ...
    if (m) { name = name.slice(0, m.index).trim(); continue; }
    m = name.match(STATUS_WORDS);                          // Open / Closed / Upcoming ...
    if (m && name.slice(0, m.index).trim().length >= 3) { name = name.slice(0, m.index).trim(); continue; }
    m = name.match(/\s+ipo$/i);
    if (m) { name = name.slice(0, m.index).trim(); continue; }
    break;
  }
  return { name, type };
}


// ============================================================
// IPO TYPE RESOLUTION — per company, resolved once, cached forever.
//
// ipowatch has no Type column, its two tables mix both types, its URLs carry
// no type marker, and NSE's API is too flaky to be primary. A company's type
// never changes, so it is resolved ONCE and stored in data/ipo_types.json.
//
// Order of authority for an uncached company:
//   1. data/ipo_types.json entry        (includes your manual corrections)
//   2. NSE mainboard list, if it loaded  -> Mainboard
//   3. the company's own ipowatch page   -> "listed at NSE SME / BSE SME" etc.
//   4. Unknown (retried next run)
//
// To correct a wrong type by hand, edit data/ipo_types.json and set
// "source": "manual" — manual entries are never overwritten.
// ============================================================
const TYPES_FILE = "data/ipo_types.json";
const MAX_DETAIL_FETCHES = 40;
// Bump to discard every non-manual verdict produced by an older classifier.
// v3: v2 stripped real Listing At values as boilerplate and discarded correct SME verdicts.
// v2: v1 read a site-wide promo <h1> ("Q-Line Biotech NSE SME IPO review")
//     as each company's heading and cached 34 companies as SME.
const TYPE_CACHE_VERSION = 3;

async function loadTypeCache() {
  let raw = {};
  try { raw = JSON.parse(await fs.readFile(TYPES_FILE, "utf8")); } catch {}
  const kept = {};
  let dropped = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (!v || !v.type) continue;
    if (v.source === "manual" || v.v === TYPE_CACHE_VERSION) kept[k] = v;
    else dropped++;
  }
  if (dropped) console.log(`  type cache: discarded ${dropped} verdict(s) from an older classifier (manual entries kept)`);
  return kept;
}
async function saveTypeCache(cache) {
  await fs.mkdir("data", { recursive: true });
  const sorted = Object.fromEntries(Object.keys(cache).sort().map(k => [k, cache[k]]));
  await fs.writeFile(TYPES_FILE, JSON.stringify(sorted, null, 2) + "\n", "utf8");
}

// Text blocks from a detail page, with obvious chrome removed. Anything that
// survives this but is still site-wide gets removed later by cross-page
// comparison — which is the step that would have caught the promo <h1>.
function pageBlocks(html) {
  const $ = load(html);
  $("header, nav, footer, aside, script, style, noscript, form, iframe, .sidebar, #sidebar, .widget, .menu, .nav, .breadcrumb, .related, .comments, #comments").remove();
  const title = clean($("meta[property='og:title']").attr("content") || $("title").first().text() || "");
  const blocks = [];
  $("h1, h2, h3, h4, p, li, td, th").each((_, el) => {
    const t = clean($(el).text());
    if (t && t.length >= 3 && t.length <= 400) blocks.push(t);
  });
  return { title, blocks };
}

// Exchange values exactly as ipowatch prints them in the Listing At field.
// These are DATA, and legitimately identical across many pages — so they are
// matched before boilerplate stripping and never stripped themselves.
const RE_MAIN_VALUE = /^(?:BSE|NSE)(?:\s*(?:,|&|and)\s*(?:BSE|NSE))*$/i;
const RE_SME_VALUE  = /^(?:(?:NSE|BSE)\s+SME|NSE\s+Emerge|BSE\s+SME\s+platform|SME\s+platform)$/i;

// Strongest signal: a block that is ENTIRELY an exchange value.
function listingValue(blocks) {
  for (const b of blocks) {
    const t = clean(b);
    if (RE_SME_VALUE.test(t))  return { type: "SME", why: `listing value "${t}"` };
    if (RE_MAIN_VALUE.test(t)) return { type: "Mainboard", why: `listing value "${t}"` };
  }
  return null;
}

// Decide from page-UNIQUE text (listing values are handled before this).
function classifyUnique(title, blocks) {
  const body = blocks.join(" \n ");

  // ipowatch's own sentence: "<Company> IPO to list on BSE, NSE on Sep 30"
  const listRe = /(?:\bto\s+list\s+on|listing\s+at|listed\s+(?:on|at)|will\s+(?:be\s+)?list(?:ed)?\s+on|to\s+be\s+listed\s+on|listing\s+on)\s*:?\s*(?:the\s+)?([A-Za-z ,&/]{2,40}?)(?=\s+on\s|\.|,\s*[a-z]|$|\n)/ig;
  let m;
  while ((m = listRe.exec(body))) {
    const seg = m[1];
    if (/\bsme\b|emerge/i.test(seg)) return { type: "SME", why: `listing text "${clean(seg)}"` };
    if (/\b(nse|bse)\b/i.test(seg))  return { type: "Mainboard", why: `listing text "${clean(seg)}"` };
  }
  if (/\bsme\b/i.test(title)) return { type: "SME", why: `page title` };
  return { type: "Unknown", why: "no listing value or listing sentence found" };
}

async function resolveTypes(rows) {
  const cache = await loadTypeCache();
  const stamp = new Date().toISOString().slice(0, 10);
  let fromCache = 0, fromNse = 0;
  const todo = [];

  for (const r of rows) {
    if (r.type && r.type !== "Unknown") continue;
    const key = r.slug || slugify(r.ipo);
    const hit = cache[key];
    if (hit && hit.type && hit.type !== "Unknown") { r.type = hit.type; fromCache++; continue; }
    if (NSE_NAMES && NSE_NAMES.size && nseMatches(r.ipo, NSE_NAMES)) {
      r.type = "Mainboard";
      cache[key] = { name: r.ipo, type: "Mainboard", source: "nse", v: TYPE_CACHE_VERSION, at: stamp };
      fromNse++; continue;
    }
    if (r.href) todo.push({ r, key });
  }

  // PASS 1 — fetch every uncached page first.
  const pages = [];
  for (const t of todo.slice(0, MAX_DETAIL_FETCHES)) {
    try {
      const html = await fetchHtml(t.r.href, 2);
      pages.push({ ...t, ...pageBlocks(html) });
      await new Promise(res => setTimeout(res, 350));
    } catch (e) {
      console.log(`    ${t.r.ipo}: detail page failed (${e.message})`);
    }
  }

  // PASS 2 — any block appearing on many pages is site chrome, not content.
  const freq = new Map();
  for (const p of pages) for (const b of new Set(p.blocks)) freq.set(b, (freq.get(b) || 0) + 1);
  const threshold = Math.max(3, Math.ceil(pages.length * 0.3));
  const boiler = new Set([...freq].filter(([b, n]) => pages.length >= 3 && n >= threshold && b.length >= 25 && !RE_MAIN_VALUE.test(b) && !RE_SME_VALUE.test(b)).map(([b]) => b));
  if (pages.length >= 3) console.log(`  detail pages: ${pages.length} fetched, ${boiler.size} site-wide block(s) stripped (present on ≥${threshold} pages)`);

  // PASS 3 — classify on unique text.
  const verdicts = pages.map(p => {
    const uniq = p.blocks.filter(b => !boiler.has(b));
    const lv = listingValue(p.blocks);            // data values: never stripped
    return { p, uniq, ...(lv || classifyUnique(p.title, uniq)) };
  });

  // GUARD B — every page resolving to one type in a real IPO week is not credible.
  const resolved = verdicts.filter(v => v.type !== "Unknown");
  const types = new Set(resolved.map(v => v.type));
  let cacheable = true;
  if (resolved.length >= 10 && types.size === 1) {
    cacheable = false;
    console.log(`  GUARD: all ${resolved.length} pages resolved to ${[...types][0]} — not credible for a live IPO week. Applied for this run only, NOT cached.`);
  }

  let fromPage = 0, unresolved = 0;
  console.log("  newly classified:");
  for (const v of verdicts) {
    v.p.r.type = v.type;
    console.log(`    ${v.p.r.ipo.padEnd(28)} ${v.type.padEnd(10)} (${v.why})`);
    if (v.type !== "Unknown" && cacheable) {
      cache[v.p.key] = { name: v.p.r.ipo, type: v.type, source: "ipowatch-page", why: v.why, v: TYPE_CACHE_VERSION, at: stamp };
      fromPage++;
    } else if (v.type === "Unknown") unresolved++;
  }

  // Diagnostic: show what unique text looks like, so phrasing can be tuned.
  for (const v of verdicts.filter(x => x.type === "Unknown").slice(0, 2)) {
    const around = v.uniq.filter(b => /list|exchange|nse|bse|sme/i.test(b)).slice(0, 5);
    console.log(`  [diag] ${v.p.r.ipo} — title: "${v.p.title.slice(0, 80)}"`);
    for (const b of around) console.log(`    · ${b.slice(0, 160)}`);
  }

  console.log(`Type resolution: ${fromCache} cached, ${fromNse} via NSE, ${fromPage} via detail page, ${unresolved} unresolved (${pages.length} pages fetched)`);
  await saveTypeCache(cache);
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
      ipo: splitIpoName(r.ipo).name,
      gmp: blank ? null : n,
      gmpRaw: clean(r.gmpRaw),
      price: clean(r.price),
      listing: estimateListing(clean(r.price), blank ? null : n) || usableScrapedListing(clean(r.listing)),
      date: clean(r.date),
      type: normalizeType(r.type) || splitIpoName(r.ipo).type || "Unknown",
      href: r.href || "",
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

// ================= SITE NAV + FOOTER LINKS (data/site_nav.json) =================
// Every page carries its own copy of the header menu. Pipeline-generated stubs
// would pick up a change, but published articles and the hand-written pages
// (homepage, What is GMP, Allotment, 404) never would. So the menu lives in ONE
// file and this script rewrites <nav class="site-nav"> on every page, every run.
//
//   data/site_nav.json
//   { "nav":    [ {"href": "/", "label": "Live GMP"}, ... ],
//     "footer": [ {"href": "/what-is-gmp.html", "label": "What is GMP?"}, ... ] }
//
// "footer" links go in a <p class="footer-links"> at the end of each page's
// footer; the disclaimer text there is never touched. An empty list removes it.
// A broken or missing file leaves every page exactly as it is (logged, never fatal).
const SITE_NAV_FILE = "data/site_nav.json";
const NAV_MAX_ITEMS = 7;

async function loadSiteNav() {
  let raw;
  try { raw = await fs.readFile(SITE_NAV_FILE, "utf8"); } catch { return null; }   // not set up: no-op
  let cfg;
  try { cfg = JSON.parse(raw); } catch (e) {
    console.log(`WARNING: ${SITE_NAV_FILE} is not valid JSON (${e.message}) - menus left unchanged.`);
    return null;
  }
  const ok = (list) => Array.isArray(list) && list.every(x =>
    x && typeof x.label === "string" && x.label.trim() &&
    typeof x.href === "string" && /^(\/|https:\/\/)/.test(x.href));
  const nav = cfg && cfg.nav, footer = (cfg && cfg.footer) || [];
  if (!ok(nav) || !nav.length || nav.length > NAV_MAX_ITEMS || !ok(footer)) {
    console.log(`WARNING: ${SITE_NAV_FILE} needs "nav": 1-${NAV_MAX_ITEMS} items of {"href","label"} ` +
                `(href starting with / or https://) and an optional "footer" list - menus left unchanged.`);
    return null;
  }
  // A menu link to a page that is not in the repo would be a broken link on
  // every page of the site. Refuse the whole file until the page exists.
  const fsync = require("fs");
  const missing = [...nav, ...footer].filter(x => x.href.startsWith("/")).filter(x => {
    const p = x.href.split(/[?#]/)[0].replace(/^\//, "");
    const file = p === "" ? "index.html" : p.endsWith("/") ? p + "index.html" : p;
    return !fsync.existsSync(file);
  });
  if (missing.length) {
    console.log(`WARNING: ${SITE_NAV_FILE} links to page(s) that do not exist yet: ` +
                `${missing.map(x => x.href).join(", ")} - menus left unchanged until they do.`);
    return null;
  }
  return { nav, footer };
}

// The menu every page gets this run. A missing or broken file must never change
// what is live, so the fallback is the menu currently on the homepage (the
// built-in list only if even that cannot be read).
const DEFAULT_NAV = [
  { href: "/", label: "Live GMP" },
  { href: "/ipo/", label: "IPO Analysis" },
  { href: "/what-is-gmp.html", label: "What is GMP?" },
  { href: "/ipo-allotment-status.html", label: "Allotment" },
];
let SITE_NAV = { nav: DEFAULT_NAV, footer: [], fromFile: false };

async function resolveSiteNav() {
  const cfg = await loadSiteNav();
  if (cfg) { SITE_NAV = { ...cfg, fromFile: true }; return; }
  try {
    const home = await fs.readFile(INDEX_HTML, "utf8");
    const links = (block) => [...String(block || "").matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)]
      .map(m => ({ href: unesc(m[1]), label: unesc(m[2]) }));
    const nav = links((home.match(/<nav class="site-nav">([\s\S]*?)<\/nav>/) || [])[1]);
    const footer = links((home.match(/<p class="footer-links">([\s\S]*?)<\/p>/) || [])[1]);
    if (nav.length) SITE_NAV = { nav, footer, fromFile: false };
  } catch {}
}

// The URL a file is served at, to mark the current page's own menu link.
function pagePath(file) {
  if (file === "index.html") return "/";
  if (file.endsWith("/index.html")) return "/" + file.slice(0, -"index.html".length);
  return "/" + file;
}

function navBlock(items, here) {
  const links = items.map(x => {
    const ext = /^https:/.test(x.href) ? ' target="_blank" rel="noopener"' : "";
    const active = x.href === here ? ' class="nav-active"' : "";
    return `    <a href="${esc(x.href)}"${active}${ext}>${esc(x.label)}</a>`;
  });
  return `<nav class="site-nav">\n${links.join("\n")}\n  </nav>`;
}

function footerLinks(items) {
  if (!items.length) return "";
  return `<p class="footer-links">${items.map(x => `<a href="${esc(x.href)}">${esc(x.label)}</a>`).join(" · ")}</p>`;
}

async function applySiteNav() {
  const cfg = SITE_NAV;
  const files = [];
  for (const f of await fs.readdir(".")) if (f.endsWith(".html")) files.push(f);
  files.push("ipo/index.html");
  for (const d of await listIpoDirs()) files.push(`ipo/${d}/index.html`);
  // Any other section folder (e.g. tools/), so new sections get the menu too.
  const SKIP = new Set(["ipo", "data", "docs", "scripts", "static", "node_modules", "deploy"]);
  for (const e of await fs.readdir(".", { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".") || SKIP.has(e.name)) continue;
    for (const f of await fs.readdir(e.name, { withFileTypes: true })) {
      if (f.isFile() && f.name.endsWith(".html")) files.push(`${e.name}/${f.name}`);
      else if (f.isDirectory()) files.push(`${e.name}/${f.name}/index.html`);
    }
  }

  let changed = 0, noNav = [];
  for (const file of files) {
    let html;
    try { html = await fs.readFile(file, "utf8"); } catch { continue; }
    if (!/<nav class="site-nav">[\s\S]*?<\/nav>/.test(html)) { noNav.push(file); continue; }
    let out = html.replace(/<nav class="site-nav">[\s\S]*?<\/nav>/, navBlock(cfg.nav, pagePath(file)));
    // footer links: replace, insert before </footer>, or remove
    const fl = footerLinks(cfg.footer);
    if (/<p class="footer-links">[\s\S]*?<\/p>\n?/.test(out)) {
      out = out.replace(/<p class="footer-links">[\s\S]*?<\/p>\n?/, fl ? fl + "\n" : "");
    } else if (fl) {
      out = out.replace(/(<footer class="site-footer">[\s\S]*?)(<\/footer>)/, `$1  ${fl}\n$2`);
    }
    if (out !== html) { await fs.writeFile(file, out, "utf8"); changed++; }
  }
  if (changed) console.log(`Site nav: menu updated on ${changed} page(s) from ${cfg.fromFile ? SITE_NAV_FILE : "the menu already live on the homepage"}.`);
  if (noNav.length) console.log(`  (no site-nav found, left alone: ${noNav.join(", ")})`);
}

// ================= LATEST ANALYSIS (homepage block) =================
// Article pages that are not in today's GMP table get no homepage card, so
// Google - which crawls the homepage far more often than the sitemap - finds
// them late. This block links the newest articles from the homepage.
//
// "Newest" needs a real publish time. The page head is not reliable for that
// (a converted stub keeps the timestamp of its last stub refresh), so the
// first time this script sees a page as an article it records the time in
// data/published.json. With update_gmp.yml also running on merges to ipo/,
// that is within minutes of the merge.
const PUBLISHED_FILE = "data/published.json";
const LATEST_COUNT = 8;

async function updatePublished(nowIso) {
  let store = null;
  try { store = JSON.parse(await fs.readFile(PUBLISHED_FILE, "utf8")); } catch {}
  const seeding = store === null;          // first run: no file yet
  store = store || {};
  const before = JSON.stringify(store);
  const seen = new Set();

  for (const d of await listIpoDirs()) {
    let html = "";
    try { html = await fs.readFile(`ipo/${d}/index.html`, "utf8"); } catch { continue; }
    if (html.includes(STUB_MARK)) continue;                 // still a stub
    seen.add(d);
    const crumb = html.match(/›\s*([^<]+?)\s*<\/nav>/);
    const title = html.match(/<title>([^<]+)<\/title>/i);
    const name = crumb ? unesc(crumb[1])
      : title ? unesc(title[1]).replace(/\s*\|\s*LiveGMP.*/i, "").replace(/\s+IPO\b.*$/i, "")
      : d.replace(/-/g, " ");
    // Fingerprint of the human-owned article text only. Live GMP, FAQ and menu
    // changes never count; a regenerated or hand-edited article does.
    const pz = html.match(/<!-- PROSE_START -->([\s\S]*?)<!-- PROSE_END -->/);
    const ph = pz ? require("crypto").createHash("sha1").update(pz[1].replace(/\s+/g, " ").trim()).digest("hex").slice(0, 12) : "";
    if (store[d] && ph) {
      if (!store[d].h) store[d].h = ph;                    // first sight: record, don't bump
      else if (store[d].h !== ph) {                        // article text changed: resurface
        store[d] = { ...store[d], at: nowIso, h: ph, updated: true };
        console.log(`  article updated: ipo/${d}/ - moved to the top of Latest Analysis`);
      }
    }
    if (!store[d]) {
      let at = nowIso;
      if (seeding) {                     // best available date for pages that predate the file
        const m = html.match(/"@type":"Article"[^}]*?"dateModified":"([^"]+)"/);
        if (m && !isNaN(Date.parse(m[1]))) at = m[1];
      }
      store[d] = ph ? { at, name, h: ph } : { at, name };
    } else if (store[d].name !== name) {
      store[d].name = name;              // keep the date, follow a renamed company
    }
  }
  for (const d of Object.keys(store)) if (!seen.has(d)) delete store[d];   // page removed

  const sorted = Object.fromEntries(Object.entries(store).sort(([a], [b]) => a.localeCompare(b)));
  if (JSON.stringify(sorted) !== before) {
    await fs.mkdir("data", { recursive: true });
    await fs.writeFile(PUBLISHED_FILE, JSON.stringify(sorted, null, 2) + "\n", "utf8");
    console.log(`${PUBLISHED_FILE}: ${Object.keys(sorted).length} article page(s) recorded${seeding ? " (first run: seeded from page dates)" : ""}.`);
  }
  return sorted;
}

function latestAnalysisHtml(store) {
  const items = Object.entries(store || {})
    .sort(([sa, a], [sb, b]) => (b.at || "").localeCompare(a.at || "") || sa.localeCompare(sb))
    .slice(0, LATEST_COUNT);
  if (!items.length) return "";
  const day = (iso) => new Date(iso).toLocaleDateString("en-GB",
    { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
  return `
<section id="latest-analysis" style="margin-top:28px;">
<h3 class="section-heading">Latest IPO Analysis</h3>
<ul class="ipo-index-list">
${items.map(([slug, v]) => `<li><a href="/ipo/${slug}/">${esc(v.name)} IPO — business, financials &amp; risks</a> <span class="tag-analysis">${v.updated ? "Updated " : ""}${esc(day(v.at))}</span></li>`).join("\n")}
</ul>
<p><a href="/ipo/">All IPO analysis pages →</a></p>
</section>`;
}

function buildWrapper(rows, meta, latestHtml = "") {
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
${latestHtml}
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

${faqHtml(r)}
${LIVE_END}`;
}

// ================= IPO PAGE: PROSE ZONE (human-owned) =================
// Written ONCE at page creation as a placeholder. Never rewritten afterwards.
function prosePlaceholder(r) {
  return `${PROSE_START}
<div class="coming-soon-note">📝 <strong>Full analysis coming soon</strong> — a detailed review of ${esc(r.ipo)}'s business, financials, objects of the issue, strengths and risks will be published here. The live GMP and key details above update automatically every hour.</div>

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
  <link rel="icon" type="image/png" href="/favicon-96x96.png" sizes="96x96">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="shortcut icon" href="/favicon.ico">
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
  <link rel="manifest" href="/site.webmanifest">
  <link rel="stylesheet" href="/static/gmp.css">
  <script type="application/ld+json">${jsonld}</script>
</head>
<body>
${stub ? STUB_MARK + "\n" : ""}<header class="site-header">
  <a class="brand" href="/">LiveGMP<span class="brand-dot">.in</span></a>
  ${navBlock(SITE_NAV.nav, String(canonical).replace(SITE, "") || "/")}
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

// ================= FAQ (one source for visible text AND schema) =================
// Google requires FAQPage structured data to match text visible on the page.
// The FAQ lives in the LIVE zone, so it is rewritten every run on every page
// (stub or published) and can never drift from the schema in the head.
function faqItems(r) {
  return [
    { q: `What is the GMP of ${r.ipo} IPO today?`,
      a: r.gmp === null
        ? `${r.ipo} IPO GMP is not yet quoted in the grey market.`
        : `${r.ipo} IPO GMP today is ₹${r.gmp}.` },
    { q: `What are the ${r.ipo} IPO dates?`,
      a: r.date ? `${r.ipo} IPO dates: ${r.date}.` : `${r.ipo} IPO dates are yet to be announced.` },
    { q: `Is ${r.ipo} a Mainboard or SME IPO?`,
      a: `${r.ipo} is a ${r.type} IPO.` },
    { q: `Does GMP guarantee listing gains?`,
      a: `No. GMP is an unofficial, unregulated indicator and can change quickly. Always evaluate the company's fundamentals before investing.` },
  ];
}

function faqSchema(r) {
  return {
    "@context": "https://schema.org", "@type": "FAQPage",
    "mainEntity": faqItems(r).map(({ q, a }) => ({
      "@type": "Question", "name": q, "acceptedAnswer": { "@type": "Answer", "text": a },
    })),
  };
}

function faqHtml(r) {
  return `<h2>FAQ</h2>\n` + faqItems(r).map(({ q, a }) => `<h3>${esc(q)}</h3>\n<p>${esc(a)}</p>`).join("\n");
}

// Auto-generated meta description. Stubs use it; published pages keep it
// refreshed only while it is still this auto text (a hand-written one is left alone).
const AUTO_DESC_RE = /^.+ IPO grey market premium today\b/;
function stubDesc(r) {
  return `${r.ipo} IPO grey market premium today${r.gmp !== null ? ` is ₹${r.gmp}` : ""}. ${r.type} IPO${r.date ? `, dates ${r.date}` : ""}. Live GMP, price band and listing estimate.`;
}

// Published pages: the head was written once (at stub stage or by Agent 2) and
// never touched again, so its FAQ schema and meta description froze with an
// old GMP. Refresh ONLY those two machine-generated parts. Title, canonical,
// Article schema and the prose zone stay exactly as they are.
function refreshPublishedHead(html, r) {
  let out = html;
  out = out.replace(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/, (whole, json) => {
    let data;
    try { data = JSON.parse(json); } catch { return whole; }        // unparseable: leave alone
    const list = (Array.isArray(data) ? data : [data]).filter(x => x && x["@type"] !== "FAQPage");
    list.push(faqSchema(r));
    return `<script type="application/ld+json">${JSON.stringify(list)}</script>`;
  });
  const fresh = esc(stubDesc(r));
  out = out.replace(/(<meta (?:name="description"|property="og:description") content=")([^"]*)(">)/g,
    (whole, a, cur, b) => (AUTO_DESC_RE.test(cur) ? a + fresh + b : whole));
  return out;
}

function stubJsonLd(r, url, payload) {
  const faq = faqSchema(r);
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
    desc: stubDesc(r),
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
    let updated = spliceLiveZone(existing, r, payload);
    if (updated === null) {
      noZone.push(slug);
      continue;
    }
    updated = refreshPublishedHead(updated, r);
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
      if (m) title = unesc(m[1]).replace(/\s*\|\s*LiveGMP.*/i, "");
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

// Per-page lastmod, driven by content hashes.
//
// The old version stamped today's date on EVERY url on EVERY run, so the
// sitemap claimed all 150+ pages changed daily. Search engines treat a
// lastmod that is always "today" as untrustworthy and start ignoring it —
// which throws away the one signal the sitemap is there to provide.
//
// Now a page's date only moves when its bytes actually change.
const LASTMOD_FILE = "data/page_lastmod.json";

// Hash MEANINGFUL content only. Every page carries a "Live data last
// refreshed" stamp and a data-updated attribute that change on every run, so
// hashing raw bytes would mark all 150 pages as modified every time — the
// exact problem this is meant to solve.
// Hash as used before the shared menu existed. Kept so the first run after this
// change re-keys data/page_lastmod.json without bumping every page's lastmod.
function legacyNormaliseForHash(text) {
  return String(text)
    .replace(/<p class="stub-updated">[\s\S]*?<\/p>/g, "")
    .replace(/data-updated="[^"]*"/g, "")
    .replace(/"dateModified"\s*:\s*"[^"]*"/g, "")
    .replace(/\d{2}\/\d{2}\/\d{4},\s*\d{2}:\d{2}:\d{2}\s*IST/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normaliseForHash(text) {
  return String(text)
    .replace(/<nav class="site-nav">[\s\S]*?<\/nav>/g, "")         // site menu (same on every page)
    .replace(/<p class="footer-links">[\s\S]*?<\/p>/g, "")         // footer menu
    .replace(/<p class="stub-updated">[\s\S]*?<\/p>/g, "")      // "Live data last refreshed: ..."
    .replace(/data-updated="[^"]*"/g, "")                         // hidden meta attribute
    .replace(/"dateModified"\s*:\s*"[^"]*"/g, "")                // JSON-LD timestamp
    .replace(/\d{2}\/\d{2}\/\d{4},\s*\d{2}:\d{2}:\d{2}\s*IST/g, "") // any IST stamp
    .replace(/\s+/g, " ")
    .trim();
}

function hashOf(text) {
  return require("crypto").createHash("sha1").update(normaliseForHash(text)).digest("hex").slice(0, 16);
}

async function generateSitemap(payload) {
  const dirs = await listIpoDirs();
  const today = payload.updatedIso.slice(0, 10);

  let store = {};
  try { store = JSON.parse(await fs.readFile(LASTMOD_FILE, "utf8")); } catch {}

  // Resolve one file's lastmod: unchanged bytes keep their recorded date.
  async function lastmodFor(file, loc) {
    let text = null;
    try { text = await fs.readFile(file, "utf8"); } catch { return store[loc] ? store[loc].date : today; }
    const h = hashOf(text);
    const prev = store[loc];
    if (prev && prev.hash === h) return prev.date;       // genuinely unchanged
    if (prev && prev.hash === require("crypto").createHash("sha1")
          .update(legacyNormaliseForHash(text)).digest("hex").slice(0, 16)) {
      store[loc] = { hash: h, date: prev.date };          // same page, old hash format: re-key only
      return prev.date;
    }
    store[loc] = { hash: h, date: today };
    return today;
  }

  const entries = [];
  const statics = [
    { file: "index.html",               loc: `${SITE}/`,                          freq: "hourly",  pri: "1.0" },
    { file: "ipo/index.html",           loc: `${SITE}/ipo/`,                      freq: "daily",   pri: "0.8" },
    { file: "what-is-gmp.html",         loc: `${SITE}/what-is-gmp.html`,          freq: "monthly", pri: "0.6" },
    { file: "ipo-allotment-status.html",loc: `${SITE}/ipo-allotment-status.html`, freq: "monthly", pri: "0.6" },
  ];
  for (const u of statics) {
    entries.push({ loc: u.loc, date: await lastmodFor(u.file, u.loc), freq: u.freq, pri: u.pri });
  }
  for (const d of dirs) {
    const loc = `${SITE}/ipo/${d}/`;
    entries.push({ loc, date: await lastmodFor(`ipo/${d}/index.html`, loc), freq: "daily", pri: "0.7" });
  }

  // drop records for pages that no longer exist
  const live = new Set(entries.map(e => e.loc));
  for (const k of Object.keys(store)) if (!live.has(k)) delete store[k];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map(e => `  <url><loc>${e.loc}</loc><lastmod>${e.date}</lastmod><changefreq>${e.freq}</changefreq><priority>${e.pri}</priority></url>`).join("\n")}
</urlset>\n`;
  await fs.writeFile("sitemap.xml", xml, "utf8");

  await fs.mkdir("data", { recursive: true });
  const sorted = Object.fromEntries(Object.keys(store).sort().map(k => [k, store[k]]));
  await fs.writeFile(LASTMOD_FILE, JSON.stringify(sorted, null, 2) + "\n", "utf8");

  const changedToday = entries.filter(e => e.date === today).length;
  console.log(`sitemap.xml regenerated (${entries.length} URLs, ${changedToday} with today's lastmod, ${entries.length - changedToday} unchanged).`);
}


// One-time-safe cleanup: stub pages whose slug carries the polluted suffix
// ("...-o-sme", "...-u-mainboard"). Only AUTO_STUB pages are touched — a page
// holding a merged article is never deleted.
const POLLUTED_SLUG_RE = /-[a-z]{1,2}-(sme|mainboard|main-board)$/;

async function removePollutedStubs() {
  let removed = [];
  let entries = [];
  try { entries = await fs.readdir("ipo", { withFileTypes: true }); } catch { return removed; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!POLLUTED_SLUG_RE.test(e.name)) continue;
    const file = `ipo/${e.name}/index.html`;
    let html = "";
    try { html = await fs.readFile(file, "utf8"); } catch { continue; }
    if (!html.includes(STUB_MARK)) { console.log(`  kept ipo/${e.name}/ — has an article, review by hand`); continue; }
    await fs.rm(`ipo/${e.name}`, { recursive: true, force: true });
    removed.push(e.name);
  }
  if (removed.length) console.log(`Removed ${removed.length} polluted stub page(s): ${removed.join(", ")}`);
  return removed;
}


// ============================================================
// PUBLISHED-URL PROTECTION — a URL that was ever public never returns 404.
//
// Google learns a URL the moment it appears on the homepage, in the sitemap or
// on any deployed page, and keeps re-crawling it for months. Deleting the page
// later - by hand, by removePollutedStubs(), or by renaming a slug - turns that
// into a 404 in Search Console. So:
//
//   data/url_registry.json  every /ipo/<slug>/ this site has ever published
//   _redirects               a block between the AUTO markers is owned by this
//                            script; everything above it is yours, untouched
//
// Every run: a registered slug whose folder is gone and that has no rule of
// yours gets a 301 to the page that replaced it (same name minus a source
// suffix, or a clear name match). If nothing matches, it is reported once and
// left as 404 - the honest answer for a page that has no replacement.
// A folder that comes back gets its auto rule removed, so a redirect can never
// hide a live page.
// ============================================================
const URL_REGISTRY_FILE = "data/url_registry.json";
const REDIRECTS_FILE = "_redirects";
const AUTO_START = "# ---- AUTO: written by build_gmp.js so no published /ipo/ URL ever 404s. Add your own rules ABOVE this line. ----";
const AUTO_END = "# ---- END AUTO ----";
const STATUS_SUFFIX_RE = /-(?:upcoming|open|opened|closing-today|closing|closed|close|listed|listing|active|allotment|allotted|withdrawn)$/;

function redirectTarget(gone, dirs) {
  // 1. same slug without the source's status/board suffix
  let c = gone;
  for (let i = 0; i < 4; i++) {
    const n = c.replace(POLLUTED_SLUG_RE, "").replace(STATUS_SUFFIX_RE, "");
    if (n === c) break;
    c = n;
    if (dirs.has(c)) return { to: c, how: "suffix" };
  }
  // 2. one clear name match among live pages (no near-tie)
  const scored = [];
  for (const d of dirs) {
    const m = nameMatch(c.replace(/-/g, " "), d.replace(/-/g, " "));
    if (m.score >= 0.8) scored.push({ d, score: m.score, how: m.how });
  }
  scored.sort((a, b) => b.score - a.score);
  if (scored.length && (scored.length === 1 || scored[0].score - scored[1].score >= 0.05)) {
    return { to: scored[0].d, how: `${scored[0].how} ${scored[0].score.toFixed(2)}` };
  }
  // 3. a misspelt slug ("vishal-nimriti" for "vishal-nirmiti"): near-identical spelling, one clear winner
  const ratio = (a, b) => {
    const m = a.length, n = b.length;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return 1 - prev[n] / Math.max(m, n);
  };
  const close = [...dirs].map(d => ({ d, r: ratio(c, d) })).filter(x => x.r >= 0.85).sort((a, b) => b.r - a.r);
  if (close.length && (close.length === 1 || close[0].r - close[1].r >= 0.05)) {
    return { to: close[0].d, how: `spelling ${close[0].r.toFixed(2)}` };
  }
  return null;
}

async function protectPublishedUrls(nowIso) {
  const dirs = new Set(await listIpoDirs());
  if (!dirs.size) return;
  const today = nowIso.slice(0, 10);

  let reg = {};
  try { reg = JSON.parse(await fs.readFile(URL_REGISTRY_FILE, "utf8")); } catch {}
  const regBefore = JSON.stringify(reg);
  for (const d of dirs) {
    if (!reg[d]) reg[d] = { first: today };
    else if (reg[d].gone) delete reg[d].gone;           // page is back
  }

  let text = "";
  try { text = await fs.readFile(REDIRECTS_FILE, "utf8"); } catch {}
  const si = text.indexOf(AUTO_START), ei = text.indexOf(AUTO_END);
  const manual = si === -1 ? text : text.slice(0, si) + (ei === -1 ? "" : text.slice(ei + AUTO_END.length));

  // Your rules: which /ipo/ slugs they cover, and sanity checks on them.
  const manualFrom = new Map();
  for (const line of manual.split("\n")) {
    const p = line.trim().split(/\s+/);
    if (p.length < 2 || p[0].startsWith("#")) continue;
    const from = p[0].match(/^\/ipo\/([^/*]+)/), to = p[1].match(/^\/ipo\/([^/]+)\//);
    if (from) manualFrom.set(from[1], to ? to[1] : null);
  }
  for (const [from, to] of manualFrom) {
    if (to === from) continue;                              // "/ipo/x -> /ipo/x/": adds the slash, same page
    if (dirs.has(from)) console.log(`WARNING: _redirects sends /ipo/${from}/ away, but that page exists - visitors and Google never see it. Remove the rule or the folder.`);
    if (to && !dirs.has(to)) console.log(`WARNING: _redirects sends /ipo/${from}/ to /ipo/${to}/, which does not exist - that is a 404 after a redirect.`);
  }

  const auto = [], unresolved = [];
  for (const slug of Object.keys(reg).sort()) {
    if (dirs.has(slug) || manualFrom.has(slug)) continue;
    const t = redirectTarget(slug, dirs);
    if (t) {
      auto.push(`/ipo/${slug}/  /ipo/${t.to}/  301`, `/ipo/${slug}   /ipo/${t.to}/  301`);
      if (!reg[slug].to || reg[slug].to !== t.to) {
        console.log(t.how === "suffix"
          ? `Redirect added: /ipo/${slug}/ -> /ipo/${t.to}/`
          : `WARNING: auto-redirect /ipo/${slug}/ -> /ipo/${t.to}/ by name match (${t.how}) - check it is the same company; override with your own rule in ${REDIRECTS_FILE} if not.`);
      }
      reg[slug].to = t.to; delete reg[slug].gone;
    } else {
      unresolved.push(slug);
      delete reg[slug].to;
      if (!reg[slug].gone) {
        reg[slug].gone = today;
        console.log(`WARNING: /ipo/${slug}/ was published and is now gone, with no matching page - it will 404. If a page replaced it, add a rule to ${REDIRECTS_FILE}.`);
      }
    }
  }

  const block = auto.length || unresolved.length
    ? [AUTO_START, ...auto, ...unresolved.map(s => `# no replacement page, left as 404: /ipo/${s}/`), AUTO_END].join("\n") + "\n"
    : "";
  const next = manual.replace(/\s*$/, "\n") + (block ? "\n" + block : "");
  if (next !== text) {
    await fs.writeFile(REDIRECTS_FILE, next, "utf8");
    console.log(`${REDIRECTS_FILE}: ${auto.length / 2} automatic redirect(s), ${unresolved.length} gone page(s) without a replacement.`);
  }
  const sorted = Object.fromEntries(Object.keys(reg).sort().map(k => [k, reg[k]]));
  if (JSON.stringify(sorted) !== regBefore) {
    await fs.mkdir("data", { recursive: true });
    await fs.writeFile(URL_REGISTRY_FILE, JSON.stringify(sorted, null, 2) + "\n", "utf8");
  }
}

// ============================================================
// PAGE-CREATION GUARD
//
// Creating a page is the one irreversible act in this pipeline: it enters the
// sitemap, gets crawled and dilutes average page quality. Updating an existing
// page is routine and stays automatic. So before anything is written, every
// scraped name is classified against what the repo already knows:
//
//   Approved - has an entry in data/ipo_aliases.json (you vouched for it)
//   Known    - its slug already has a page, or was tracked on the last run
//   Variant  - not known, but closely resembles a known company (suffix,
//              acronym, punctuation). NEVER given a page: held back, alerted.
//   New      - resembles nothing. Allowed, up to a small cap per run.
//
// If one run would create too many pages, hold too many variants, or lose too
// many tracked IPOs, the whole run stops and writes NOTHING; last-good data
// stays live. That is the circuit breaker. The suffix incident (40+ duplicate
// pages in a single hour) would have tripped it on its first run.
//
// Escape hatch for a genuine bumper week: data/guard_override.json
//     { "expires": "2026-10-08", "reason": "6 new SME IPOs" }
// It EXPIRES on that date, so a forgotten override cannot switch the
// safeguard off for good.
// ============================================================
const GUARD_OVERRIDE_FILE = "data/guard_override.json";
const MAX_NEW_PAGES = 8;        // brand-new pages allowed in one run
const MAX_VARIANTS = 4;         // names resembling existing pages, per run
const MAX_VARIANT_SHARE = 0.25; // ...or this share of all rows
const VANISH_MIN = 8;           // tracked IPOs lost in one run ...
const VANISH_SHARE = 0.4;       // ... AND this share of the previous list

async function readOverride() {
  try {
    const o = JSON.parse(await fs.readFile(GUARD_OVERRIDE_FILE, "utf8"));
    const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    if (o && typeof o.expires === "string" && o.expires >= today) {
      return { active: true, expires: o.expires, reason: o.reason || "" };
    }
    return { active: false, expired: o && o.expires ? o.expires : "" };
  } catch { return { active: false }; }
}

async function pageCreationGuard({ rows, aliases, existingDirs, recovered }) {
  let prev = null;
  try { prev = JSON.parse(await fs.readFile(GMP_JSON, "utf8")); } catch {}
  const prevRows = prev && Array.isArray(prev.rows) ? prev.rows : [];

  if (!existingDirs.length && !prevRows.length) {
    console.log("Guard: no existing pages and no previous data (first run) — skipped.");
    return { tripped: false, held: new Set() };
  }

  // What the repo already knows. Previous names are re-normalised, because the
  // last gmp.json may have been written while the source suffix was polluting
  // them — comparing raw slugs would make every IPO look like it vanished.
  const known = new Set(existingDirs);
  for (const d of recovered || []) known.add(d.replace(POLLUTED_SLUG_RE, ""));
  const prevSlugs = new Set();
  for (const p of prevRows) {
    if (!p || !p.ipo) continue;
    const sl = resolveSlug(splitIpoName(p.ipo).name, aliases);
    prevSlugs.add(sl);
    known.add(sl);
  }
  const knownList = [...known];

  const existing = [], approved = [], variants = [], fresh = [];
  for (const r of rows) {
    if (aliases[normalizeKey(r.ipo)]) { approved.push(r); continue; }
    if (known.has(r.slug)) { existing.push(r); continue; }
    let best = null;
    for (const k of knownList) {
      const m = nameMatch(r.ipo, k.replace(/-/g, " "));
      if (m.score >= 0.8 && (!best || m.score > best.score)) best = { slug: k, score: m.score, how: m.how };
    }
    if (best) variants.push({ row: r, ...best }); else fresh.push(r);
  }

  const nowSlugs = new Set(rows.map(r => r.slug));
  const vanished = [...prevSlugs].filter(sl => !nowSlugs.has(sl));

  console.log(`Guard: ${existing.length} known, ${approved.length} approved, ${variants.length} variant(s), ` +
              `${fresh.length} new (limit ${MAX_NEW_PAGES}), ${vanished.length} vanished of ${prevSlugs.size} tracked.`);

  const reasons = [];
  if (fresh.length > MAX_NEW_PAGES)
    reasons.push(`${fresh.length} brand-new pages would be created in one run (limit ${MAX_NEW_PAGES})`);
  if (variants.length > MAX_VARIANTS || (rows.length >= 8 && variants.length / rows.length > MAX_VARIANT_SHARE))
    reasons.push(`${variants.length} of ${rows.length} names look like variants of pages that already exist`);
  if (prevSlugs.size >= 12 && vanished.length >= VANISH_MIN && vanished.length / prevSlugs.size > VANISH_SHARE)
    reasons.push(`${vanished.length} of ${prevSlugs.size} previously tracked IPOs disappeared`);

  let tripped = false;
  if (reasons.length) {
    const ov = await readOverride();
    if (ov.active) {
      console.log(`WARNING: guard override active until ${ov.expires}${ov.reason ? ` (${ov.reason})` : ""} — breaker suppressed: ${reasons.join("; ")}`);
    } else {
      tripped = true;
      console.log("WARNING: CIRCUIT BREAKER TRIPPED — nothing was written; last-good data stays live.");
      for (const why of reasons) console.log(`WARNING:   ${why}`);
      for (const v of variants.slice(0, 3)) console.log(`WARNING:   e.g. "${v.row.ipo}" resembles ipo/${v.slug}/`);
      for (const r of fresh.slice(0, 3)) console.log(`WARNING:   e.g. new: "${r.ipo}"`);
      if (ov.expired) console.log(`WARNING:   (override file expired on ${ov.expired})`);
      console.log(`WARNING:   If this change is real, create ${GUARD_OVERRIDE_FILE} with {"expires":"YYYY-MM-DD","reason":"..."}`);
      return { tripped, held: new Set() };
    }
  }

  // Variants are never given pages. Held back, with the exact alias line.
  const held = new Set(variants.map(v => v.row));
  for (const v of variants) {
    console.log(`WARNING: HELD "${v.row.ipo}" — resembles existing page ipo/${v.slug}/ (${v.how}, ${v.score.toFixed(2)}); no page created.`);
    console.log(`    ${JSON.stringify(v.row.ipo)}: ${JSON.stringify(v.slug)},`);
  }
  if (variants.length) console.log(`WARNING: (a genuinely different company? approve it in ${ALIAS_FILE} with "Name": "<its own slug>")`);
  return { tripped, held };
}

// ---------------- main ----------------
(async () => {
  await resolveSiteNav();
  const recovered = await removePollutedStubs();

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
      console.log(`Trying source: ${src.name} (${src.url || "json feed"})`);
      let raw;
      if (src.fetchRaw) {
        raw = (await src.fetchRaw({ verbose: true })).rows;
      } else {
        raw = parseSourceHtml(await fetchHtml(src.url));
      }
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
  // Safeguard before anything irreversible: classify names, hold variants,
  // and stop the whole run if the change looks like a source-format shift.
  // It runs BEFORE the suspect listing below so that, when the breaker trips,
  // its message is the first thing in the warning output (Telegram only shows
  // the first dozen lines).
  const guard = await pageCreationGuard({ rows, aliases, existingDirs, recovered });
  if (guard.tripped) return;
  const heldNames = new Set([...guard.held].map(r => r.ipo));
  if (guard.held.size) rows = rows.filter(r => !guard.held.has(r));
  const shownSuspects = suspects.filter(x => !heldNames.has(x.name));

  if (aliasHits.length) {
    console.log(`Alias map applied to ${aliasHits.length} row(s):`);
    for (const h of aliasHits) console.log(`  ${h}`);
  }
  if (shownSuspects.length) {
    console.log(`POSSIBLE DUPLICATE PAGES — not merged automatically:`);
    for (const s2 of shownSuspects) {
      console.log(`  "${s2.name}" would create ipo/${s2.slug}/ but ipo/${s2.existing}/ already exists (${s2.how}, ${s2.sim.toFixed(2)})`);
    }
    console.log(`  If these are the same company, add to ${ALIAS_FILE}:`);
    for (const s2 of shownSuspects) {
      console.log(`    ${JSON.stringify(s2.name)}: ${JSON.stringify(s2.existing)}`);
    }
  }

  await resolveTypes(rows);

  // type split + safety net, now that types are final
  {
    const main = rows.filter(r => r.type === "Mainboard").length;
    const sme = rows.filter(r => r.type === "SME").length;
    const unk = rows.filter(r => r.type === "Unknown").length;
    console.log(`Final type split: ${main} Mainboard / ${sme} SME${unk ? ` / ${unk} Unknown` : ""}`);
    if (NSE_NAMES && NSE_NAMES.size) {
      const wrong = rows.filter(r => r.type === "SME" && nseMatches(r.ipo, NSE_NAMES));
      for (const w of wrong) console.log(`  TYPE MISMATCH: "${w.ipo}" is typed SME but NSE lists it as mainboard — correct it in ${TYPES_FILE}`);
    }
  }

  const newData = { source: sourceUsed, rows };
  let oldData = null;
  try { oldData = JSON.parse(await fs.readFile(GMP_JSON, "utf8")); } catch {}
  const stripped = j => JSON.stringify({ source: j.source, rows: j.rows });
  if (oldData && stripped(oldData) === stripped(newData)) {
    console.log("No GMP data change since last run.");
    // The index and sitemap must still be rebuilt: pages published by Agent 2
    // (a merged DRHP article) appear on disk without any GMP value changing,
    // and would otherwise stay out of the sitemap until some unrelated IPO
    // moved. Both are cheap and write only when their content differs.
    const meta = {
      updatedIso: (oldData && oldData.updatedIso) || new Date().toISOString(),
      updatedLocal: (oldData && oldData.updatedLocal) || "",
      source: sourceUsed,
      rows,
    };
    // A merged article changes the homepage's Latest Analysis block even when
    // no GMP value moved. Same rows + same meta = same cards, so index.html is
    // rewritten only when that block actually differs.
    const published = await updatePublished(new Date().toISOString());
    const home = await fs.readFile(INDEX_HTML, "utf8");
    const reHome = /<!--\s*GMP_START\s*-->[\s\S]*?<!--\s*GMP_END\s*-->/;
    if (reHome.test(home)) {
      const next = home.replace(reHome, `<!-- GMP_START -->\n${buildWrapper(rows, meta, latestAnalysisHtml(published))}\n<!-- GMP_END -->`);
      if (next !== home) {
        await fs.writeFile(INDEX_HTML, next, "utf8");
        console.log("Homepage Latest Analysis block updated.");
      }
    }
    await generateIpoIndex(meta);
    await applySiteNav();
    await protectPublishedUrls(new Date().toISOString());
    await generateSitemap(meta);
    console.log("Index and sitemap refreshed; GMP data unchanged.");
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
  const published = await updatePublished(payload.updatedIso);
  const wrapper = buildWrapper(rows, payload, latestAnalysisHtml(published));
  await fs.writeFile(GMP_JSON, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Wrote ${GMP_JSON} (${rows.length} rows, source=${sourceUsed})`);
  await fs.writeFile(INDEX_HTML, html.replace(re, `<!-- GMP_START -->\n${wrapper}\n<!-- GMP_END -->`), "utf8");
  console.log(`Injected ${rows.length}-row wrapper into ${INDEX_HTML}.`);

  await generateStubs(rows, payload);
  await generateIpoIndex(payload);
  await applySiteNav();
  await protectPublishedUrls(payload.updatedIso);
  await generateSitemap(payload);
  console.log("Done.");
})().catch(err => {
  console.error("FATAL:", err && err.stack ? err.stack : err);
  process.exit(1);
});
