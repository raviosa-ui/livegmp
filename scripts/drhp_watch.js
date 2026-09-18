/**
 * drhp_watch.js — LiveGMP Agent 1 (DRHP discovery, READ-ONLY on the site)
 *
 * Watches SEBI's "Draft Offer Documents filed with SEBI" listing for new
 * filings, and writes an issue-ready report for each one.
 *
 * SCOPE NOTE (important):
 *   SEBI's listing covers MAINBOARD filings. SME issuers file their draft
 *   documents with the exchange (NSE Emerge / BSE SME), not with SEBI, so
 *   SME DRHPs will NOT appear here. SME discovery needs a second source.
 *
 * What it does:
 *   1. Fetch SEBI listing page 1 (newest 25 filings).
 *   2. Parse date / title / detail-page URL / document id.
 *   3. Classify: DRHP | UDRHP | ADDENDUM | CORRIGENDUM | OTHER.
 *   4. Diff against data/filings.json (committed state).
 *   5. For each genuinely new filing worth acting on, best-effort download the
 *      main DRHP PDF and extract its TABLE OF CONTENTS so you can reply with
 *      page ranges without opening a 500-page file.
 *   6. Emit reports/ files; the workflow turns each into a GitHub Issue.
 *
 * FIRST RUN SEEDS SILENTLY: with no data/filings.json it records everything
 * as seen and opens zero issues, so you don't get 25 issues at once.
 *
 * Writes only: data/filings.json and reports/*.md . Never touches site files.
 */

const fs = require("fs").promises;
const fss = require("fs");
const path = require("path");
const { load } = require("cheerio");

// ---------------- config ----------------
const LISTING_URL = "https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=3&ssid=15&smid=10";
const STATE_FILE = "data/filings.json";
const REPORT_DIR = "reports";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MAX_ISSUES_PER_RUN = 5;      // flood guard
const TOC_SCAN_PAGES = 12;         // how many leading PDF pages to scan for a ToC
const PDF_MAX_BYTES = 80 * 1024 * 1024;
const SITE = "https://livegmp.in";

const clean = (s = "") => String(s ?? "").replace(/\s+/g, " ").trim();

function slugify(name) {
  return clean(name).toLowerCase()
    .replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-").replace(/^-|-$/g, "");
}

// Strip the document-type suffix to get a company name.
function companyFromTitle(title) {
  let t = clean(title);
  t = t.replace(/\s*[-–—]\s*(second\s+)?(addendum(\s+(i{1,3}|\d+))?|corrigendum|corrigendum to .*|addendum .*|udrhp(-i{1,3}|-\d+)?|drhp|rhp)\s*\.?$/i, "");
  t = t.replace(/\s*[-–—]\s*$/,"");
  // normalise legal suffixes for slug stability
  t = t.replace(/\s+(limited|ltd\.?)$/i, "");
  return clean(t);
}

function classify(title) {
  const t = clean(title).toLowerCase();
  if (/corrigendum/.test(t)) return "CORRIGENDUM";
  if (/addendum/.test(t))    return "ADDENDUM";
  if (/udrhp/.test(t))       return "UDRHP";
  if (/\bdrhp\b/.test(t))    return "DRHP";
  if (/\brhp\b/.test(t))     return "RHP";
  return "OTHER";
}

// ---------------- fetch ----------------
async function fetchText(url, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" },
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      console.log(`  fetch attempt ${i}/${attempts} failed (${url}): ${e.message}`);
      if (i < attempts) await new Promise(r => setTimeout(r, 2000 * i));
    }
  }
  throw new Error(`fetch failed: ${url}`);
}

async function fetchBuffer(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len && len > PDF_MAX_BYTES) throw new Error(`PDF too large (${(len/1048576).toFixed(1)} MB)`);
  const ab = await res.arrayBuffer();
  if (ab.byteLength > PDF_MAX_BYTES) throw new Error("PDF too large");
  return Buffer.from(ab);
}

// ---------------- listing parse ----------------
function parseListing(html) {
  const $ = load(html);
  const out = [];
  $("table tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length < 2) return;
    const dateText = clean($(tds[0]).text());
    if (!/^[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}$/.test(dateText)) return; // "Sep 17, 2026"
    const $a = $(tds[1]).find("a").first();
    const title = clean($a.text());
    let href = $a.attr("href") || "";
    if (!title || !href) return;
    if (href.startsWith("/")) href = "https://www.sebi.gov.in" + href;
    const idm = href.match(/_(\d+)\.html?$/);
    const id = idm ? idm[1] : slugify(title);
    // any direct PDF links in the same cell (usually the abridged prospectus)
    const pdfs = [];
    $(tds[1]).find("a").each((__, a) => {
      const h = $(a).attr("href") || "";
      if (/\.pdf($|\?)/i.test(h)) pdfs.push(h.startsWith("http") ? h : "https://www.sebi.gov.in" + h);
    });
    out.push({ id, date: dateText, title, detailUrl: href, pdfsFromListing: [...new Set(pdfs)] });
  });
  return out;
}

