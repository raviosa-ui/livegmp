<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Live GMP — Fixed</title>
<style>
  /* Basic layout */
  body { font-family: Inter, Arial, sans-serif; margin:0; background:#fff; color:#111; }
  header { background:#0f1720; color:#fff; padding:22px 16px; text-align:center; font-weight:700; }
  .main { max-width:1000px; margin:24px auto; padding:0 16px 120px; /* padding-bottom keeps content above footer */ min-height: 60vh; }
  /* Ensure sections don't collapse behind footer */
  .content-wrapper { display:block; padding-bottom: 40px; }

  /* Filters / meta row */
  .meta { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; gap:12px; flex-wrap:wrap; }
  .filters { display:flex; gap:8px; }
  .btn { border-radius:18px; padding:6px 12px; background:#111827; color:#fff; border:none; cursor:pointer; }
  .pill { border-radius:14px; padding:6px 10px; font-weight:600; font-size:13px; }

  /* Card list */
  .list { margin-top:18px; display:flex; flex-direction:column; gap:12px; }
  .card { display:flex; justify-content:space-between; align-items:center; padding:12px 16px; border-radius:10px; border:1px solid #e6e6e6; background:#fff; min-height:64px; box-shadow: 0 1px 0 rgba(0,0,0,0.02); }
  .card-left { display:flex; flex-direction:column; gap:6px; }
  .title { font-weight:700; font-size:16px; }
  .sub { font-size:13px; color:#666; display:flex; gap:12px; align-items:center; }
  .gmp { font-weight:700; display:inline-flex; align-items:center; gap:8px; }

  .card-right { display:flex; gap:12px; align-items:center; }
  .status { padding:6px 10px; border-radius:100px; font-weight:700; font-size:13px; color:#fff; }
  .status.active { background:#16a34a; }
  .status.upcoming { background:#f59e0b; color:#111; }
  .status.closed { background:#6b7280; }

  footer { background:#0f1720; color:#fff; padding:18px 16px; text-align:center; position:relative; bottom:0; width:100%; }

  /* responsive */
  @media (max-width:640px){
    .card { flex-direction:column; align-items:flex-start; gap:8px; }
    .card-right { width:100%; justify-content:space-between; }
  }
</style>
</head>
<body>
<header>Live GMP – IPO Grey Market Premium</header>

<main class="main">
  <div class="content-wrapper">
    <div class="meta">
      <div class="filters">
        <button class="btn" data-filter="all">All</button>
        <button class="btn" data-filter="active">Active</button>
        <button class="btn" data-filter="upcoming">Upcoming</button>
        <button class="btn" data-filter="closed">Closed</button>
      </div>

      <div class="meta-right">
        <small id="updatedAt">Last updated: —</small>
        <small id="nextRun" style="margin-left:10px; color:#666;">Next run: —</small>
      </div>
    </div>

    <section>
      <h3>Active IPOs</h3>
      <div id="activeList" class="list"></div>
    </section>

    <section>
      <h3>Upcoming IPOs</h3>
      <div id="upcomingList" class="list"></div>
    </section>

    <section>
      <h3>Closed / Listed</h3>
      <div id="closedList" class="list"></div>
    </section>

    <div style="text-align:center; margin-top:18px;">
      <button class="btn" id="loadMore">Load more</button>
    </div>
  </div>
</main>

<footer>© 2025 LiveGMP.in — IPO Grey Market Premium Updates</footer>

<script>
/*
  Robust CSV-based renderer with header-detection.
  Replace SHEET_CSV_URL with your published sheet CSV
*/
const SHEET_CSV_URL = "SHEET_CSV_URL"; // <-- replace with your sheet CSV export url

// Utility: simple CSV parser supporting quoted fields
function parseCSV(text){
  const rows = [];
  let cur = '', row = [], inQuotes = false;
  for (let i = 0; i < text.length; i++){
    const ch = text[i];
    if (ch === '"' ){
      // if next char is also quote -> escaped quote
      if (inQuotes && text[i+1] === '"') { cur += '"'; i++; continue; }
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes){
      row.push(cur); cur = ''; continue;
    }
    if ((ch === '\n' || ch === '\r') && !inQuotes){
      if (cur !== '' || row.length>0){ row.push(cur); cur=''; rows.push(row); row=[]; }
      // handle \r\n
      if (ch === '\r' && text[i+1] === '\n') i++;
      continue;
    }
    cur += ch;
  }
  if (cur !== '' || row.length>0) { row.push(cur); rows.push(row); }
  return rows;
}

// Map header names (case-insensitive) to canonical keys
function mapHeaders(headers){
  const map = {};
  headers.forEach((h, idx) => {
    const key = (h || '').trim().toLowerCase();
    if (!key) return;
    // normalization: common names to our canonical keys
    if (key.includes('name') || key.includes('company')) map['name'] = idx;
    else if (key.includes('gmp')) map['gmp'] = idx;
    else if (key.includes('kostak')) map['kostak'] = idx;
    else if (key.includes('price') || key.includes('listing price')) map['price'] = idx;
    else if (key.includes('date')) map['date'] = idx;
    else if (key.includes('from') && key.includes('date')) map['start_date'] = idx;
    else if (key.includes('to') && key.includes('date')) map['end_date'] = idx;
    else if (key.includes('status')) map['status'] = idx;
    else if (key.includes('link') || key.includes('url')) map['link'] = idx;
    else {
      // keep other columns accessible by exact header text
      map[key] = idx;
    }
  });
  return map;
}

// Defensive helper: get field value by header canonical name
function getField(row, headerMap, names){
  // names: string or array of possible names
  if (!Array.isArray(names)) names = [names];
  for (const name of names){
    if (headerMap[name] !== undefined){
      const val = row[headerMap[name]];
      if (val !== undefined) return val.trim();
    }
  }
  // fallback: try direct header exact match
  for (const k in headerMap){
    if (names.includes(k)) return row[headerMap[k]]?.trim();
  }
  return '';
}

// Date/status detection: try to infer Active/Upcoming/Closed
function inferStatus(row, headerMap){
  // priority: explicit status column (if present)
  const explicit = getField(row, headerMap, 'status');
  if (explicit){
    const s = explicit.toLowerCase();
    if (s.includes('act')) return 'active';
    if (s.includes('upcom')) return 'upcoming';
    if (s.includes('clos') || s.includes('list')) return 'closed';
  }

  // fallback: parse date or date range
  const dateText = (getField(row, headerMap, ['date','start_date','end_date']) || '').toLowerCase();
  if (!dateText) return 'upcoming'; // no date provided -> assume upcoming

  // if contains 'tba' or '2025' with no day range - treat upcoming
  if (dateText.includes('tba')) return 'upcoming';

  // try to detect ranges like "21-25 Nov", "21 Nov - 25 Nov", "21 Nov 2025"
  const today = new Date();
  const tryParseRange = (txt) => {
    // remove spaces around hyphen
    const cleaned = txt.replace(/\u2013|\u2014/g,'-').replace(/\s*-\s*/g,'-');
    // capture two dates or single date
    const parts = cleaned.split('-').map(p => p.trim());
    const parsed = parts.map(p => parseLooseDate(p, today.getFullYear()));
    if (parsed[0] && parsed[1]) return [parsed[0], parsed[1]];
    if (parsed[0]) return [parsed[0], parsed[0]];
    return null;
  };

  const range = tryParseRange(dateText);
  if (range){
    const [start, end] = range;
    if (!start || !end) return 'upcoming';
    if (today >= start && today <= end) return 'active';
    if (today < start) return 'upcoming';
    return 'closed';
  }

  // final fallback based on keywords
  if (dateText.includes('nov') || dateText.match(/\d{1,2}\s*[a-zA-Z]{3}/)) return 'upcoming';
  return 'upcoming';
}

// Attempt to parse loose human date fragments into Date
function parseLooseDate(fragment, defaultYear){
  fragment = fragment.replace(/\./g,'').trim();
  if (!fragment) return null;
  // if fragment contains only year
  if (/^\d{4}$/.test(fragment)) {
    // return first day of year
    return new Date(Number(fragment),0,1);
  }
  // try parse day and month like "21 Nov" or "21 Nov 2025" or "21 nov 2025"
  const tokens = fragment.split(/\s+/);
  let day = null, month = null, year = defaultYear;
  for (const t of tokens){
    if (/^\d{1,2}$/.test(t) && !day) day = Number(t);
    else if (/^\d{4}$/.test(t)) year = Number(t);
    else {
      const m = monthNameToIndex(t);
      if (m !== null) month = m;
    }
  }
  if (day && month !== null) {
    return new Date(year, month, day);
  }
  // try Date.parse
  const d = Date.parse(fragment);
  if (!isNaN(d)) return new Date(d);
  return null;
}

function monthNameToIndex(s){
  if(!s) return null;
  s = s.toLowerCase();
  const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  for (let i=0;i<months.length;i++){
    if (s.startsWith(months[i])) return i;
  }
  return null;
}

// Render single card into container
function renderCard(container, item){
  const card = document.createElement('div');
  card.className = 'card';
  const left = document.createElement('div'); left.className='card-left';
  const title = document.createElement('div'); title.className='title'; title.textContent = item.name || 'Unnamed';
  const sub = document.createElement('div'); sub.className='sub';

  // GMP / kostak / price shown even if empty with placeholders
  const gmpSpan = document.createElement('div');
  gmpSpan.className = 'gmp';
  gmpSpan.innerHTML = `GMP <strong>${item.gmp || '₹ -'}</strong>`;

  const kostakSpan = document.createElement('div');
  kostakSpan.className = 'kostak'; kostakSpan.textContent = `Kostak: ${item.kostak || '-'}`;

  sub.appendChild(gmpSpan);
  sub.appendChild(kostakSpan);

  left.appendChild(title); left.appendChild(sub);

  const right = document.createElement('div'); right.className='card-right';
  const status = document.createElement('div'); status.className='status ' + (item.status || 'upcoming');
  status.textContent = (item.status || 'upcoming').replace(/^\w/,c => c.toUpperCase());
  const date = document.createElement('div'); date.className='date'; date.textContent = item.date || 'Date: TBA';

  right.appendChild(status); right.appendChild(date);

  // optional view button
  const btn = document.createElement('a'); btn.className='btn'; btn.textContent='View';
  if (item.link) { btn.href = item.link; btn.target='_blank'; }
  else btn.style.pointerEvents='none';
  right.appendChild(btn);

  card.appendChild(left); card.appendChild(right);
  container.appendChild(card);
}

// Main: fetch CSV, parse, map and render
async function loadAndRender(){
  try {
    const res = await fetch(SHEET_CSV_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('Failed to fetch sheet CSV: ' + res.status);
    const text = await res.text();
    const rows = parseCSV(text);
    if (!rows || rows.length < 1) {
      console.warn('Empty CSV');
      return;
    }

    const headers = rows[0].map(h => (h||'').trim());
    const headerMap = mapHeaders(headers);
    const dataRows = rows.slice(1);

    // Build items
    const items = dataRows.map(r => {
      const name = getField(r, headerMap, ['name','company']);
      const gmp = getField(r, headerMap, ['gmp']) || '';
      const kostak = getField(r, headerMap, ['kostak','kostak/gmp']) || '';
      const price = getField(r, headerMap, ['price','listing price']) || '';
      const date = getField(r, headerMap, ['date','start_date']) || '';
      const link = getField(r, headerMap, ['link','url']) || '';
      const status = inferStatus(r, headerMap);
      return { name, gmp, kostak, price, date, link, status, raw: r };
    });

    // clear containers
    const activeList = document.getElementById('activeList');
    const upcomingList = document.getElementById('upcomingList');
    const closedList = document.getElementById('closedList');
    [activeList, upcomingList, closedList].forEach(n => n.innerHTML='');

    // push to lists
    items.forEach(item => {
      if (item.status === 'active') renderCard(activeList, item);
      else if (item.status === 'upcoming') renderCard(upcomingList, item);
      else renderCard(closedList, item);
    });

    // update metadata
    document.getElementById('updatedAt').textContent = 'Last updated: ' + new Date().toLocaleString();
    // sample next run (if you run every hour)
    const next = new Date(Date.now() + 1000*60*60);
    const diff = Math.round((next - Date.now())/1000);
    document.getElementById('nextRun').textContent = 'Next run: ~' + Math.floor(diff/60) + 'm ' + (diff%60) + 's';

  } catch (err){
    console.error(err);
    document.getElementById('updatedAt').textContent = 'Last updated: error';
  }
}

// Attach filter buttons
document.querySelectorAll('[data-filter]').forEach(btn => {
  btn.addEventListener('click', (e) => {
    const f = btn.dataset.filter;
    const sections = { active: 'activeList', upcoming: 'upcomingList', closed: 'closedList' };
    if (f === 'all'){
      document.getElementById('activeList').parentElement.style.display = '';
      document.getElementById('upcomingList').parentElement.style.display = '';
      document.getElementById('closedList').parentElement.style.display = '';
    } else {
      for (const k in sections){
        document.getElementById(sections[k]).parentElement.style.display = (k === f ? '' : 'none');
      }
    }
  });
});

// initial load
loadAndRender();

// optionally refresh every 60 minutes
setInterval(loadAndRender, 1000*60*60);
</script>
</body>
</html>
