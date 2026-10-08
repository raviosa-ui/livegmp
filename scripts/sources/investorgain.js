'use strict';
/**
 * InvestorGain feed adapter for livegmp.in
 *
 * SEAM: this module replaces fetchHtml + parseSourceHtml + extractRows ONLY.
 * It returns rows in the exact shape extractRows() produces, so
 * validateAndNormalize(), splitIpoName(), estimateListing(),
 * computeStatusFromDate(), resolveTypes(), resolveSlug() and
 * pageCreationGuard() all run afterwards completely unchanged.
 *
 *   { ipo, gmpRaw, price, listing, date, type, status, updated, href }
 *
 * It does NOT compute status, slugs, est. listing or the final type. Those
 * stay where they are.
 *
 * Endpoint (verified by probe):
 *   webnodejs.investorgain.com/cloud/v2/report/data-read/331/1/{m}/{y}/{fy}/0/all?search=
 *
 * Node 20+ (global fetch). CommonJS. No dependencies.
 */

const BASE = 'https://webnodejs.investorgain.com/cloud/v2/report/data-read/331/1';

const HEADERS = {
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  'referer': 'https://www.investorgain.com/',
};

const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** Strip tags, decode the HTML entities the feed uses (&#8377; is the rupee sign). */
function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&rupee;|&inr;/gi, '₹');
}
const clean = (s) => decodeEntities(String(s ?? '').replace(/<br\s*\/?>/gi, ' | ').replace(/<[^>]*>/g, ' '))
  .replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ fy / url

function fyCandidates(month, year) {
  const start = month >= 4 ? year : year - 1;
  const end = start + 1;
  // [Guessing] exact token format; first one that returns rows wins and sticks.
  return [`${start}-${String(end).slice(2)}`, `${start}-${end}`,
          `${start}${String(end).slice(2)}`, `${start}`];
}

let _fyIdx = null;

async function fetchJson(url, { timeoutMs = 20000, retries = 2 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: HEADERS, signal: ac.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      try { return JSON.parse(text); }
      catch { throw new Error(`non-JSON body: ${text.slice(0, 100).replace(/\s+/g, ' ')}`); }
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (i < retries) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

/** Envelope key is not pinned down; accept the plausible shapes. */
function extractFeedRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const k of ['reportTableData', 'data', 'rows', 'result', 'records']) {
    if (Array.isArray(payload[k])) return payload[k];
  }
  for (const v of Object.values(payload)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
  }
  return [];
}

async function fetchMonth(month, year, opts = {}) {
  const cands = fyCandidates(month, year);
  const order = _fyIdx === null ? cands.map((_, i) => i) : [_fyIdx, ...cands.map((_, i) => i)];
  const tried = new Set();
  for (const i of order) {
    if (tried.has(i)) continue;
    tried.add(i);
    const url = `${BASE}/${month}/${year}/${cands[i]}/0/all?search=`;
    try {
      const rows = extractFeedRows(await fetchJson(url, opts));
      if (rows.length) { _fyIdx = i; return { url, fy: cands[i], rows }; }
    } catch (e) {
      if (opts.verbose) console.log(`    fy=${cands[i]}: ${e.message}`);
    }
  }
  return { url: `${BASE}/${month}/${year}/${cands[0]}/0/all?search=`, fy: cands[0], rows: [] };
}

// ------------------------------------------------------------------ parsing

/**
 * "₹ 40 (47.06%) 13 ↓ / 40 ↑"  ->  { gmp: 40, pct: 47.06 }
 * Only the FIRST rupee amount is current GMP. "13 ↓ / 40 ↑" is movement
 * decoration. "~max_gmp1" is the all-time peak and is never read here.
 */
