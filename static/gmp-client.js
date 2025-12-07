document.addEventListener('DOMContentLoaded', () => {
  // Configuration
  const VISIBLE_CHUNK_SIZE = 10;
  let visibleCount = VISIBLE_CHUNK_SIZE;
  
  // Restore filter from session storage or default to 'all'
  let currentFilter = sessionStorage.getItem('gmp_filter') || 'all';

  // DOM Elements
  const container = document.getElementById('gmp-cards');
  const cards = Array.from(document.querySelectorAll('.ipo-card'));
  const loadMoreBtn = document.getElementById('load-more-btn');
  const loadMoreWrap = document.getElementById('load-more-wrap');
  const filterBtns = document.querySelectorAll('.filter-btn');
  const timerEl = document.getElementById('gmp-next-run');

  // --- INITIALIZATION ---
  
  function init() {
    setupFilters();
    setupCards();
    setupLoadMore();
    startTimer();
    
    // Apply initial filter state (UI + Logic)
    applyFilterUI(currentFilter);
    render();
  }

  // --- RENDERING & FILTERING ---

  function render() {
    // 1. Filter the list of cards based on currentFilter
    const filteredCards = cards.filter(card => {
      const status = card.dataset.status;
      if (currentFilter === 'all') return true;
      return status === currentFilter;
    });

    // 2. Hide all cards first
    cards.forEach(card => card.classList.add('hidden-by-lazy'));

    // 3. Show only the visible subset of filtered cards
    const toShow = filteredCards.slice(0, visibleCount);
    toShow.forEach(card => card.classList.remove('hidden-by-lazy'));

    // 4. Update Load More Button visibility
    if (visibleCount >= filteredCards.length) {
      if (loadMoreWrap) loadMoreWrap.style.display = 'none';
    } else {
      if (loadMoreWrap) loadMoreWrap.style.display = 'block';
      const remaining = filteredCards.length - visibleCount;
      if (loadMoreBtn) loadMoreBtn.textContent = `Load More (${remaining})`;
    }
  }

  function applyFilterUI(filterName) {
    filterBtns.forEach(btn => {
      if (btn.dataset.filter === filterName) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  // --- EVENT HANDLERS ---

  function setupFilters() {
    filterBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const newFilter = e.target.dataset.filter;
        
        // Update UI
        applyFilterUI(newFilter);

        // Update State
        currentFilter = newFilter;
        sessionStorage.setItem('gmp_filter', currentFilter); // Persist
        visibleCount = VISIBLE_CHUNK_SIZE; // Reset pagination on filter change

        render();
      });
    });
  }

  function setupCards() {
    if (container) {
      container.addEventListener('click', (e) => {
        // Allow clicking on card header or body, but exclude details text selection
        const card = e.target.closest('.ipo-card');
        const details = e.target.closest('.card-row-details');
        
        if (card && !details) {
          toggleCard(card);
        }
      });
    }
  }

  function toggleCard(card) {
    const details = card.querySelector('.card-row-details');
    if (!details) return;

    const isHidden = details.getAttribute('aria-hidden') === 'true';
    if (isHidden) {
      details.setAttribute('aria-hidden', 'false');
      card.classList.add('expanded');
    } else {
      details.setAttribute('aria-hidden', 'true');
      card.classList.remove('expanded');
    }
  }

  function setupLoadMore() {
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener('click', () => {
        visibleCount += VISIBLE_CHUNK_SIZE;
        render();
      });
    }
  }

  // --- TIMER ---

  function startTimer() {
    if (!timerEl) return;
    
    const update = () => {
      const now = new Date();
      // Countdown to next hour or half-hour (e.g. 2:00, 2:30, 3:00)
      const minutes = now.getMinutes();
      const nextUpdateMin = minutes < 30 ? 30 : 60;
      
      let diffMin = nextUpdateMin - minutes;
      let diffSec = 59 - now.getSeconds();
      
      if (diffMin === 60) diffMin = 0;
      if (diffMin > 0) diffMin -= 1; 

      const mStr = diffMin.toString().padStart(2, '0');
      const sStr = diffSec.toString().padStart(2, '0');
      
      timerEl.textContent = `${mStr}m ${sStr}s`;
    };

    update();
    setInterval(update, 1000);
  }

  // Run only if cards container exists (it won't exist in the 'Loading...' placeholder state)
  if (container) {
    init();
  }
});
