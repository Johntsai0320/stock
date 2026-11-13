/* 股癌選股邏輯與全集數索引（EP1–EP711） */
(() => {
  'use strict';

  const CHECK_KEY = 'stockdash:gooaye-check:v1';
  const PAGE_SIZE = 24;

  const $ = (s, r = document) => r.querySelector(s);
  const esc = (str) =>
    String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));

  const gState = {
    view: 'market',
    data: null,
    loading: false,
    filter: 'all',
    query: '',
    limit: PAGE_SIZE,
    check: loadCheck(),
  };

  function loadCheck() {
    try {
      const raw = localStorage.getItem(CHECK_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          ticker: typeof parsed.ticker === 'string' ? parsed.ticker : '',
          checked: parsed.checked && typeof parsed.checked === 'object' ? parsed.checked : {},
        };
      }
    } catch {}
    return { ticker: '', checked: {} };
  }

  function saveCheck() {
    try {
      localStorage.setItem(CHECK_KEY, JSON.stringify(gState.check));
    } catch {}
  }

  function epUrl(n) {
    return `https://whatmkreallysaid.com/episode.html?file=EP${n}`;
  }

  function setView(view) {
    gState.view = view === 'gooaye' ? 'gooaye' : 'market';
    const isG = gState.view === 'gooaye';
    const vMarket = $('#view-market');
    const vGooaye = $('#view-gooaye');
    if (vMarket) vMarket.hidden = isG;
    if (vGooaye) vGooaye.hidden = !isG;

    document.querySelectorAll('.vtab').forEach((btn) => {
      const active = btn.dataset.view === gState.view;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });

    if (isG && !gState.data && !gState.loading) {
      loadData();
    } else if (isG && gState.data) {
      renderLiveBanner(window.__STOCKDASH_QUOTES__ || {});
    }
  }

  async function loadData() {
    gState.loading = true;
    try {
      const res = await fetch('gooaye-data.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      gState.data = await res.json();
      renderAllGooaye();
    } catch (err) {
      const list = $('#gooaye-ep-list');
      if (list) list.innerHTML = `<div class="g-empty">載入股癌資料失敗：${esc(err.message)}</div>`;
    } finally {
      gState.loading = false;
    }
  }

  function renderLiveBanner(quotes) {
    const el = $('#gooaye-live-signal');
    if (!el) return;
    const twii = quotes.TWII;
    const fgi = quotes.FGI;
    const vix = quotes.VIX;

    const hints = [];
    let tone = 'neutral';

    if (fgi && typeof fgi.price === 'number') {
      const v = fgi.price;
      if (v >= 75) {
        tone = 'warn';
        hints.push(`CNN 恐慌貪婪指數 <b>${v.toFixed(1)}（極度貪婪）</b>：留意「人多的地方不要去」（EP705），避開交易室與法人過度擁擠的熱門股，高檔檢查融資水位。`);
      } else if (v <= 25) {
        tone = 'opp';
        hints.push(`CNN 恐慌貪婪指數 <b>${v.toFixed(1)}（極度恐慌）</b>：啟動「損害控制」與分批試單思維（EP169、EP256），觀察長鞭效應是否進入尾聲與優質股錯殺機會。`);
      } else {
        hints.push(`CNN 恐慌貪婪指數 <b>${v.toFixed(1)}</b>：市場情緒中性，聚焦基本面與自由現金流（EP710），不盲目追高。`);
      }
    }

    if (vix && typeof vix.price === 'number') {
      const vx = vix.price;
      if (vx >= 25) {
        tone = 'warn';
        hints.push(`VIX 波動率 <b>${vx.toFixed(2)}</b> 偏高：嚴守「吃筍停損」與現金水位紀律（EP189），降低槓桿、慎防融資斷頭連鎖反應（EP255）。`);
      } else if (vx <= 14) {
        hints.push(`VIX 波動率 <b>${vx.toFixed(2)}</b> 處於低檔平靜區：慎防市場過度樂觀與槓桿型 ETF 盤整損耗（EP260）。`);
      }
    }

    if (twii && typeof twii.price === 'number' && typeof twii.prevClose === 'number') {
      const pct = ((twii.price - twii.prevClose) / twii.prevClose) * 100;
      const pctStr = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
      hints.push(`加權指數現報 <b>${twii.price.toLocaleString('en-US', { maximumFractionDigits: 0 })}</b>（${pctStr}）：若大盤創高但持股連月新高都過不去，執行「新高砍弱股」汰弱留強（EP703）。`);
    }

    if (!hints.length) {
      hints.push('正在同步即時行情… 切換至「即時看盤」或等待報價載入後，此處將自動對應股癌風控提示。');
    }

    el.className = `g-banner tone-${tone}`;
    el.innerHTML = `
      <div class="g-banner-head">
        <span class="g-banner-title">即時盤勢 × 股癌風控雷達</span>
        <span class="badge">${gState.data ? gState.data.meta.range : 'EP1–EP711'}</span>
      </div>
      <ul class="g-banner-list">${hints.map((h) => `<li>${h}</li>`).join('')}</ul>
    `;
  }

  function renderPillars() {
    const wrap = $('#gooaye-pillars');
    if (!wrap || !gState.data) return;
    wrap.innerHTML = gState.data.pillars.map((p) => `
      <article class="g-pillar-card">
        <div class="g-pillar-top">
          <span class="g-tag">${esc(p.tag)}</span>
          <div class="g-ep-chips">
            ${p.eps.map((n) => `<a class="g-ep-chip" href="${epUrl(n)}" target="_blank" rel="noopener noreferrer">EP${n}</a>`).join('')}
          </div>
        </div>
        <h3>${esc(p.title)}</h3>
        <ul>${p.points.map((pt) => `<li>${esc(pt)}</li>`).join('')}</ul>
      </article>
    `).join('');
  }

  function renderChecklist() {
    const wrap = $('#gooaye-checklist');
    const scoreEl = $('#gooaye-check-score');
    const tickerEl = $('#gooaye-ticker');
    if (!wrap || !gState.data) return;

    if (tickerEl && tickerEl.value !== gState.check.ticker) {
      tickerEl.value = gState.check.ticker;
    }

    const items = gState.data.checklist;
    const passed = items.filter((it) => Boolean(gState.check.checked[it.id])).length;
    if (scoreEl) {
      scoreEl.textContent = `${passed} / ${items.length} 通過`;
      scoreEl.className = 'badge ' + (passed >= 5 ? 'live' : passed >= 3 ? 'stale' : '');
    }

    wrap.innerHTML = items.map((it) => {
      const checked = Boolean(gState.check.checked[it.id]);
      return `
        <label class="g-check-item ${checked ? 'is-checked' : ''}">
          <input type="checkbox" data-cid="${esc(it.id)}" ${checked ? 'checked' : ''} />
          <div class="g-check-body">
            <div class="g-check-label">${esc(it.label)}</div>
            <div class="g-check-desc">${esc(it.desc)}</div>
          </div>
        </label>
      `;
    }).join('');
  }

  function renderEras() {
    const wrap = $('#gooaye-eras');
    if (!wrap || !gState.data) return;
    wrap.innerHTML = gState.data.eras.map((e) => `
      <button class="g-era-card" type="button" data-era="${esc(e.year)}" title="點擊篩選 ${esc(e.year)} 年集數">
        <div class="g-era-top">
          <span class="g-era-yr">${esc(e.year)}</span>
          <span class="badge">${esc(e.range)}（${e.count} 集）</span>
        </div>
        <div class="g-era-theme">${esc(e.theme)}</div>
        <p class="g-era-sum">${esc(e.summary)}</p>
      </button>
    `).join('');
  }

  function renderFilters() {
    const wrap = $('#gooaye-filters');
    if (!wrap) return;
    const tabs = [
      { id: 'all', label: '全部' },
      { id: 'classic', label: '經典方法論' },
      { id: '2026', label: '2026' },
      { id: '2025', label: '2025' },
      { id: '2024', label: '2024' },
      { id: '2023', label: '2023' },
      { id: '2022', label: '2022' },
      { id: '2021', label: '2021' },
      { id: '2020', label: '2020' },
    ];
    wrap.innerHTML = tabs.map((t) => `
      <button type="button" class="g-pill ${gState.filter === t.id ? 'active' : ''}" data-filter="${t.id}">${t.label}</button>
    `).join('');
  }

  function getFilteredEpisodes() {
    if (!gState.data) return [];
    const classicSet = new Set(gState.data.classicIds || []);
    const q = gState.query.trim().toLowerCase();
    const epNumQuery = q.replace(/^ep/, '');

    return gState.data.episodes.filter((ep) => {
      if (gState.filter === 'classic' && !classicSet.has(ep.n)) return false;
      if (/^\d{4}$/.test(gState.filter) && !ep.d.startsWith(gState.filter)) return false;
      if (!q) return true;
      if (String(ep.n) === epNumQuery || `ep${ep.n}`.includes(q)) return true;
      return ep.t.toLowerCase().includes(q) || ep.s.toLowerCase().includes(q);
    });
  }

  function renderEpisodes() {
    const list = $('#gooaye-ep-list');
    const countEl = $('#gooaye-ep-count');
    const moreWrap = $('#gooaye-ep-more-wrap');
    if (!list || !gState.data) return;

    const matched = getFilteredEpisodes();
    const classicSet = new Set(gState.data.classicIds || []);
    if (countEl) {
      countEl.textContent = `顯示 ${Math.min(gState.limit, matched.length)} / ${matched.length} 集（總計 ${gState.data.episodes.length} 集）`;
    }

    const slice = matched.slice(0, gState.limit);
    if (!slice.length) {
      list.innerHTML = '<div class="g-empty">找不到符合條件的集數，試試其他關鍵字或年份。</div>';
      if (moreWrap) moreWrap.hidden = true;
      return;
    }

    list.innerHTML = slice.map((ep) => `
      <a class="g-ep-card" href="${epUrl(ep.n)}" target="_blank" rel="noopener noreferrer">
        <div class="g-ep-head">
          <span class="g-ep-num">EP${ep.n}${classicSet.has(ep.n) ? ' ★' : ''}</span>
          <span class="g-ep-date">${esc(ep.d || '未標註日期')}</span>
        </div>
        <h3 class="g-ep-title">${esc(ep.t)}</h3>
        <p class="g-ep-desc">${esc(ep.s)}</p>
      </a>
    `).join('');

    if (moreWrap) {
      moreWrap.hidden = matched.length <= gState.limit;
    }
  }

  function renderAllGooaye() {
    renderLiveBanner(window.__STOCKDASH_QUOTES__ || {});
    renderPillars();
    renderChecklist();
    renderEras();
    renderFilters();
    renderEpisodes();
  }

  function bindEvents() {
    document.querySelectorAll('.vtab').forEach((btn) => {
      btn.addEventListener('click', () => setView(btn.dataset.view));
    });

    window.addEventListener('stockdash:quotes', (e) => {
      if (gState.view === 'gooaye') {
        renderLiveBanner(e.detail || {});
      }
    });

    const checkWrap = $('#gooaye-checklist');
    if (checkWrap) {
      checkWrap.addEventListener('change', (e) => {
        const cb = e.target;
        if (cb && cb.matches('input[type="checkbox"][data-cid]')) {
          gState.check.checked[cb.dataset.cid] = cb.checked;
          saveCheck();
          renderChecklist();
        }
      });
    }

    const tickerEl = $('#gooaye-ticker');
    if (tickerEl) {
      tickerEl.addEventListener('input', () => {
        gState.check.ticker = tickerEl.value;
        saveCheck();
      });
    }

    const resetBtn = $('#gooaye-check-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        gState.check = { ticker: '', checked: {} };
        saveCheck();
        renderChecklist();
      });
    }

    const erasWrap = $('#gooaye-eras');
    if (erasWrap) {
      erasWrap.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-era]');
        if (!btn) return;
        gState.filter = btn.dataset.era;
        gState.limit = PAGE_SIZE;
        renderFilters();
        renderEpisodes();
        $('#g-eps')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }

    const filtersWrap = $('#gooaye-filters');
    if (filtersWrap) {
      filtersWrap.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-filter]');
        if (!btn) return;
        gState.filter = btn.dataset.filter;
        gState.limit = PAGE_SIZE;
        renderFilters();
        renderEpisodes();
      });
    }

    const searchEl = $('#gooaye-search');
    if (searchEl) {
      let timer = null;
      searchEl.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          gState.query = searchEl.value;
          gState.limit = PAGE_SIZE;
          renderEpisodes();
        }, 160);
      });
    }

    const moreBtn = $('#gooaye-ep-more');
    if (moreBtn) {
      moreBtn.addEventListener('click', () => {
        gState.limit += PAGE_SIZE;
        renderEpisodes();
      });
    }
  }

  bindEvents();
})();
