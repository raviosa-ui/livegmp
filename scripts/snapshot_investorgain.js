'use strict';
/**
 * Read-only. Writes nothing into the pipeline.
 * Dumps the raw feed payload and the normalised records so the shapes can be
 * eyeballed before any adapter code is trusted.
 *
 *   node scripts/snapshot_investorgain.js
 *
 * Outputs (gitignored / artifact-only):
 *   tmp/ig_raw_<month>_<year>.json
 *   tmp/ig_records.json
 *   tmp/ig_report.txt
 */

const fs = require('fs');
const path = require('path');
const ig = require('./sources/investorgain');

const OUT = path.join(process.cwd(), 'tmp');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const lines = [];
  const log = (s) => {
    console.log(s);
    lines.push(s);
  };

  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 + now.getTimezoneOffset()) * 60000);
  const baseMonth = ist.getMonth() + 1;
  const baseYear = ist.getFullYear();

  log(`snapshot at ${now.toISOString()} (IST month ${baseMonth}/${baseYear})`);

  for (const off of [0, 1]) {
    const d = new Date(Date.UTC(baseYear, baseMonth - 1 + off, 1));
    const month = d.getUTCMonth() + 1;
    const year = d.getUTCFullYear();

    log(`\n--- ${month}/${year} ---`);
    log(`fy candidates tried in order: ${ig.fyCandidates(month, year).join(', ')}`);

    let res;
    try {
      res = await ig.fetchMonth(month, year, { verbose: true });
    } catch (e) {
      log(`FAILED: ${e.message}`);
      continue;
    }
    log(`url  : ${res.url}`);
    log(`fy   : ${res.fy}`);
    log(`rows : ${res.rows.length}`);

    fs.writeFileSync(
      path.join(OUT, `ig_raw_${month}_${year}.json`),
      JSON.stringify(res.rows, null, 2)
    );

    if (res.rows.length) {
      log('\nfield names present on row 0:');
      for (const k of Object.keys(res.rows[0])) {
        const v = String(res.rows[0][k]).replace(/\s+/g, ' ').slice(0, 70);
        log(`  ${JSON.stringify(k).padEnd(32)} = ${v}`);
      }
      log('\nfield-name union across all rows:');
      const union = new Set();
      res.rows.forEach((r) => Object.keys(r).forEach((k) => union.add(k)));
      log(`  ${[...union].sort().join(' | ')}`);
    }
  }

  log('\n=== normalised ===');
  try {
    const { records, meta } = await ig.fetchInvestorGain({ verbose: true });
    fs.writeFileSync(path.join(OUT, 'ig_records.json'), JSON.stringify(records, null, 2));
    log(`requests: ${JSON.stringify(meta.requests)}`);
    log(`records : ${records.length} (raw ${meta.rawCount}, skipped ${meta.skipped})`);
    log(`mainboard ${records.filter((r) => r.type === 'Mainboard').length} | ` +
        `sme ${records.filter((r) => r.type === 'SME').length} | ` +
        `type-null ${records.filter((r) => !r.type).length}`);
    log(`gmp null: ${records.filter((r) => r.gmp === null).length}`);
    log(`no openDate: ${records.filter((r) => !r.openDate).length}`);
    log('\nname | type | gmp | pct | peak | open | close | srcStatus | srcSlug');
    for (const r of records) {
      log(
        [r.name, r.type, r.gmp, r.gmpPct, r.peakGmp, r.openDate, r.closeDate,
         r.sourceStatusCode, r.sourceSlug].join(' | ')
      );
    }
    log('\nGMP cells as received (verify the first-rupee-amount rule):');
    for (const r of records.slice(0, 15)) log(`  ${r.name} :: ${r.gmpRaw} -> ${r.gmp}`);
  } catch (e) {
    log(`normalise FAILED: ${e.message}`);
    process.exitCode = 1;
  }

  fs.writeFileSync(path.join(OUT, 'ig_report.txt'), lines.join('\n'));
})();