// Find the main document PDF on a filing's detail page.
async function findMainPdf(detailUrl) {
  try {
    const html = await fetchText(detailUrl, 2);
    const $ = load(html);
    const links = [];
    $("a").each((_, a) => {
      let h = $(a).attr("href") || "";
      if (!/\.pdf($|\?)/i.test(h)) return;
      if (h.startsWith("/")) h = "https://www.sebi.gov.in" + h;
      links.push({ url: h, text: clean($(a).text()) });
    });
    if (!links.length) return null;
    // prefer the one that is NOT the abridged prospectus
    const main = links.find(l => !/abridged|_p\.pdf/i.test(l.url + " " + l.text));
    return (main || links[0]).url;
  } catch (e) {
    console.log(`  detail page fetch failed: ${e.message}`);
    return null;
  }
}

// ---------------- PDF table-of-contents extraction (best effort) ----------------
async function extractToc(pdfUrl) {
  let pdfjs;
  try {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch (e) {
    return { ok: false, reason: "pdfjs not available: " + e.message };
  }
  try {
    const buf = await fetchBuffer(pdfUrl);
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buf),
      useSystemFonts: false,
      disableFontFace: true,
      isEvalSupported: false,
    }).promise;

    const total = doc.numPages;
    const scan = Math.min(TOC_SCAN_PAGES, total);
    let tocText = "", tocPage = null;

    for (let p = 1; p <= scan; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const text = tc.items.map(i => i.str).join(" ");
      if (/table\s+of\s+contents/i.test(text) || /^\s*CONTENTS\s*$/im.test(text)) {
        tocPage = p;
        // capture this page and the next two (ToCs often span pages)
        for (let q = p; q <= Math.min(p + 2, total); q++) {
          const pg = await doc.getPage(q);
          const t = await pg.getTextContent();
          tocText += t.items.map(i => i.str).join(" ") + "\n";
        }
        break;
      }
    }
    await doc.destroy();
    if (!tocPage) return { ok: false, reason: `no "Table of Contents" found in first ${scan} pages`, total };
    return { ok: true, tocPage, total, text: tocText };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// Pull "SECTION NAME .... 123" style lines out of raw ToC text.
