// static/gmp-client.js — v2 (status filter + type filter + stale notice)
(function(){
  const SHOW_BATCH = 7;
  const BATCH_SIZE = 7;
  const STALE_AFTER_MS = 6 * 60 * 60 * 1000; // 6 hours

  let statusFilter = 'all';
  let typeFilter = 'all';

  function qs(s, el=document){ return el.querySelector(s); }
  function qsa(s, el=document){ return Array.from(el.querySelectorAll(s)); }

  function toggleCard(card){
    const details = card.querySelector('.card-row-details');
    if (!details) return;
    const hidden = details.getAttribute('aria-hidden') === 'true';
    details.setAttribute('aria-hidden', hidden ? 'false' : 'true');
    card.classList.toggle('expanded', hidden);
  }

  function setupCardClicks(){
    qsa('.ipo-card').forEach(card => {
      if (card.dataset.clickBound) return;         // bind once
      card.dataset.clickBound = '1';
      card.addEventListener('click', (e) => {
        if (e.target.closest('.filter-btn') || e.target.id === 'load-more-btn' || e.target.closest('.ipo-link')) return;
        toggleCard(card);
      });
    });
  }

  function matches(card){
    const okStatus = statusFilter === 'all' || card.dataset.status === statusFilter;
    const okType   = typeFilter   === 'all' || card.dataset.type   === typeFilter;
    return okStatus && okType;
  }

  // Apply both filters, hide empty section headings, re-run lazy batching
  function applyFilters(){
    const cards = qsa('#gmp-cards .ipo-card');
    cards.forEach(c => { c.style.display = matches(c) ? '' : 'none'; });

    // hide section headings whose following cards are all hidden
    qsa('#gmp-cards .section-heading').forEach(h => {
      let el = h.nextElementSibling, any = false;
      while (el && !el.classList.contains('section-heading')) {
        if (el.classList.contains('ipo-card') && el.style.display !== 'none') { any = true; break; }
        el = el.nextElementSibling;
      }
      h.style.display = any ? '' : 'none';
    });

    const visible = cards.filter(c => c.style.display !== 'none');
    visible.forEach((c,i) => c.classList.toggle('hidden-by-lazy', i >= SHOW_BATCH));
    const btn = qs('#load-more-btn');
    if (btn) btn.style.display = (visible.length > SHOW_BATCH) ? '' : 'none';
    setupCardClicks();
  }

  function applyLazyLoad(){
    const btn = qs('#load-more-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const hidden = qsa('#gmp-cards .ipo-card.hidden-by-lazy')
        .filter(c => c.style.display !== 'none');
      hidden.slice(0, BATCH_SIZE).forEach(el => el.classList.remove('hidden-by-lazy'));
      const remaining = qsa('#gmp-cards .ipo-card.hidden-by-lazy')
        .filter(c => c.style.display !== 'none');
      if (remaining.length === 0) btn.style.display = 'none';
      setupCardClicks();
    });
    applyFilters(); // initial batching
  }

  function setupFilters(){
    // status buttons: data-filter, excluding type buttons
    qsa('.filter-btn[data-filter]').forEach(b => {
      b.addEventListener('click', () => {
        qsa('.filter-btn[data-filter]').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        statusFilter = b.dataset.filter;
        applyFilters();
      });
    });
    // type buttons: data-type-filter
    qsa('.filter-btn[data-type-filter]').forEach(b => {
      b.addEventListener('click', () => {
        qsa('.filter-btn[data-type-filter]').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        typeFilter = b.dataset.typeFilter;
        applyFilters();
      });
    });
  }

  function setupNextRun() {
    const el = qs('#gmp-next-run');
    if (!el) return;
    function tick() {
      const now = new Date();
      const next = new Date(now);
      next.setMinutes(30,0,0);                       // workflow runs at :30
      if (next <= now) next.setHours(next.getHours()+1);
      const diff = next - now;
      const mins = Math.floor(diff / 60000);
      const secs = Math.floor((diff % 60000) / 1000);
      el.textContent = `${String(mins).padStart(2,'0')}m ${String(secs).padStart(2,'0')}s`;
    }
    tick();
    setInterval(tick, 1000);
  }

  function setupStaleNote(){
    const meta = qs('#gmp-meta');
    const note = qs('#gmp-stale-note');
    if (!meta || !note) return;
    const updated = Date.parse(meta.dataset.updated || '');
    if (!isNaN(updated) && (Date.now() - updated) > STALE_AFTER_MS) {
      note.style.display = '';
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    setupCardClicks();
    applyLazyLoad();
    setupFilters();
    setupNextRun();
    setupStaleNote();
  });
})();
