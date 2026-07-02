/**
 * build_gmp.js — LiveGMP single-pipeline builder (v2, no Google Sheets)
 *
 * Flow:  fetch source (tiered) -> parse by HEADER NAME -> validate ->
 *        write gmp.json -> rebuild HTML between GMP_START/GMP_END -> done.
 *
 * Safety rules:
 *  - A row is accepted only if GMP parses as a number or an explicit blank (₹-).
 *  - A source is accepted only if it yields >= MIN_ROWS valid rows.
 *  - If ALL sources fail, the script EXITS NONZERO and touches nothing:
 *    last-good gmp.json + index.html stay live. Stale data can never
 *    overwrite good data.
 *  - If parsed data is identical to committed gmp.json, exit 0 without
 *    writing (=> no commit, no deploy).
 *
 * Requires: cheerio (npm i cheerio). Node 20+ (global fetch).
 */

const fs = require("fs").promises;
const { load } = require("cheerio");

// ---------------- config ----------------
const MAX_PER_GROUP = 10;          // cards per Active/Upcoming/Closed section
const MIN_ROWS = 8;                // reject a source returning fewer valid rows
const MIN_VALID_RATIO = 0.7;       // >=70% of raw rows must validate
const GMP_JSON = "gmp.json";
const INDEX_HTML = "index.html";
const UA = "Mozilla/5.0 (compatible; LiveGMPBot/2.0; +https://livegmp.in)";

// Sources are tried in order; first one passing validation wins.
const SOURCES = [
  { name: "ipowatch",   url: "https://ipowatch.in/ipo-grey-market-premium-latest-ipo-gmp/" },
  { name: "ipowala",    url: "https://ipowala.in/ipo-grey-market-premium-gmp/" },
  { name: "chanakya",   url: "https://chanakyanipothi.com/ipo-gmp-today/" },
];

// Header synonyms -> canonical field. Matching is "header CONTAINS key".
// Order matters: first match wins, so put more specific keys first.
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
  if (s === "" ) return { n: NaN, blank: false };
  // explicit "no GMP" markers: ₹-, -, –, ₹0- etc.
  if (/^₹?\s*[-–—]\s*$/.test(s)) return { n: NaN, blank: true };
  const norm = s.replace(/[,₹\s]/g, "").replace(/[^\d.\-+]/g, "");
  // Only an EXPLICIT dash marker counts as blank. If stripping symbols left
  // nothing but the original wasn't a dash (e.g. "N/A", "junk"), it's invalid.
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

// ---- date parsing (fallback only, when a source has no Status column) ----
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
  m = token.match(/^([A-Za-z]{3,})\s+(\d{1,2})\s*(\d{2,4})?$/); // "July 3"
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
  let start = parseDayMonth(parts[0], year);
  let end = parts.length > 1 ? parseDayMonth(parts[parts.length - 1], year) : start;
  if (!start) return "upcoming";
  if (!end) end = start;
  // "30-2 July": start month missing -> inherit; if start>end day, start is prev month
  if (parts[0].match(/^\d{1,2}$/) && end) {
    start = new Date(end.getFullYear(), end.getMonth(), +parts[0]);
    if (start > end) start = new Date(end.getFullYear(), end.getMonth() - 1, +parts[0]);
  }
  const s = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 10, 0);
  const e = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 16, 30);
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

// ---------------- header-mapped table parsing ----------------
function mapHeaders(headerTexts) {
  const map = {}; // field -> column index
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
  // must at least identify IPO name + GMP columns to be our table
  const ok = map.ipo !== undefined && map.gmp !== undefined;
  // score = how many canonical fields this table's headers expose.
  // The LIVE table (ipo/gmp/price/listing/date/type/status/updated) scores far
  // higher than history tables (ipo/price/gmp/listing) even if history has
  // 10x more rows — so field coverage decides, row count only breaks ties.
  const score = Object.keys(map).length;
  return { ok, map, headers, score, rows: $t.find("tr").length };
}

