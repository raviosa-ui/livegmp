/**
 * generate_blog.js — LiveGMP Agent 2 (DRHP → IPO page prose)
 *
 * Triggered by a `/generate <page ranges>` comment on a DRHP issue opened by
 * Agent 1. Produces a branch + PR. NOTHING is published without your merge.
 *
 * Pipeline:
 *   1. Read the issue body for: company, slug, main PDF URL.
 *   2. Read the comment for physical PDF page ranges: "/generate 12-18, 96-104".
 *   3. Download the PDF, extract text from exactly those pages.
 *   4. Ask a model for a STRICT JSON object against a fixed schema.
 *      Gemini first, then Groq, then OpenRouter.
 *   5. Validate the JSON hard. Reject on missing/placeholder/AI-refusal content.
 *   6. Cross-check every financial figure against the extracted text and flag
 *      any that do not literally appear — surfaced in the PR body for review.
 *   7. Render into the PROSE zone of ipo/<slug>/index.html.
 *      - Page exists  -> replace PROSE zone only; LIVE zone and everything
 *                        else untouched.
 *      - Page missing -> create it with a placeholder LIVE zone, so the hourly
 *                        pipeline fills in GMP/dates later when the company
 *                        appears in gmp.json.
 *   8. Write pr_body.md for the workflow to open the PR with.
 *
 * Never writes gmp.json. Never touches the homepage. Never pushes to main.
 */

const fs = require("fs").promises;
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

// ---------------- config ----------------
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const GEMINI_MODEL   = process.env.GEMINI_MODEL   || "gemini-3.6-flash";
const FALLBACK_MODEL = process.env.FALLBACK_MODEL || "gemini-3.6-flash-lite";
const MAX_CHARS = 140000;          // hard cap on text sent to the model
const MAX_PAGES = 90;              // hard cap on pages extracted
const PDF_MAX_BYTES = 90 * 1024 * 1024;
const SITE = "https://livegmp.in";
const ALIAS_FILE = "data/ipo_aliases.json";

const LIVE_START  = "<!-- LIVE_START -->";
const LIVE_END    = "<!-- LIVE_END -->";
const PROSE_START = "<!-- PROSE_START -->";
const PROSE_END   = "<!-- PROSE_END -->";
const STUB_MARK   = "<!-- AUTO_STUB -->";

const clean = (s = "") => String(s ?? "").replace(/\s+/g, " ").trim();
const esc = (s = "") => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const slugify = (n) => clean(n).toLowerCase()
  .replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");

