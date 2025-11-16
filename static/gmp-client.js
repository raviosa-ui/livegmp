// static/gmp-client.js
(function(){
  const SHOW_BATCH = 7; // how many cards to show initially
  const BATCH_SIZE = 7; // how many to reveal on each "Load more"

  function qs(sel, el=document){ return el.querySelector(sel); }
  function qsa(sel, el=document){ return Array.from(el.querySelectorAll(sel)); }

  function toggleCard(card){
    const details = card.querySelector('.card-row-details');
    if (!details) return;
    const hidden = details.getAttribute('aria-hidden') === 'true';
    details.setAttribute('aria-hidden', hidden ? 'false' : 'true');
    card.classList.toggle('expanded', hidden);
  }

  function setupCardClicks(){
    qsa('.ipo-card').forEach(card => {
      card.addEventListener('click', (e) => {
        // don't toggle when clicking control buttons or the link
        if (e.target.closest('.filter-btn') || e.target.id === 'load-more-btn' || e.target.closest('.ipo-link')) return;
        toggleCard(card);
      });
    });
  }

  function applyLazyLoad(){
    const cards = qsa('#gmp-cards .ipo-card');
    if (cards.length <= SHOW_BATCH) {
      const wrap = qs('#load-more-wrap');
      if (wrap) wrap.style.display = 'none';
      return;
    }
    cards.forEach((c, i) => {
      if (i >= SHOW_BATCH) c.classList.add('hidden-by-lazy');
    });
    const btn = qs('#load-more-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const hidden = qsa('.hidden-by-lazy');
      if (hidden.length === 0) { btn.style.display = 'none'; return; }
      hidden.slice(0, BATCH_SIZE).forEach(el => el.classList.remove('hidden-by-lazy'));
      if (qsa('.hidden-by-lazy').length === 0) btn.style.display = 'none';
      setupCardClicks();
      if (hidden.length > 0) hidden[0].scrollIntoView({behavior:'smooth', block:'start'});
    });
  }

  function setupFilters(){
    const buttons = qsa('.filter-btn');
    buttons.forEach(b => {
      b.addEventListener('click', () => {
        buttons.forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        const filter = b.dataset.filter;
        const cards = qsa('#gmp-cards .ipo-card');
        cards.forEach(c => {
          if (filter === 'all') {
            c.style.display = '';
          } else {
            c.style.display = (c.dataset.status === filter) ? '' : 'none';
          }
        });
        // reapply lazy rules for visible cards
        const visible = qsa('#gmp-cards .ipo-card').filter(x => x.style.display !== 'none');
        visible.forEach((c,i) => {
          c.classList.toggle('hidden-by-lazy', i >= SHOW_BATCH);
        });
        const btn = qs('#load-more-btn');
        if (!btn) return;
        btn.style.display = (visible.length > SHOW_BATCH) ? '' : 'none';
        setupCardClicks();
      });
    });
  }

  function setupNextRun() {
    const nextRunEl = qs('#gmp-next-run');
    if (!nextRunEl) return;
    function updateNextRun() {
      const now = new Date();
      const next = new Date(now);
      next.setMinutes(0,0,0);
      if (next <= now) next.setHours(next.getHours() + 1);
      const diff = next - now;
      const mins = Math.floor(diff / 60000);
      const secs = Math.floor((diff % 60000) / 1000);
      nextRunEl.textContent = `${String(mins).padStart(2,'0')}m ${String(secs).padStart(2,'0')}s`;
    }
    updateNextRun();
    setInterval(updateNextRun, 1000);
  }

  document.addEventListener('DOMContentLoaded', () => {
    setupCardClicks();
    applyLazyLoad();
    setupFilters();
    setupNextRun();
  });
})();
