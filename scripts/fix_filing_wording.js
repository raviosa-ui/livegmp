/**
 * One-off: replace "filed with SEBI" wording on published IPO pages.
 * SME offer documents are filed with BSE SME / NSE Emerge, not SEBI.
 *
 *   "Figures as disclosed in the DRHP|RHP|UDRHP filed with SEBI."
 *     -> "Figures as disclosed in the DRHP/RHP filed with the stock exchange."
 *   "...strengths and risks from the DRHP|RHP|UDRHP filed with SEBI."
 *     -> "...strengths and risks from the DRHP/RHP filed with the stock exchange."
 *
 * Touches only those two exact sentences. Safe to run twice (second run: 0 changes).
 */
const fs = require("fs");
const path = require("path");

const RULES = [
  [/Figures as disclosed in the (?:U?DRHP|RHP) filed with SEBI\./g,
   "Figures as disclosed in the DRHP/RHP filed with the stock exchange."],
  [/strengths and risks from the (?:U?DRHP|RHP) filed with SEBI\./g,
   "strengths and risks from the DRHP/RHP filed with the stock exchange."],
];

let files = 0, hits = 0;
for (const d of fs.readdirSync("ipo", { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const f = path.join("ipo", d.name, "index.html");
  if (!fs.existsSync(f)) continue;
  const before = fs.readFileSync(f, "utf8");
  let after = before;
  for (const [re, to] of RULES) after = after.replace(re, () => { hits++; return to; });
  if (after !== before) { fs.writeFileSync(f, after, "utf8"); files++; console.log(`  fixed ${f}`); }
}
console.log(`Done: ${hits} sentence(s) replaced in ${files} page(s).`);
const left = fs.readdirSync("ipo").filter(n => {
  const f = path.join("ipo", n, "index.html");
  return fs.existsSync(f) && fs.readFileSync(f, "utf8").includes("filed with SEBI");
});
if (left.length) console.log(`Still mentioning "filed with SEBI": ${left.join(", ")}`);