// Register this company's name variants against the canonical slug so the
// hourly pipeline updates THIS page when the IPO later appears in the GMP
// table under a shorter/different name, instead of creating a second page.
function normalizeKey(name) {
  return clean(name).toLowerCase()
    .replace(/[.,'’&()]/g, " ")
    .replace(/\b(private|pvt|limited|ltd|company|co|corporation|corp|industries|enterprises|the)\b/g, " ")
    .replace(/\bipo\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nameVariants(company) {
  const base = clean(company);
  const out = new Set([base]);
  // common shortenings sources use
  out.add(base.replace(/\s+(india|bharat)\b/i, ""));
  out.add(base.replace(/\b(technologies|industries|enterprises|solutions|pharmaceuticals)\b/i, m => m.slice(0, 5)));
  return [...out].map(clean).filter(v => v && normalizeKey(v));
}

async function registerAliases(company, slug) {
  // An unreadable-but-present alias file must NEVER be treated as an empty
  // one. Doing that once wiped every alias in the repo and the hourly
  // pipeline then built duplicate pages for companies it no longer
  // recognised. Missing file -> start fresh. Present but unparseable ->
  // refuse to write anything and say so loudly.
  let map = {};
  let fileExists = true;
  let rawText = null;
  try {
    rawText = await fs.readFile(ALIAS_FILE, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") {
      fileExists = false;
    } else {
      console.log(`  !! alias file unreadable (${e.message}) — leaving it untouched`);
      return 0;
    }
  }

  if (fileExists) {
    try {
      const parsed = JSON.parse(rawText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not a JSON object");
      }
      map = parsed;
    } catch (e) {
      console.log(`  !! ${ALIAS_FILE} exists but could not be parsed (${e.message}).`);
      console.log(`  !! Refusing to overwrite it — aliases left exactly as they are.`);
      console.log(`  !! Fix the file by hand, then re-run /generate to register aliases.`);
      return 0;
    }
  }

  let added = 0;
  for (const v of nameVariants(company)) {
    if (map[v] && map[v] !== slug) {
      console.log(`  alias conflict, left alone: ${JSON.stringify(v)} already -> ${map[v]}`);
      continue;
    }
    if (!map[v]) { map[v] = slug; added++; }
  }
  if (added) {
    await fs.mkdir(path.dirname(ALIAS_FILE), { recursive: true });
    await fs.writeFile(ALIAS_FILE, JSON.stringify(map, null, 2), "utf8");
  }
  console.log(`Alias map: ${added} variant(s) registered for ${slug}`);
  return added;
}

function die(msg) {
  console.error("FATAL: " + msg);
  process.exit(1);
}

// ---------------- inputs ----------------
function parseRanges(str) {
  const out = [];
  for (const part of String(str || "").split(",")) {
    const p = clean(part);
    if (!p) continue;
    const m = p.match(/^(\d+)\s*[-–]\s*(\d+)$/) || p.match(/^(\d+)$/);
    if (!m) continue;
    const from = +m[1], to = m[2] ? +m[2] : +m[1];
    if (from >= 1 && to >= from) out.push([from, to]);
  }
  return out;
}

function fromIssueBody(body) {
  const get = (label) => {
    const re = new RegExp(`\\|\\s*\\*\\*${label}\\*\\*\\s*\\|\\s*([^|]+?)\\s*\\|`, "i");
    const m = body.match(re);
    return m ? clean(m[1]) : "";
  };
  const company = clean((body.match(/^##\s+(.+)$/m) || [])[1] || "");
  const slugRaw = get("Proposed slug");
  const slug = (slugRaw.match(/`([^`]+)`/) || [])[1] || slugify(company);
  let pdf = get("Main document");
  if (!pdf) {
    const m = body.match(/https?:\/\/\S+\.pdf/i);
    pdf = m ? m[0] : "";
  }
  pdf = pdf.replace(/^<|>$/g, "");
  const kind = get("Filing") || "DRHP";
  return { company, slug, pdf, kind };
}

// ---------------- PDF ----------------
// SEBI drops long TLS transfers often enough that Node's fetch alone is not
// reliable: undici reports it as a bare "TypeError: terminated" with no status
// code and no retry. Three routes, in order:
//   1. a path inside the repo, for PDFs that cannot be reached from Actions
//      at all (bsesme.com is blocked at the connection level — commit those
//      to docs/ and reference them by path)
//   2. Node fetch, twice
//   3. curl, which retries, resumes a broken transfer and tolerates a stall
async function fetchPdf(url) {
  // Route 1: no scheme means it is a file committed to the repo.
  if (!/^https?:\/\//i.test(url)) {
    const buf = await fs.readFile(url);
    console.log(`  read from repo: ${url}`);
    return buf;
  }

  // Route 2: Node fetch, two attempts.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, "Accept": "application/pdf,*/*" },
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ab = await res.arrayBuffer();
      if (ab.byteLength > PDF_MAX_BYTES) {
        throw new Error(`PDF too large (${(ab.byteLength / 1048576).toFixed(1)} MB)`);
      }
      if (ab.byteLength < 10000) throw new Error(`suspiciously small (${ab.byteLength} bytes)`);
      console.log(`  fetched via node fetch (attempt ${attempt})`);
      return Buffer.from(ab);
    } catch (e) {
      console.log(`  node fetch attempt ${attempt}/2 failed: ${e.message}`);
      if (/too large/.test(e.message)) throw e;        // no point retrying
      if (attempt < 2) await new Promise(r => setTimeout(r, 4000));
    }
  }

  // Route 3: curl.
  const tmp = path.join(os.tmpdir(), `drhp_${Date.now()}.pdf`);
  console.log("  falling back to curl…");
  try {
    execFileSync("curl", [
      "-sSL",
      "--fail",
      "--retry", "4",
      "--retry-delay", "3",
      "--retry-all-errors",
      "--connect-timeout", "30",
      "--max-time", "300",
      "--speed-time", "60",        // abort only if under 1 KB/s for 60s
      "--speed-limit", "1024",
      "-A", UA,
      "-H", "Accept: application/pdf,*/*",
      "-o", tmp,
      url,
    ], { stdio: ["ignore", "ignore", "pipe"], timeout: 330000 });
  } catch (e) {
    const err = e.stderr ? e.stderr.toString().trim() : e.message;
    try { await fs.unlink(tmp); } catch {}
    throw new Error(`PDF download failed on every route — curl: ${err || "no stderr"}`);
  }

  const buf = await fs.readFile(tmp);
  try { await fs.unlink(tmp); } catch {}
  if (buf.length > PDF_MAX_BYTES) {
    throw new Error(`PDF too large (${(buf.length / 1048576).toFixed(1)} MB)`);
  }
  if (buf.length < 10000) throw new Error(`curl returned only ${buf.length} bytes — not a PDF`);
  console.log(`  fetched via curl: ${(buf.length / 1048576).toFixed(1)} MB`);
  return buf;
}

async function extractPages(buf, ranges) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf), useSystemFonts: false,
    disableFontFace: true, isEvalSupported: false,
  }).promise;
  const total = doc.numPages;

  const wanted = [];
  for (const [a, b] of ranges) {
    for (let p = a; p <= Math.min(b, total); p++) if (!wanted.includes(p)) wanted.push(p);
  }
  if (!wanted.length) { await doc.destroy(); throw new Error(`no valid pages in range (PDF has ${total})`); }
  if (wanted.length > MAX_PAGES) {
    throw new Error(`${wanted.length} pages requested, cap is ${MAX_PAGES}. Narrow the ranges.`);
  }

  let text = "";
  for (const p of wanted.sort((x, y) => x - y)) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    text += `\n\n--- PDF page ${p} ---\n` + tc.items.map(i => i.str).join(" ");
  }
  await doc.destroy();
  return { text: text.replace(/[ \t]+/g, " "), total, pages: wanted };
}

// ---------------- model ----------------
const SCHEMA_PROMPT = `You are an equity research writing assistant for an Indian IPO information site.
From the DRHP excerpts provided, return ONLY a JSON object — no markdown fences, no preamble — with EXACTLY these keys:

{
 "overview": "2-3 paragraph plain-English company overview: what it does, since when, where, scale",
 "business_model": "1-2 paragraphs: how it earns revenue, key customers or segments",
 "financials": {
   "unit": "Rs in lakhs",
   "columns": ["copy the document's own column headings, in the document's own order"],
   "rows": [ {"metric":"Revenue from operations","values":["one value per column, same order"]} ]
 },
 "objects_of_issue": ["how the IPO proceeds will be used, with amounts where stated"],
 "promoters": "short paragraph on the promoters and their background/holding",
 "strengths": ["4-6 items"],
 "risks": ["4-6 items, the most material and company-specific risk factors"],
 "peer_comparison": "short paragraph naming listed peers if the excerpts provide them, else empty string",
 "verdict_points": ["3-4 neutral points an investor should weigh — NEVER a buy/sell recommendation"]
}

HARD RULES:
- Use ONLY facts present in the excerpts. If a number is not in the excerpts, write "Not disclosed in excerpts" — NEVER estimate, infer or invent a figure.
- Amounts in Rs crore/lakh exactly as the DRHP states them. Do not convert units.
- Simple language for retail investors. No promotional tone.
- FINANCIALS — read this carefully:
  * Copy the financial table's column headings EXACTLY as the document prints them,
    in the document's own order. Indian filings often show four columns — a stub
    period such as "Three months ended June 30, 2026" followed by three fiscals in
    REVERSE order. Do NOT reorder them and do NOT drop the stub period.
  * Every row must have exactly as many entries in "values" as there are "columns".
    Use "" for a cell the document leaves blank or marks N.A.
  * Put the unit once in "unit" (e.g. "Rs in lakhs"), not in every cell. If rows use
    different units, say so in "unit" and append the unit to those cells.
  * Include EVERY metric the table gives, up to 14 rows. At minimum, when present:
    Revenue from operations, Total income, EBITDA, EBITDA margin, Profit after tax
    (or Restated PAT), PAT margin, Net worth, Total borrowings, Return on net worth,
    Basic EPS, Debt-equity ratio.
  * A table with only one or two rows means you have missed the main financial table —
    look again before answering.
- Do not recommend buying or selling. Do not predict listing gains or GMP.
- LENGTH LIMITS (important — the whole JSON must fit in one reply):
  "overview" max 180 words. "business_model" max 120 words. "promoters" max 80 words.
  "peer_comparison" max 80 words. Each array item max 35 words. Max 14 rows in "financials".
  Be specific but concise; do not repeat the same fact in two fields.`;

// Ask the API which models actually exist, instead of hard-coding names that
// get retired. Returns generateContent-capable model ids, newest-looking first.
// A truncated reply is well-formed right up to where it stops, so it only
// shows as a JSON error. Catch it here and treat it like any other transient
// failure, so the chain moves to the next model instead of ending the run.
function assertParsable(text, finishReason) {
  const t = String(text || "").replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
  if (/^(MAX_TOKENS|length)$/i.test(String(finishReason || ""))) {
    throw new Error(`reply truncated (finishReason: ${finishReason}) — output limit reached`);
  }
  try { JSON.parse(t); } catch (e) {
    throw new Error(`reply was not valid JSON (${e.message.slice(0, 60)}) — usually truncation`);
  }
}

async function listModels(key) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=200`);
  const data = await res.json();
  if (data.error) throw new Error(`ListModels: ${data.error.message}`);
  return (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map(m => String(m.name || "").replace(/^models\//, ""))
    .filter(Boolean);
}

// Version-aware sort: gemini-3.8-flash beats gemini-3.6-flash beats 2.5.
function versionOf(id) {
  const m = id.match(/(\d+)\.(\d+)/);
  return m ? (+m[1]) * 100 + (+m[2]) : 0;
}

function buildChain(available, preferred) {
  const has = id => available.includes(id);
  const chain = [];
  // Only pin the configured model if it is at least as new as the newest
  // available; otherwise prefer whatever is newest, since a congested older
  // model is exactly the case we are trying to route around.
  if (preferred && has(preferred)) {
    const newest = Math.max(0, ...available.filter(id => /flash/.test(id) && !/lite/.test(id)).map(versionOf));
    if (versionOf(preferred) >= newest) chain.push(preferred);
  }

  const isUsable = id =>
    /gemini/.test(id) && /flash|pro/.test(id) &&
    !/embed|vision|tts|image|audio|live|thinking-exp/.test(id);

  const flash = available.filter(id => isUsable(id) && /flash/.test(id) && !/lite/.test(id))
    .sort((a, b) => versionOf(b) - versionOf(a));
  const lite = available.filter(id => isUsable(id) && /flash/.test(id) && /lite/.test(id))
    .sort((a, b) => versionOf(b) - versionOf(a));

  // Interleave: newest Flash, newest Lite, then the rest. Lite usually has
  // capacity exactly when Flash is saturated, so never fill the chain with
  // four Flash variants that share the same congestion.
  const inter = [];
  for (let i = 0; i < Math.max(flash.length, lite.length); i++) {
    if (flash[i]) inter.push(flash[i]);
    if (lite[i]) inter.push(lite[i]);
  }
  for (const id of inter) if (!chain.includes(id)) chain.push(id);
  return chain.slice(0, 6);
}

// Errors that no amount of retrying or model-switching can fix: the account
// itself cannot call this API. Burning 18 requests against a revoked free
// tier wastes four minutes before the backups ever get a turn.
const GEMINI_ACCOUNT_FATAL =
  /free tier is not available|billing|consumer_suspended|API key not valid|API_KEY_INVALID|PERMISSION_DENIED|has not been used in project|is disabled|SERVICE_DISABLED|quota.*exceeded.*billing/i;

async function callGemini(key, prompt) {
  let available = [];
  try {
    available = await listModels(key);
    console.log(`  models available: ${available.length}`);
  } catch (e) {
    if (GEMINI_ACCOUNT_FATAL.test(e.message)) {
      throw new Error(`account cannot use this API (${e.message}) — skipping straight to backups`);
    }
    console.log(`  ListModels failed (${e.message}) — falling back to configured names only`);
  }

  const chain = available.length
    ? buildChain(available, GEMINI_MODEL)
    : [GEMINI_MODEL, FALLBACK_MODEL].filter(Boolean);
  console.log(`  model chain: ${chain.join(" -> ")}`);

  let lastErr = null;
  for (const model of chain) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json", maxOutputTokens: 24576, temperature: 0.2 },
          }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
        const cand = data.candidates && data.candidates[0];
        if (!cand || !cand.content || !cand.content.parts) {
          throw new Error("no content returned" + (cand && cand.finishReason ? ` (finishReason: ${cand.finishReason})` : ""));
        }
        const out = cand.content.parts.map(p => p.text || "").join("");
        assertParsable(out, cand.finishReason);
        if (model !== chain[0]) console.log(`  NOTE: used fallback model ${model}`);
        return { text: out, modelUsed: model };
      } catch (e) {
        lastErr = e;
        console.log(`  ${model} attempt ${attempt}/3 failed: ${e.message}`);

        // Account-level refusal: every model will say the same thing.
        if (GEMINI_ACCOUNT_FATAL.test(e.message)) {
          throw new Error(`account cannot use this API (${e.message}) — skipping straight to backups`);
        }

        const transient = /high demand|overload|503|429|rate limit|unavailable|timeout|internal error|truncated|not valid JSON/i.test(e.message);
        if (!transient) break;                       // not found: next model
        if (attempt < 3) await new Promise(r => setTimeout(r, 15000 * attempt));
      }
    }
  }
  throw new Error(`Gemini: ${lastErr ? lastErr.message : "all models and attempts failed"}`);
}


// ============================================================
// BACKUP PROVIDERS — used when Gemini is saturated or unavailable.
// Groq and OpenRouter both expose an OpenAI-compatible /chat/completions
// endpoint, so one function serves both. Keys are optional: a provider with
// no key is skipped silently.
// ============================================================
// ORDER MATTERS. The provider that can read the most of the document goes
// first. Groq's free tier is 8000 TPM, which caps the excerpt at ~14k chars —
// a quarter of a typical abridged prospectus — and a draft written from a
// quarter of the document is missing whole sections without saying so.
const BACKUPS = [
  {
    name: "openrouter",
    env: "OPENROUTER_API_KEY",
    base: "https://openrouter.ai/api/v1",
    prefer: [/llama-3\.3-70b.*:free/i, /deepseek.*:free/i, /qwen.*:free/i, /:free$/i],
    maxTokens: 8000,
    charBudget: 120000,  // free models here usually have large context
  },
  {
    name: "groq",
    env: "GROQ_API_KEY",
    base: "https://api.groq.com/openai/v1",
    // Preference only — anything else the account can see is still tried
    // after these. A hardcoded list silently shrank the chain to one model
    // when Groq renamed its roster.
    prefer: [/gpt-oss-20b/i, /llama-3\.1-8b/i, /llama-3\.3-70b/i, /gpt-oss-120b/i, /qwen/i, /llama-4/i],
    maxTokens: 4000,     // free tier is 8000 TPM and counts max_tokens toward it
    charBudget: 14000,   // roughly 3.5k tokens of excerpt
  },
];

// A reply built from this little of the document is accepted only if nothing
// better is available anywhere in the chain.
const GOOD_COVERAGE = 0.9;

// Models that exist on these providers but cannot do chat completion.
const NOT_CHAT = /whisper|tts|embed|guard|moderation|vision-only|distil-whisper|playai/i;

async function openAiCompatModels(base, key) {
  try {
    const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || "models error");
    return (data.data || []).map(m => m.id).filter(Boolean);
  } catch (e) {
    console.log(`    ${base}: could not list models (${e.message})`);
    return [];
  }
}

async function callOpenAiCompat(provider, key, prompt) {
  const ids = await openAiCompatModels(provider.base, key);
  const usable = ids.filter(id => !NOT_CHAT.test(id));
  console.log(`  ${provider.name}: ${ids.length} model(s) listed, ${usable.length} usable`);

  // Preference first, then everything else — never narrow to a fixed list.
  const chain = [];
  for (const re of provider.prefer) for (const id of usable) if (re.test(id) && !chain.includes(id)) chain.push(id);
  for (const id of usable) if (!chain.includes(id)) chain.push(id);
  if (!chain.length) throw new Error(`${provider.name}: no usable models`);
  console.log(`  ${provider.name} chain: ${chain.slice(0, 4).join(" -> ")}`);

  // The excerpt is the only part worth shrinking; the schema must stay whole.
  const SPLIT = "DRHP EXCERPTS:\n";
  const cut = prompt.indexOf(SPLIT);
  const head = cut === -1 ? "" : prompt.slice(0, cut + SPLIT.length);
  const body = cut === -1 ? prompt : prompt.slice(cut + SPLIT.length);
  const build = chars => head + body.slice(0, chars);

  // A per-minute token limit is not a transient blip — retrying the same
  // payload fails identically. Shrink the excerpt instead.
  const tooBig = m => /too large|tokens per minute|TPM|reduce your message|context length|maximum context/i.test(m);

  let lastErr = null;
  for (const model of chain.slice(0, 4)) {
    let budget = Math.min(provider.charBudget || 120000, body.length);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const sent = build(budget);
      try {
        const res = await fetch(`${provider.base}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: sent }],
            temperature: 0.2,
            max_tokens: provider.maxTokens || 8000,
            response_format: { type: "json_object" },
          }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
        const txt = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (!txt) throw new Error("empty response");
        assertParsable(txt, data.choices[0].finish_reason);
        const coverage = body.length ? budget / body.length : 1;
        if (budget < body.length) {
          console.log(`  NOTE: ${provider.name}/${model} used only the first ${budget} of ${body.length} chars (${Math.round(coverage * 100)}% of the document).`);
        }
        return { text: txt, modelUsed: `${provider.name}/${model}`, coverage, charsUsed: budget, charsTotal: body.length };
      } catch (e) {
        lastErr = e;
        console.log(`  ${provider.name}/${model} attempt ${attempt}/3 failed: ${e.message}`);
        if (tooBig(e.message)) {
          const next = Math.floor(budget / 2);
          if (next < 6000) { console.log(`  ${provider.name}/${model}: excerpt cannot shrink further and still be useful — next model.`); break; }
          budget = next;
          console.log(`  retrying with a ${budget}-char excerpt`);
          continue;
        }
        const transient = /rate limit|429|503|overload|timeout|capacity|busy|truncated|not valid JSON/i.test(e.message);
        if (!transient) break;
        if (attempt < 3) await new Promise(r => setTimeout(r, 8000));
      }
    }
  }
  throw new Error(`${provider.name}: ${lastErr ? lastErr.message : "all models failed"}`);
}

// Gemini first, then each configured backup in turn.
//
// A provider that returns valid JSON built from a quarter of the document is
// NOT a success — it is a thin draft that looks complete. Such a reply is held
// as provisional and the chain keeps going; it is used only if no provider
// manages to read the document properly. This is the bug that produced a
// one-row financials table while the real KPI table sat unread on page 13.
async function generateDraft(geminiKey, prompt) {
  let provisional = null;
  const consider = (r) => {
    if (r.coverage >= GOOD_COVERAGE) return r;
    console.log(`  held as provisional (${Math.round(r.coverage * 100)}% coverage) — trying for a fuller read`);
    if (!provisional || r.coverage > provisional.coverage) provisional = r;
    return null;
  };

  try {
    const r = await callGemini(geminiKey, prompt);
    return { ...r, coverage: 1 };
  } catch (e) {
    console.log(`Gemini unavailable: ${e.message}`);
  }

  for (const provider of BACKUPS) {
    const key = process.env[provider.env];
    if (!key) { console.log(`  ${provider.name}: no ${provider.env} set, skipping`); continue; }
    try {
      console.log(`Falling back to ${provider.name}…`);
      const good = consider(await callOpenAiCompat(provider, key, prompt));
      if (good) return good;
    } catch (e) {
      console.log(`  ${provider.name} failed: ${e.message}`);
    }
  }

  if (provisional) {
    console.log(`No provider could read the whole document. Using the best partial read: ` +
      `${provisional.modelUsed}, ${provisional.charsUsed} of ${provisional.charsTotal} chars.`);
    return provisional;
  }
  throw new Error("every provider failed — no backup succeeded. Re-comment /generate to retry.");
}

// ---------------- financials shape ----------------
// The schema asks for {unit, columns, rows:[{metric, values[]}]}, which copes
// with the four-column tables Indian filings actually print (a stub period
// plus three fiscals, in reverse order). Models sometimes answer in the older
// flat fy1/fy2/fy3 shape anyway, so accept both and normalise to one.
// Returns null when the value is unusable.
function normalizeFinancials(f) {
  if (!f) return null;

  // New shape.
  if (!Array.isArray(f) && typeof f === "object") {
    const columns = (Array.isArray(f.columns) ? f.columns : []).map(clean).filter(Boolean);
    const rawRows = Array.isArray(f.rows) ? f.rows : [];
    const rows = rawRows
      .map(r => ({
        metric: clean(r && r.metric),
        values: Array.isArray(r && r.values) ? r.values.map(v => clean(v)) : [],
      }))
      .filter(r => r.metric);
    if (!columns.length || !rows.length) return null;
    return { unit: clean(f.unit), columns, rows };
  }

  // Legacy flat shape: [{metric, fy1_label, fy1, fy2_label, fy2, fy3_label, fy3}]
  if (Array.isArray(f) && f.length) {
    const f0 = f[0] || {};
    const columns = [f0.fy1_label || "FY1", f0.fy2_label || "FY2", f0.fy3_label || "FY3"].map(clean);
    const rows = f
      .map(r => ({
        metric: clean(r && r.metric),
        values: [clean(r && r.fy1), clean(r && r.fy2), clean(r && r.fy3)],
      }))
      .filter(r => r.metric);
    if (!rows.length) return null;
    return { unit: "", columns, rows };
  }

  return null;
}

// ---------------- validation ----------------
const BANNED = [
  /as an ai\b/i, /\bi cannot\b/i, /\bi'm sorry\b/i, /language model/i,
  /lorem ipsum/i, /\bTODO\b/, /\[insert/i, /\bXXX\b/,
];

function validateDraft(d) {
  const errs = [];
  const need = ["overview", "business_model", "promoters"];
  for (const k of need) {
    if (!d[k] || clean(d[k]).length < 60) errs.push(`"${k}" missing or too short`);
  }
  for (const k of ["strengths", "risks"]) {
    if (!Array.isArray(d[k]) || d[k].length < 3) errs.push(`"${k}" needs at least 3 items`);
  }
  if (!Array.isArray(d.objects_of_issue) || d.objects_of_issue.length < 1) errs.push(`"objects_of_issue" is empty`);
  if (!Array.isArray(d.verdict_points) || d.verdict_points.length < 2) errs.push(`"verdict_points" needs at least 2 items`);

  const fin = normalizeFinancials(d.financials);
  if (!fin) {
    errs.push(`"financials" is missing or not in a recognised shape`);
  } else if (fin.rows.length < 3) {
    errs.push(`"financials" has only ${fin.rows.length} row(s) — the model did not find the main financial table. ` +
              `Usually the excerpt was truncated or the page ranges miss the financial summary.`);
  } else {
    const bad = fin.rows.filter(r => r.values.length !== fin.columns.length);
    if (bad.length) {
      errs.push(`${bad.length} financial row(s) have the wrong number of values for ${fin.columns.length} columns ` +
                `(first: "${bad[0].metric}")`);
    }
  }

  const blob = JSON.stringify(d);
  for (const re of BANNED) if (re.test(blob)) errs.push(`contains disallowed text matching ${re}`);
  if (/\b(buy|sell|subscribe|avoid)\s+(this|the)\s+ipo\b/i.test(blob)) {
    errs.push("contains an investment recommendation");
  }
  return errs;
}

// Flag figures the model produced that do not literally appear in the source text.
function unverifiedFigures(d, sourceText) {
  const src = sourceText.replace(/,/g, "");
  const found = new Set();
  const check = (val, where) => {
    const s = String(val ?? "");
    for (const m of s.matchAll(/\d[\d,]*\.?\d*/g)) {
      const num = m[0].replace(/,/g, "");
      if (num.length < 3) continue;                 // ignore tiny numbers
      if (!src.includes(num)) found.add(`${where}: ${m[0]}`);
    }
  };
  const fin = normalizeFinancials(d.financials);
  if (fin) {
    fin.rows.forEach(r => {
      r.values.forEach((v, c) => check(v, `financials — ${r.metric} / ${fin.columns[c] || `col ${c + 1}`}`));
    });
  }
  (d.objects_of_issue || []).forEach((o, i) => check(o, `objects_of_issue[${i}]`));
  return [...found];
}

// ---------------- render ----------------
const ul = (arr) => `<ul>\n${(arr || []).map(x => `  <li>${esc(x)}</li>`).join("\n")}\n</ul>`;
const paras = (s) => clean(s).split(/\n{2,}|(?<=\.)\s{2,}/).filter(Boolean)
  .map(p => `<p>${esc(p)}</p>`).join("\n");

function financialsTable(f) {
  const fin = normalizeFinancials(f);
  if (!fin || !fin.rows.length) {
    return `<p>Financial details were not available in the extracted sections.</p>`;
  }
  const head = `<tr><th>Metric</th>${fin.columns.map(c => `<th>${esc(c)}</th>`).join("")}</tr>`;
  const body = fin.rows.map(r => {
    const cells = fin.columns.map((_, i) => `<td>${esc(r.values[i] ?? "")}</td>`).join("");
    return `<tr><td>${esc(r.metric)}</td>${cells}</tr>`;
  }).join("\n");
  const unit = clean(fin.unit)
    ? `\n<p class="stub-unit">All figures ${esc(fin.unit)} unless otherwise stated.</p>`
    : "";
  return `<table class="stub-table">
${head}
${body}
</table>${unit}`;
}

// Only link to the source document when it is on an official host. An
// aggregator URL in a published page is both a dead link waiting to happen
// and free advertising for a competitor.
const OFFICIAL_HOST = /(^|\.)(sebi\.gov\.in|nseindia\.com|bseindia\.com|bsesme\.com)$/i;

function sourceLine(meta) {
  let host = "";
  try { host = new URL(meta.pdf).hostname; } catch {}
  if (host && OFFICIAL_HOST.test(host)) {
    return `<p class="stub-updated">Figures as disclosed in the ${esc(meta.kind)} filed with SEBI. Source: <a href="${esc(meta.pdf)}" rel="nofollow noopener" target="_blank">offer document</a>.</p>`;
  }
  return `<p class="stub-updated">Figures as disclosed in the ${esc(meta.kind)} filed with SEBI.</p>`;
}

function proseZone(d, meta) {
  return `${PROSE_START}
<h2>About ${esc(meta.company)}</h2>
${paras(d.overview)}

<h2>Business Model</h2>
${paras(d.business_model)}

<h2>Financial Performance</h2>
${financialsTable(d.financials)}
${sourceLine(meta)}

<h2>Objects of the Issue</h2>
${ul(d.objects_of_issue)}

<h2>Promoters</h2>
${paras(d.promoters)}

<h2>Strengths</h2>
${ul(d.strengths)}

<h2>Key Risks</h2>
${ul(d.risks)}
${d.peer_comparison && clean(d.peer_comparison) ? `\n<h2>Peer Comparison</h2>\n${paras(d.peer_comparison)}\n` : ""}
<h2>Points to Weigh</h2>
${ul(d.verdict_points)}
<div class="coming-soon-note">This page is updated automatically as the IPO progresses — price band, dates and live GMP appear above once announced. Nothing here is investment advice.</div>
${PROSE_END}`;
}

function placeholderLiveZone(company) {
  return `${LIVE_START}
<div class="coming-soon-note">📅 <strong>IPO dates not announced yet.</strong> ${esc(company)} has filed its draft offer document. Price band, dates and live GMP will appear here automatically once the IPO is scheduled.</div>
${LIVE_END}`;
}

function newPage({ company, slug, kind, pdf }, prose) {
  const url = `${SITE}/ipo/${slug}/`;
  const title = `${company} IPO — ${kind} Details, Business & Financials | LiveGMP`;
  const desc = `${company} IPO: business overview, financials, objects of the issue, promoters, strengths and risks from the ${kind} filed with SEBI.`;
  const jsonld = JSON.stringify({
    "@context": "https://schema.org", "@type": "Article",
    "headline": `${company} IPO — ${kind} Details, Business & Financials`,
    "dateModified": new Date().toISOString(), "mainEntityOfPage": url,
    "author": { "@type": "Organization", "name": "LiveGMP.in" },
    "publisher": { "@type": "Organization", "name": "LiveGMP.in" },
  });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <link rel="canonical" href="${url}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:url" content="${url}">
  <meta property="og:type" content="article">
  <link rel="stylesheet" href="/static/gmp.css">
  <script type="application/ld+json">${jsonld}</script>
</head>
<body>
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
<nav class="breadcrumbs"><a href="/">Live GMP</a> › <a href="/ipo/">IPO Analysis</a> › ${esc(company)}</nav>
<h1>${esc(company)} IPO — ${esc(kind)} Details, Business &amp; Financials</h1>

${placeholderLiveZone(company)}

${prose}
</main>
<footer class="site-footer">
  <p>This page is for information and education only and is not investment advice. GMP figures are unofficial estimates. Investments are subject to market risk — consult a SEBI-registered advisor.</p>
  <p>&copy; LiveGMP.in · <a href="/">Live IPO GMP</a> · <a href="/ipo/">All IPO Pages</a></p>
</footer>
</body>
</html>`;
}

// ---------------- main ----------------
(async () => {
  const issueBody   = process.env.ISSUE_BODY || "";
  const commentBody = process.env.COMMENT_BODY || "";
  const key         = process.env.GEMINI_API_KEY || "";

  if (!key) die("GEMINI_API_KEY is not set. Add it as a repository secret.");

  const meta = fromIssueBody(issueBody);
  if (!meta.company) die("could not read the company name from the issue body (expected an '## Company' heading).");
  if (!meta.pdf)     die("no main-document PDF URL found in the issue body.");
  meta.slug = meta.slug || slugify(meta.company);

  const ranges = parseRanges(commentBody.replace(/^\s*\/generate/i, ""));
  if (!ranges.length) die('no page ranges found. Comment like: /generate 12-18, 96-104, 210-232');

  console.log(`Company : ${meta.company}`);
  console.log(`Slug    : ${meta.slug}`);
  console.log(`Filing  : ${meta.kind}`);
  console.log(`PDF     : ${meta.pdf}`);
  console.log(`Ranges  : ${ranges.map(r => r[0] + "-" + r[1]).join(", ")}`);

  console.log("Downloading PDF…");
  const buf = await fetchPdf(meta.pdf);
  console.log(`  ${(buf.length / 1048576).toFixed(1)} MB`);

  console.log("Extracting pages…");
  const ext = await extractPages(buf, ranges);
  console.log(`  ${ext.pages.length} pages of ${ext.total}, ${ext.text.length} chars`);
  if (ext.text.length < 2000) die("extracted text is too short — wrong page ranges, or the PDF is a scan with no text layer.");

  const source = ext.text.slice(0, MAX_CHARS);
  const prompt = `${SCHEMA_PROMPT}\n\nCOMPANY: ${meta.company}\n\nDRHP EXCERPTS:\n${source}`;

  console.log(`Calling the model…`);
  const { text: raw, modelUsed, coverage = 1, charsUsed, charsTotal } = await generateDraft(key, prompt);
  let draft;
  try {
    draft = JSON.parse(raw.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim());
  } catch (e) {
    console.error("Model reply was not valid JSON. First 1200 chars:\n" + raw.slice(0, 1200));
    die("could not parse model output as JSON. Re-comment /generate to retry.");
  }

  const errs = validateDraft(draft);
  if (errs.length) {
    console.error("Draft failed validation:");
    for (const e of errs) console.error("  - " + e);
    die("validation failed — nothing written. Re-comment /generate to retry, or widen the page ranges.");
  }

  const unverified = unverifiedFigures(draft, ext.text);
  console.log(`Figures not found verbatim in source: ${unverified.length}`);

  // ---- write the page ----
  const dir = `ipo/${meta.slug}`;
  const file = `${dir}/index.html`;
  const prose = proseZone(draft, meta);

  let existing = null;
  try { existing = await fs.readFile(file, "utf8"); } catch {}

  let action;
  if (!existing) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, newPage(meta, prose), "utf8");
    action = "created a new page (placeholder live zone; the hourly pipeline fills GMP/dates when this IPO reaches the GMP table)";
  } else {
    const si = existing.indexOf(PROSE_START);
    const ei = existing.indexOf(PROSE_END);
    if (si === -1 || ei === -1 || ei < si) {
      die(`${file} exists but has no PROSE_START/PROSE_END zone. Add the markers, then retry.`);
    }
    let out = existing.slice(0, si) + prose + existing.slice(ei + PROSE_END.length);
    out = out.replace(STUB_MARK + "\n", "").replace(STUB_MARK, "");   // no longer a stub
    await fs.writeFile(file, out, "utf8");
    action = "replaced the prose zone on the existing page (live GMP zone untouched)";
  }
  console.log(`Wrote ${file} — ${action}`);

  const aliasCount = await registerAliases(meta.company, meta.slug);

  // ---- PR body ----
  let md = `Generated from the ${meta.kind} for **${meta.company}**.\n\n`;
  md += `| | |\n|---|---|\n`;
  md += `| Page | \`${file}\` → ${SITE}/ipo/${meta.slug}/ |\n`;
  md += `| Action | ${action} |\n`;
  md += `| Source PDF | ${meta.pdf} |\n`;
  md += `| Pages used | ${ranges.map(r => r[0] + "-" + r[1]).join(", ")} (${ext.pages.length} of ${ext.total}) |\n`;
  md += `| Model | ${modelUsed} |\n`;
  md += `| Document read | ${coverage >= 1 ? "all of it" : `${Math.round(coverage * 100)}% (${charsUsed} of ${charsTotal} chars)`} |\n`;
  md += `| Alias variants registered | ${aliasCount} (in \`${ALIAS_FILE}\`) |\n\n`;

  md += `### ⚠️ Verify before merging\n\n`;
  if (coverage < 1) {
    md += `> **Only ${Math.round(coverage * 100)}% of the extracted text reached the model.** No provider could read ` +
          `the whole document, so whole sections of the filing were never seen. Treat every section below as ` +
          `possibly incomplete, and check the financials table against the source before merging.\n\n`;
  }
  if (unverified.length) {
    md += `${unverified.length} figure(s) in this draft do **not** appear verbatim in the extracted text. Check each against the DRHP — these are the most likely errors:\n\n`;
    md += unverified.map(u => `- \`${u}\``).join("\n") + "\n\n";
    md += `Some will be innocent (reformatting, units, decimals). Any that aren't must be corrected or removed.\n\n`;
  } else {
    md += `Every numeric figure in this draft appears verbatim in the extracted pages. That is a good sign but **not** proof the figures were read from the right rows — spot-check the financials table against the DRHP.\n\n`;
  }
  md += `Also confirm: the company description matches the right entity, risks are company-specific rather than generic, and nothing reads as a recommendation.\n\n`;
  md += `Merging publishes this page. Edit files directly in this PR to fix anything.\n`;

  await fs.writeFile("pr_body.md", md, "utf8");

  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT,
      `slug=${meta.slug}\ncompany=${meta.company}\nfile=${file}\nunverified=${unverified.length}\n`, "utf8");
  }
})().catch(err => {
  console.error("FATAL:", err && err.stack ? err.stack : err);
  process.exit(1);
});