function tidyToc(raw) {
  const wanted = [
    "definitions", "summary", "risk factors", "the offer", "objects of the offer",
    "objects of the issue", "our business", "industry overview", "financial information",
    "financial statements", "management", "our promoter", "capital structure",
    "basis for offer price", "management's discussion", "restated"
  ];
  const lines = String(raw)
    .replace(/\.{3,}/g, " … ")
    .split(/(?=[A-Z][A-Z\s'’&(),-]{6,})/)
    .map(s => clean(s))
    .filter(Boolean);

  const hits = [];
  for (const line of lines) {
    const m = line.match(/^(.{4,90}?)\s*…?\s*(\d{1,3})\s*$/);
    if (!m) continue;
    const label = clean(m[1]);
    const page = m[2];
    if (wanted.some(w => label.toLowerCase().includes(w))) hits.push(`${label} — p.${page}`);
  }
  return [...new Set(hits)];
}

// ---------------- report ----------------
function reportFor(f, extra) {
  const slug = slugify(f.company);
  const pageUrl = `${SITE}/ipo/${slug}/`;
  let md = `## ${f.company}\n\n`;
  md += `| | |\n|---|---|\n`;
  md += `| **Filing** | ${f.kind} |\n`;
  md += `| **Filed** | ${f.date} |\n`;
  md += `| **SEBI page** | ${f.detailUrl} |\n`;
  md += `| **Proposed slug** | \`${slug}\` → ${pageUrl} |\n`;
  md += `| **Page exists?** | ${extra.pageExists ? "yes — this is an UPDATE to an existing page" : "no — this would be a NEW page"} |\n`;
  if (f.mainPdf)  md += `| **Main document** | ${f.mainPdf} |\n`;
  for (const p of f.pdfsFromListing) md += `| Abridged prospectus | ${p} |\n`;
  md += `\n`;

  if (extra.toc && extra.toc.ok) {
    md += `### Table of contents (found on PDF page ${extra.toc.tocPage} of ${extra.toc.total})\n\n`;
    const tidy = tidyToc(extra.toc.text);
    if (tidy.length) {
      md += tidy.map(t => `- ${t}`).join("\n") + "\n\n";
      md += `<details><summary>raw ToC text</summary>\n\n\`\`\`\n${clean(extra.toc.text).slice(0, 3000)}\n\`\`\`\n</details>\n\n`;
    } else {
      md += `Could not parse clean entries. Raw text:\n\n\`\`\`\n${clean(extra.toc.text).slice(0, 3000)}\n\`\`\`\n\n`;
    }
    md += `> ⚠️ ToC page numbers are the document's own numbering and often differ from the PDF's physical page numbers by a few pages. Verify one section before trusting the offsets.\n\n`;
  } else if (extra.toc) {
    md += `### Table of contents\n\nNot extracted — ${extra.toc.reason}${extra.toc.total ? ` (PDF has ${extra.toc.total} pages)` : ""}. Open the PDF and read its contents page.\n\n`;
  }

  md += `### Next step\n\n`;
  md += `Reply to this issue with the physical PDF page ranges to feed the blog generator, e.g.\n\n`;
  md += `\`\`\`\n/generate 12-18, 96-104, 210-232, 260-268\n\`\`\`\n\n`;
  md += `Useful sections: Summary of the Offer · Objects of the Issue · Our Business · Restated Financial Information · Risk Factors.\n`;
  return { slug, title: `📄 ${f.kind} filed: ${f.company}`, body: md };
}

// ---------------- main ----------------
(async () => {
  // state
  let state = { seen: {}, seededAt: null };
  try {
    state = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
    if (!state.seen) state.seen = {};
  } catch { /* first run */ }
  const firstRun = !state.seededAt;

  console.log("Fetching SEBI draft offer documents listing…");
  const html = await fetchText(LISTING_URL);
  const rows = parseListing(html);
  console.log(`Parsed ${rows.length} filings from listing.`);
  if (!rows.length) {
    console.error("FATAL: no rows parsed — SEBI layout may have changed. State untouched.");
    console.error("--- first 3000 chars of fetched HTML, for diagnosis ---");
    console.error(html.slice(0, 3000));
    console.error("--- table count:", (html.match(/<table/gi) || []).length,
                  "| tr count:", (html.match(/<tr/gi) || []).length, "---");
    process.exit(1);
  }

  for (const r of rows) {
    r.kind = classify(r.title);
    r.company = companyFromTitle(r.title);
  }

  const fresh = rows.filter(r => !state.seen[r.id]);
  console.log(`New since last run: ${fresh.length}`);

  if (firstRun) {
    for (const r of rows) state.seen[r.id] = { date: r.date, title: r.title, kind: r.kind };
    state.seededAt = new Date().toISOString();
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
    console.log(`FIRST RUN: seeded ${rows.length} existing filings as seen. No issues opened.`);
    if (process.env.GITHUB_OUTPUT) {
      await fs.appendFile(process.env.GITHUB_OUTPUT, `count=0\nseeded=true\n`, "utf8");
    }
    return;
  }

  // Which new filings deserve an issue?
  //  - DRHP / UDRHP  -> always (new page candidate)
  //  - ADDENDUM / CORRIGENDUM / RHP -> only if we already have a page for it
  const candidates = [];
  for (const f of fresh) {
    const slug = slugify(f.company);
    let pageExists = false;
    try { await fs.access(`ipo/${slug}/index.html`); pageExists = true; } catch {}
    const worth = (f.kind === "DRHP" || f.kind === "UDRHP") || pageExists;
    if (worth) candidates.push({ f, pageExists });
    else console.log(`  skip (${f.kind}, no existing page): ${f.company}`);
  }

  const take = candidates.slice(0, MAX_ISSUES_PER_RUN);
  if (candidates.length > take.length) {
    console.log(`Flood guard: ${candidates.length} candidates, reporting first ${take.length}.`);
  }

  await fs.mkdir(REPORT_DIR, { recursive: true });
  let written = 0;
  for (const c of take) {
    const { f, pageExists } = c;
    console.log(`Preparing report: ${f.company} (${f.kind})`);
    f.mainPdf = await findMainPdf(f.detailUrl);
    let toc = null;
    if (f.mainPdf) {
      console.log(`  main PDF: ${f.mainPdf}`);
      toc = await extractToc(f.mainPdf);
      console.log(`  ToC: ${toc.ok ? `found on page ${toc.tocPage}/${toc.total}` : "not extracted — " + toc.reason}`);
    }
    const rep = reportFor(f, { pageExists, toc });
    const base = `${REPORT_DIR}/${f.id}-${rep.slug}`;
    await fs.writeFile(`${base}.md`, rep.body, "utf8");
    await fs.writeFile(`${base}.title`, rep.title, "utf8");
    written++;
  }

  // mark everything fresh as seen (including skipped ones, so they don't requeue)
  for (const f of fresh) state.seen[f.id] = { date: f.date, title: f.title, kind: f.kind };
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");

  console.log(`Wrote ${written} report(s) to ${REPORT_DIR}/`);
  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT, `count=${written}\nseeded=false\n`, "utf8");
  }
})().catch(err => {
  console.error("FATAL:", err && err.stack ? err.stack : err);
  process.exit(1);
});