function parseSourceHtml(html) {
  const $ = load(html);
  let best = null;
  $("table").each((_, t) => {
    const $t = $(t);
    const info = scoreTable($, $t);
    if (!info.ok) return;
    if (!best || info.score > best.score ||
        (info.score === best.score && info.rows > best.rows)) {
      best = { $t, ...info };
    }
  });
  if (!best) throw new Error("no table with recognizable IPO+GMP headers");
  console.log(`  table headers: [${best.headers.join(" | ")}]`);

  const rows = [];
  best.$t.find("tr").slice(1).each((_, tr) => {
    const tds = $(tr).find("td");
    if (!tds.length) return;
    const cell = i => (i === undefined || i >= tds.length) ? "" : clean($(tds[i]).text());
    const m = best.map;
    rows.push({
      ipo: cell(m.ipo),
      gmpRaw: cell(m.gmp),
      price: cell(m.price),
      listing: cell(m.listing),
      date: cell(m.date),
      type: cell(m.type),
      status: cell(m.status),
      updated: cell(m.updated),
    });
  });
  return rows;
}

// ---------------- validation & normalization ----------------
function validateAndNormalize(rawRows, sourceName) {
  const out = [];
  let considered = 0;
  for (const r of rawRows) {
    if (!r.ipo) continue;
    considered++;
    const { n, blank } = parseGmpNumber(r.gmpRaw);
    if (isNaN(n) && !blank) { console.log(`  drop (bad GMP "${r.gmpRaw}"): ${r.ipo}`); continue; }
    const status = normalizeStatus(r.status) || computeStatusFromDate(r.date);
    out.push({
      ipo: clean(r.ipo).replace(/\s+ipo$/i, ""),
      gmp: blank ? null : n,
      gmpRaw: clean(r.gmpRaw),
      price: clean(r.price),
      listing: clean(r.listing),
      date: clean(r.date),
      type: normalizeType(r.type) || "SME", // conservative default; ipowatch always provides it
      status,
    });
  }
  if (considered === 0) throw new Error(`${sourceName}: 0 data rows`);
  if (out.length < MIN_ROWS) throw new Error(`${sourceName}: only ${out.length} valid rows (< ${MIN_ROWS})`);
  if (out.length / considered < MIN_VALID_RATIO)
    throw new Error(`${sourceName}: valid ratio ${(out.length / considered).toFixed(2)} < ${MIN_VALID_RATIO}`);
  // dedupe by normalized name (keeps first occurrence = live table, not history table)
  const seen = new Set(), dedup = [];
  for (const r of out) {
    const k = slugify(r.ipo);
    if (seen.has(k)) continue;
    seen.add(k); dedup.push(r);
  }
  return dedup;
}

// ---------------- HTML generation (matches existing gmp.css / gmp-client.js) ----------------
function gmpLabelAndClass(row) {
  if (row.gmp === null) return { label: "—", cls: "gmp-neutral" };
  if (row.gmp > 0) return { label: `▲ ${row.gmp}`, cls: "gmp-up" };
  if (row.gmp < 0) return { label: `▼ ${Math.abs(row.gmp)}`, cls: "gmp-down" };
  return { label: "0", cls: "gmp-neutral" };
}

function cardHtml(r) {
  const g = gmpLabelAndClass(r);
  const typeAttr = r.type.toLowerCase() === "sme" ? "sme" : "mainboard";
  const slug = slugify(r.ipo);
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
        <a class="ipo-link" href="/ipo/${slug}" rel="noopener" title="Open ${esc(r.ipo)} page">View</a>
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
  <div class="updated">Last updated: <strong id="gmp-last-updated">${esc(meta.updatedLocal)}</strong></div>
  <div class="next-run">Next run: <span id="gmp-next-run">calculating...</span></div>
</div>
<div id="gmp-stale-note" style="display:none;background:#fff3cd;border:1px solid #ffe08a;border-radius:8px;padding:8px 12px;margin-bottom:10px;font-size:13px;color:#664d03;">
  ⚠️ Data may be delayed — last successful update was more than 6 hours ago.
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

// ---------------- per-IPO stub pages, analysis index, sitemap ----------------
const SITE = "https://livegmp.in";
const STUB_MARK = "<!-- AUTO_STUB -->"; // pages carrying this are pipeline-owned

function siteShell({ title, desc, canonical, body, jsonld }) {
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
${STUB_MARK}
<header class="site-header">
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
          : `${r.ipo} IPO GMP today is ₹${r.gmp} (updated ${payload.updatedLocal}).` } },
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

