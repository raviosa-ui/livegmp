// -----------------------------------------------------------
// POLYFILL FIX FOR UNDICI (prevents "File is not defined")
// -----------------------------------------------------------
if (typeof File === "undefined") {
  try {
    const { Blob } = require("buffer");
    class FilePoly extends Blob {
      constructor(chunks, name = "", opts = {}) {
        super(chunks, opts);
        this.name = name;
        this.lastModified = opts.lastModified || Date.now();
      }
      get [Symbol.toStringTag]() {
        return "File";
      }
    }
    global.File = FilePoly;
    global.Blob = Blob;
  } catch (err) {
    console.log("Polyfill load error (ignored):", err);
  }
}

// -----------------------------------------------------------
// IMPORTS (NO node-fetch)
// -----------------------------------------------------------
const cheerio = require("cheerio");
const { google } = require("googleapis");

// -----------------------------------------------------------
// CONFIG (FROM GITHUB SECRETS)
// -----------------------------------------------------------
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const FILL_TYPE_FROM_NSE = process.env.FILL_TYPE_FROM_NSE === "true";
const DEFAULT_TYPE = process.env.DEFAULT_TYPE || "Mainboard";

if (!SHEET_ID || !PRIVATE_KEY || !CLIENT_EMAIL) {
  console.error("❌ Missing Google API secrets.");
  process.exit(1);
}

// -----------------------------------------------------------
// GOOGLE AUTH
// -----------------------------------------------------------
const auth = new google.auth.JWT(
  CLIENT_EMAIL,
  null,
  PRIVATE_KEY,
  ["https://www.googleapis.com/auth/spreadsheets"]
);

const sheets = google.sheets({ version: "v4", auth });

// -----------------------------------------------------------
// FETCH HTML PAGE (MAIN SOURCE: InvestorGain)
// -----------------------------------------------------------
async function fetchInvestorGain() {
  console.log("➡ Fetching source: InvestorGain…");

  const url = "https://www.investorgain.com/report/live-ipo-gmp/331/ipo/";

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    },
  });

  if (!res.ok) throw new Error("Failed to fetch InvestorGain");

  const html = await res.text();
  return html;
}

// -----------------------------------------------------------
// PARSE TABLE ROWS
// -----------------------------------------------------------
function parseRows(html) {
  const $ = cheerio.load(html);

  const rows = [];

  $("table tr").each((i, el) => {
    const tds = $(el).find("td");
    if (tds.length < 4) return;

    const ipo = $(tds[0]).text().trim();
    const gmp = $(tds[1]).text().trim();
    const kostak = $(tds[2]).text().trim();
    const sauda = $(tds[3]).text().trim();

    if (!ipo) return;

    rows.push({
      IPO: ipo,
      GMP: gmp,
      Kostak: kostak,
      SubjectToSauda: sauda,
      Type: DEFAULT_TYPE,
    });
  });

  return rows;
}

// -----------------------------------------------------------
// UPDATE GOOGLE SHEET
// -----------------------------------------------------------
async function updateSheet(rows) {
  console.log("➡ Updating Google Sheet…");

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: "Sheet1!A1",
    valueInputOption: "RAW",
    requestBody: {
      values: [
        ["IPO", "GMP", "Kostak", "SubjectToSauda", "Type"],
        ...rows.map((r) => [
          r.IPO,
          r.GMP,
          r.Kostak,
          r.SubjectToSauda,
          r.Type,
        ]),
      ],
    },
  });

  console.log("✅ Sheet updated successfully!");
}

// -----------------------------------------------------------
// MAIN
// -----------------------------------------------------------
async function main() {
  try {
    const html = await fetchInvestorGain();
    const rows = parseRows(html);

    console.log("Parsed sample:", rows.slice(0, 5));

    await updateSheet(rows);

    console.log("🎉 Done!");
  } catch (err) {
    console.error("❌ ERROR:", err);
    process.exit(1);
  }
}

main();