function parseGmpCell(raw) {
  // The live cell is "&#8377;<b>182</b> (-%)<br><small>…movement…</small>".
  // Everything after the first <br> is decoration; never read numbers from it.
  const s = clean(String(raw ?? '').split(/<br\s*\/?>/i)[0]);
  if (!s || /^(-+|n\/?a)$/i.test(s)) return { gmp: null, pct: null, raw: s };
  let m = s.match(/₹\s*(-?[\d,]+(?:\.\d+)?)/);
  if (!m) m = s.match(/(?:^|[\s(])(-?[\d,]+(?:\.\d+)?)/);
  const gmp = m ? Number(m[1].replace(/,/g, '')) : null;
  const p = s.match(/\(\s*(-?[\d.]+)\s*%\s*\)/);
  const pct = p ? Number(p[1]) : null;
  return {
    gmp: Number.isFinite(gmp) ? gmp : null,
    pct: Number.isFinite(pct) ? pct : null,
    raw: s,
  };
}

function isoToDate(v) {
  const s = clean(v);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Build the display date string that computeStatusFromDate() can re-parse.
 * Verified against that function's own regexes:
 *   same month  -> "13-15 Oct 2026"   (parts: "13", "15 Oct 2026")
 *   cross month -> "29 Oct - 2 Nov 2026"
 *   open only   -> "13 Oct 2026"
 *   neither     -> ""  (-> status "upcoming", same as a TBA cell)
 */
function buildDateText(openD, closeD) {
  const fmt = (d) => `${d.getUTCDate()} ${MONTH_ABBR[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (openD && closeD) {
    if (openD.getUTCMonth() === closeD.getUTCMonth() &&
        openD.getUTCFullYear() === closeD.getUTCFullYear()) {
      return `${openD.getUTCDate()}-${fmt(closeD)}`;
    }
    return `${openD.getUTCDate()} ${MONTH_ABBR[openD.getUTCMonth()]} - ${fmt(closeD)}`;
  }
  if (openD) return fmt(openD);
  if (closeD) return fmt(closeD);
  return '';
}

function parseType(v) {
  const s = clean(v).toUpperCase();
  if (s === 'SME') return 'SME';
  if (s === 'IPO' || s === 'MAINBOARD' || s === 'MAIN') return 'Mainboard';
  return ''; // "" -> validateAndNormalize falls through to the type cache
}

/** Find a price-band field under any of the names the feed might use. */
// "Price (₹)" verified from a live payload (7 Oct 2026). "0" means not priced yet.
const PRICE_KEYS = ['Price (₹)', 'Price (&#8377;)', 'Price', 'Price Band'];
function readPriceField(row) {
  for (const k of PRICE_KEYS) {
    const v = clean(row[k]);
    if (!v || !/\d/.test(v)) continue;
    const nums = (v.replace(/,/g, '').match(/\d+(?:\.\d+)?/g) || []).map(Number);
    if (!nums.length || nums.every((n) => n === 0)) continue;   // "0" = unpriced
    // Hand estimateListing() a rupee-marked value; a band keeps its shape.
    return /₹/.test(v) ? v : `₹${v}`;
  }
  return '';
}

/**
 * [Likely] price fallback. estimateListing() needs a price band; if the feed
 * carries none, recover the cap price from the identity the percentage uses:
 *   pct = gmp / price * 100   ->   price = gmp / (pct/100)
 * Rounded, because pct itself is rounded to 2dp. Returned as "₹<n>" so
 * estimateListing()'s rupee-marked branch picks it up cleanly.
 */
function derivePrice(gmp, pct) {
  if (!Number.isFinite(gmp) || !Number.isFinite(pct) || gmp === 0 || pct === 0) return '';
  const price = (gmp / pct) * 100;
  if (!(price > 0) || !Number.isFinite(price)) return '';
  return `₹${Math.round(price)}`;
}

/** One feed row -> one raw row in extractRows() shape, or null. */
function toRawRow(row) {
  const name = clean(row['~ipo_name']);       // clean name; "Name" is polluted
  if (!name) return null;

  const { gmp, pct: cellPct } = parseGmpCell(row['GMP']);
  const calcPct = Number(clean(row['~gmp_percent_calc']));
  const pct = Number.isFinite(calcPct) && calcPct !== 0 ? calcPct : cellPct;
  const openD = isoToDate(row['~Srt_Open']);
  const closeD = isoToDate(row['~Srt_Close']);

  return {
    ipo: name,
    // "-" is what parseGmpNumber() treats as an explicit blank (keeps the row).
    gmpRaw: gmp === null ? '-' : `₹${gmp}`,
    price: readPriceField(row) || derivePrice(gmp, pct),
    listing: '',                              // estimateListing() computes it
    date: buildDateText(openD, closeD),       // computeStatusFromDate() parses it
    type: parseType(row['~IPO_Category']),
    status: '',                               // date wins; never the source's word
    updated: '',
    href: '',                                 // no ipowatch detail page to classify
  };
}

// --------------------------------------------------------------- freshness

/**
 * "Updated-On" = "<small…><b>7-Oct 23:02</b></small>"  ->  sortable number.
 * Requests seconds apart can hit edge caches hours apart (seen live: 19:02 vs
 * 23:02 in the same run), so duplicates are resolved by this, newest wins.
 * Month rollover: a December stamp seen in January sorts as last year.
 */
function updatedStamp(v, now = new Date()) {
  const m = clean(v).match(/(\d{1,2})-([A-Za-z]{3})\s+(\d{1,2}):(\d{2})/);
  if (!m) return 0;
  const mon = MONTH_ABBR.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
  if (mon < 0) return 0;
  let year = now.getUTCFullYear();
  if (mon > now.getUTCMonth() + 1) year -= 1;
  return Date.UTC(year, mon, +m[1], +m[3], +m[4]);
}

// --------------------------------------------------------------- public API

/**
 * Returns rows in extractRows() shape. Spans the current and next IST month so
 * month-boundary and early-upcoming IPOs are not lost. Dedupe by the numeric
 * id in ~urlrewrite_folder_name, else by lowercased clean name.
 */
async function fetchInvestorGainRows(opts = {}) {
  const { now = new Date(), monthSpan = [0, 1], verbose = false } = opts;

  const ist = new Date(now.getTime() + (5.5 * 60 + now.getTimezoneOffset()) * 60000);
  const baseMonth = ist.getMonth() + 1;
  const baseYear = ist.getFullYear();

  const seen = new Map();
  const meta = { requests: [], rawCount: 0, skipped: 0 };

  for (const off of monthSpan) {
    const d = new Date(Date.UTC(baseYear, baseMonth - 1 + off, 1));
    const month = d.getUTCMonth() + 1;
    const year = d.getUTCFullYear();

    const { url, fy, rows } = await fetchMonth(month, year, { verbose });
    meta.requests.push({ month, year, fy, url, rows: rows.length });
    meta.rawCount += rows.length;
    if (verbose) console.log(`  investorgain ${month}/${year} fy=${fy}: ${rows.length} row(s)`);

    for (const feedRow of rows) {
      const r = toRawRow(feedRow);
      if (!r) { meta.skipped++; continue; }
      const idm = clean(feedRow['~urlrewrite_folder_name']).match(/\/(\d+)\/?$/);
      const key = idm ? `id:${idm[1]}` : `name:${r.ipo.toLowerCase()}`;
      const ts = updatedStamp(feedRow['Updated-On'], now);
      const prev = seen.get(key);
      if (!prev || ts > prev.ts || (ts === prev.ts && prev.r.gmpRaw === '-' && r.gmpRaw !== '-')) {
        seen.set(key, { r, ts });
      }
    }
  }

  const out = [...seen.values()].map((x) => x.r);
  meta.newestUpdate = Math.max(0, ...[...seen.values()].map((x) => x.ts));
  // Let validateAndNormalize() enforce MIN_ROWS; a hard zero is still fatal here
  // so the caller can fall through to the next source.
  if (!out.length) {
    const e = new Error('investorgain: feed returned 0 usable rows');
    e.meta = meta;
    throw e;
  }
  return { rows: out, meta };
}

module.exports = {
  fetchInvestorGainRows,
  fetchMonth,
  toRawRow,
  parseGmpCell,
  buildDateText,
  derivePrice,
  parseType,
  isoToDate,
  updatedStamp,
  fyCandidates,
  extractFeedRows,
  BASE,
};