function stubBody(r, payload) {
  const g = gmpLabelAndClass(r);
  const price = r.price && r.price !== "₹-" ? (r.price.startsWith("₹") ? r.price : "₹" + r.price) : "To be announced";
  return `
<nav class="breadcrumbs"><a href="/">Live GMP</a> › <a href="/ipo/">IPO Analysis</a> › ${esc(r.ipo)}</nav>
<h1>${esc(r.ipo)} IPO — GMP Today, Price Band &amp; Dates</h1>
<p class="stub-updated">Last updated: <strong>${esc(payload.updatedLocal)}</strong></p>

<div class="ipo-card expanded" data-status="${r.status}" data-type="${r.type.toLowerCase() === "sme" ? "sme" : "mainboard"}">
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
  ? `The grey market premium for the ${esc(r.ipo)} IPO is not yet being quoted. GMP activity usually starts close to the IPO opening date — check back for live updates.`
  : `The current grey market premium (GMP) of the ${esc(r.ipo)} IPO is <strong>₹${r.gmp}</strong>. GMP reflects unofficial demand for the shares before listing and changes with market sentiment and subscription numbers.`}</p>

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

<div class="coming-soon-note">📝 <strong>Full analysis coming soon</strong> — detailed review of financials, strengths, risks and our take on the ${esc(r.ipo)} IPO will be published here. Meanwhile, track the live GMP on our <a href="/">homepage</a>.</div>

<h2>FAQ</h2>
<h3>What is the GMP of ${esc(r.ipo)} IPO today?</h3>
<p>${r.gmp === null ? "GMP is not yet quoted in the grey market." : `₹${r.gmp}, as of ${esc(payload.updatedLocal)}.`}</p>
<h3>Is ${esc(r.ipo)} a Mainboard or SME IPO?</h3>
<p>${esc(r.ipo)} is a ${esc(r.type)} IPO.</p>
<h3>Does GMP guarantee listing gains?</h3>
<p>No. GMP is an unofficial, unregulated indicator and can change quickly. Always evaluate fundamentals before investing.</p>
`;
}

async function generateStubs(rows, payload) {
  let created = 0, refreshed = 0, skipped = 0;
  for (const r of rows) {
    const slug = slugify(r.ipo);
    if (!slug) continue;
    const dir = `ipo/${slug}`;
    const file = `${dir}/index.html`;
    let existing = null;
    try { existing = await fs.readFile(file, "utf8"); } catch {}
    if (existing && !existing.includes(STUB_MARK)) { skipped++; continue; } // hand-written blog: never touch
    const url = `${SITE}/ipo/${slug}/`;
    const page = siteShell({
      title: `${r.ipo} IPO GMP Today, Price Band, Dates | LiveGMP`,
      desc: `${r.ipo} IPO grey market premium today${r.gmp !== null ? ` is ₹${r.gmp}` : ""}. ${r.type} IPO${r.date ? `, dates ${r.date}` : ""}. Live GMP, price band and listing estimate.`,
      canonical: url,
      jsonld: stubJsonLd(r, url, payload),
      body: stubBody(r, payload),
    });
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, page, "utf8");
    existing ? refreshed++ : created++;
  }
  console.log(`Stubs: ${created} created, ${refreshed} refreshed, ${skipped} hand-written pages left untouched.`);
}

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
  // 1) scrape, tier by tier
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

  // 2) change detection against committed gmp.json (compare data only)
  const newData = { source: sourceUsed, rows };
  let oldData = null;
  try { oldData = JSON.parse(await fs.readFile(GMP_JSON, "utf8")); } catch {}
  const stripped = j => JSON.stringify({ source: j.source, rows: j.rows });
  if (oldData && stripped(oldData) === stripped(newData)) {
    console.log("No data change since last run — nothing to write, nothing to deploy.");
    return; // exit 0, no file writes => auto-commit action commits nothing
  }

  // 3) verify index.html markers BEFORE writing anything, so a broken page
  //    can never end up paired with an updated gmp.json.
  const html = await fs.readFile(INDEX_HTML, "utf8");
  const re = /<!--\s*GMP_START\s*-->[\s\S]*?<!--\s*GMP_END\s*-->/;
  if (!re.test(html)) {
    console.error(`FATAL: GMP_START/GMP_END markers not found in ${INDEX_HTML}. Aborting without changes.`);
    process.exit(1);
  }

  // 4) write gmp.json + index.html together
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

  // 5) per-IPO stub pages (never overwrite hand-written blogs)
  await generateStubs(rows, payload);

  // 6) analysis index + sitemap
  await generateIpoIndex(payload);
  await generateSitemap(payload);
  console.log("Done.");
})().catch(err => {
  console.error("FATAL:", err && err.stack ? err.stack : err);
  process.exit(1);
});
