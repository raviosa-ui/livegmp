'use strict';
/**
 * Shadow comparison — read-only, writes only into tmp/.
 *
 * Compares the InvestorGain adapter against the gmp.json the live ipowatch
 * pipeline last committed. Run daily for a few days before promoting.
 *
 *   node scripts/compare_sources.js [path/to/gmp.json]
 *
 * gmp.json shape (confirmed from build_gmp.js):
 *   { updatedIso, updatedLocal, source, rows: [
 *       { ipo, gmp, gmpRaw, price, listing, date, type, href, status, slug } ] }
 */

const fs = require('fs');
const path = require('path');
const { fetchInvestorGainRows } = require('./sources/investorgain');

const GMP_PATH = process.argv[2] || path.join(process.cwd(), 'gmp.json');
const OUT = path.join(process.cwd(), 'tmp');

// Same stripping idea as normalizeKey() in build_gmp.js, kept local so this
// tool can never affect the pipeline's own matching.
function key(name) {
  return String(name || '').toLowerCase()
    .replace(/[.,'’&()]/g, ' ')
    .replace(/\b(private|pvt|limited|ltd|company|co|corporation|corp|industries|enterprises|the|ipo)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function num(v) {
  if (v === null || v === undefined) return null;
  const m = String(v).replace(/[₹,]/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const prev = JSON.parse(fs.readFileSync(GMP_PATH, 'utf8'));
  const existing = Array.isArray(prev.rows) ? prev.rows : [];
  if (!existing.length) throw new Error(`${GMP_PATH} has no rows[]`);

  const { rows: igRows, meta } = await fetchInvestorGainRows({ verbose: true });

  const igByKey = new Map();
  for (const r of igRows) igByKey.set(key(r.ipo), r);

  const matched = [];
  const missing = [];
  for (const e of existing) {
    const hit = igByKey.get(key(e.ipo));
    if (hit) matched.push({ e, hit }); else missing.push(e);
  }
  const hitKeys = new Set(matched.map((m) => key(m.e.ipo)));
  const extra = igRows.filter((r) => !hitKeys.has(key(r.ipo)));

  const typeClash = matched.filter(({ e, hit }) =>
    e.type && hit.type && e.type !== 'Unknown' && e.type !== hit.type);

  const gmpDiff = matched.map(({ e, hit }) => {
    const a = e.gmp;
    const b = num(hit.gmpRaw === '-' ? null : hit.gmpRaw);
    if (a === null || b === null || a === b) return null;
    return {
      ipo: e.ipo, ipowatch: a, investorgain: b,
      delta: Number((b - a).toFixed(2)),
      roundingOnly: Math.abs(b - a) < 1 && Number.isInteger(a),
    };
  }).filter(Boolean);

  const dateDiff = matched
    .filter(({ e, hit }) => (e.date || '') !== (hit.date || ''))
    .map(({ e, hit }) => ({ ipo: e.ipo, ipowatch: e.date, investorgain: hit.date }));

  const noPrice = igRows.filter((r) => !r.price).map((r) => r.ipo);

  const L = [];
  const log = (s) => { console.log(s); L.push(s); };

  log(`compare @ ${new Date().toISOString()}`);
  log(`gmp.json: ${existing.length} rows, source=${prev.source}, updated=${prev.updatedLocal || prev.updatedIso}`);
  log(`investorgain: ${igRows.length} rows (${meta.requests.map((r) => `${r.month}/${r.year}:${r.rows}`).join(' ')}, fy=${meta.requests[0] && meta.requests[0].fy})`);
  log('');
  log(`matched         : ${matched.length}`);
  log(`MISSING from IG : ${missing.length}   <-- must be 0 before promoting`);
  log(`type clashes    : ${typeClash.length}   <-- must be 0 before promoting`);
  log(`extra in IG     : ${extra.length}  (expected: earlier upcoming coverage)`);
  log(`gmp differences : ${gmpDiff.length} (rounding-only ${gmpDiff.filter((d) => d.roundingOnly).length})`);
  log(`date-text diffs : ${dateDiff.length}  (format differs by design; check the STATUS each implies)`);
  log(`rows with no usable price: ${noPrice.length}  <-- these would show "Est. Listing: —"`);

  const dump = (title, list, fn) => {
    if (!list.length) return;
    log(`\n-- ${title} --`);
    list.forEach((x) => log('  ' + fn(x)));
  };
  dump('missing', missing, (e) => `${e.ipo} (${e.type}, gmp=${e.gmp}, ${e.status})`);
  dump('type clashes', typeClash, ({ e, hit }) => `${e.ipo}: gmp.json=${e.type} ig=${hit.type}`);
  dump('extra in investorgain', extra, (r) => `${r.ipo} (${r.type || '?'}, ${r.date || 'no date'}, ${r.gmpRaw})`);
  dump('non-rounding gmp differences', gmpDiff.filter((d) => !d.roundingOnly),
    (d) => `${d.ipo}: ipowatch=${d.ipowatch} ig=${d.investorgain} (${d.delta > 0 ? '+' : ''}${d.delta})`);
  dump('date text', dateDiff, (d) => `${d.ipo}: "${d.ipowatch}" vs "${d.investorgain}"`);
  dump('no price', noPrice, (n) => n);

  fs.writeFileSync(path.join(OUT, 'compare_report.json'), JSON.stringify(
    { counts: { existing: existing.length, ig: igRows.length, matched: matched.length,
        missing: missing.length, extra: extra.length, typeClash: typeClash.length,
        noPrice: noPrice.length },
      missing, extra, typeClash, gmpDiff, dateDiff, noPrice }, null, 2));
  fs.writeFileSync(path.join(OUT, 'compare_report.txt'), L.join('\n'));
})().catch((e) => {
  console.error(`compare failed: ${e.message}`);
  process.exit(1);
});
