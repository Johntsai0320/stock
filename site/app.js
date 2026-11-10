/* 看盤儀表板 — 純前端
 * 數據流程：
 *  1. 先顯示 localStorage 快取（版本不符或過舊會自動淨化）
 *  2. 讀取同源 data.json（GitHub Actions 每 5 分鐘由 Yahoo / 證交所 / 期交所抓取的真實快照）
 *  3. 瀏覽器端再透過公開 CORS 代理直連 Yahoo Finance（美股/台股/匯率）與期交所 MIS（台指期），取得更即時的報價
 *  所有漲跌點數、百分比與正負號一律由「現價 − 昨收/參考價」即時計算，不沿用任何 API 回傳的漲跌欄位。
 */
(() => {
  'use strict';

  const SCHEMA_VERSION = 3;
  const CACHE_KEY = `stockdash:v${SCHEMA_VERSION}`;
  const CACHE_MAX_AGE = 1000 * 60 * 60 * 18; // 18 小時以上的快取直接丟棄
  const SNAPSHOT_INTERVAL = 30_000; // 每 30 秒自動更新快照
  const LIVE_INTERVAL = 20_000;     // 每 20 秒嘗試抓取即時報價

  const ORDER = {
    tw: ['TWII', '2330', '0050'],
    fut: ['TXF_D', 'TXF_N'],
    usidx: ['DJI', 'GSPC', 'IXIC', 'SOX'],
    us: ['TSM', 'VT', 'QQQM'],
  };
  const META = {
    TWII: { name: '台灣加權指數', symbol: '^TWII', y: '^TWII', tz: 'Asia/Taipei' },
    2330: { name: '台積電', symbol: '2330.TW', y: '2330.TW', tz: 'Asia/Taipei' },
    '0050': { name: '元大台灣50', symbol: '0050.TW', y: '0050.TW', tz: 'Asia/Taipei' },
    TXF_D: { name: '台指期（日盤）', symbol: 'TXF', tz: 'Asia/Taipei' },
    TXF_N: { name: '台指期（夜盤）', symbol: 'TXF', tz: 'Asia/Taipei' },
    DJI: { name: '道瓊工業', symbol: '^DJI', y: '^DJI', tz: 'America/New_York' },
    GSPC: { name: 'S&P 500', symbol: '^GSPC', y: '^GSPC', tz: 'America/New_York' },
    IXIC: { name: '那斯達克', symbol: '^IXIC', y: '^IXIC', tz: 'America/New_York' },
    SOX: { name: '費城半導體', symbol: '^SOX', y: '^SOX', tz: 'America/New_York' },
    TSM: { name: '台積電 ADR', symbol: 'TSM', y: 'TSM', tz: 'America/New_York' },
    VT: { name: 'Vanguard 全世界股票', symbol: 'VT', y: 'VT', tz: 'America/New_York' },
    QQQM: { name: 'Invesco 那斯達克100', symbol: 'QQQM', y: 'QQQM', tz: 'America/New_York' },
    USDTWD: { name: '美元/台幣', symbol: 'TWD=X', y: 'TWD=X', tz: 'Europe/London' },
  };
  const Y2KEY = Object.fromEntries(Object.entries(META).filter(([, m]) => m.y).map(([k, m]) => [m.y, k]));
  // Yahoo 有時回傳 USDTWD=X
  Y2KEY['USDTWD=X'] = 'USDTWD';

  // 公開 CORS 代理（依序嘗試，支援包裝型與直通型）
  const PROXIES = [
    {
      name: 'allorigins',
      build: (u) => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`,
      unwrap: (d) => (d && typeof d.contents === 'string' ? JSON.parse(d.contents) : d),
    },
    {
      name: 'corsproxy.org',
      build: (u) => `https://corsproxy.org/?url=${encodeURIComponent(u)}`,
      unwrap: (d) => d,
    },
    {
      name: 'corseu',
      build: (u) => `https://cors.eu.org/${u}`,
      unwrap: (d) => d,
    },
    {
      name: 'thingproxy',
      build: (u) => `https://thingproxy.freeboard.io/fetch/${u}`,
      unwrap: (d) => d,
    },
    {
      name: 'codetabs',
      build: (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`,
      unwrap: (d) => d,
    },
  ];

  const $ = (s, r = document) => r.querySelector(s);
  const state = {
    quotes: {},
    snapshotAt: 0,
    liveAt: 0,
    liveOk: false,
    futLiveOk: false,
    proxyIdx: 0,
    scheme: localStorage.getItem('stockdash:scheme') || 'tw',
    openKey: null,
    range: '1d',
    charts: null,
  };

  // ---------------- 工具 ----------------
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const num = (v) => {
    if (v === null || v === undefined || v === '' || v === '-') return null;
    const n = Number(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const decimalsFor = (key) => (key === 'USDTWD' ? 3 : key.startsWith('TXF') ? 0 : 2);
  const fmt = (v, d = 2) => (isNum(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
  const fmtVol = (v) => {
    if (!isNum(v) || v <= 0) return '—';
    if (v >= 1e8) return (v / 1e8).toFixed(2) + '億';
    if (v >= 1e4) return (v / 1e4).toFixed(1) + '萬';
    return v.toLocaleString('en-US');
  };
  const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

  /** 核心：由現價與基準價計算漲跌（四捨五入到顯示精度後再判斷正負，避免 -0.00 或錯色） */
  function calc(q) {
    if (!q || !isNum(q.price) || !isNum(q.prevClose) || q.prevClose === 0) return { chg: null, pct: null, dir: 'flat' };
    const d = decimalsFor(q.key);
    const chg = round(q.price - q.prevClose, d);
    const pct = round((chg / q.prevClose) * 100, 2);
    const dir = chg > 0 ? 'up' : chg < 0 ? 'down' : 'flat';
    return { chg: chg === 0 ? 0 : chg, pct: pct === 0 ? 0 : pct, dir };
  }
  const signed = (v, d) => (isNum(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v), d) : '—');
  const arrow = (dir) => (dir === 'up' ? '▲' : dir === 'down' ? '▼' : '■');

  function tzParts(ms, tz) {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' })
      .formatToParts(new Date(ms))
      .reduce((a, x) => ((a[x.type] = x.value), a), {});
    return { date: `${p.year}-${p.month}-${p.day}`, hh: +p.hour % 24, mm: +p.minute, wd: p.weekday };
  }
  const tzOffsetSec = (ms, tz) => {
    const p = tzParts(ms, tz);
    const asUTC = Date.UTC(+p.date.slice(0, 4), +p.date.slice(5, 7) - 1, +p.date.slice(8, 10), p.hh, p.mm);
    return Math.round((asUTC - Math.floor(ms / 60000) * 60000) / 1000);
  };
  const timeStr = (ms, tz = 'Asia/Taipei') =>
    isNum(ms) && ms > 0 ? new Intl.DateTimeFormat('zh-TW', { timeZone: tz, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms)) : '—';
  const ago = (ms) => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return `${s} 秒前`;
    if (s < 3600) return `${Math.round(s / 60)} 分鐘前`;
    return `${Math.round(s / 3600)} 小時前`;
  };

  // ---------------- 市場狀態 ----------------
  function futSessionOpen(key, now = Date.now()) {
    const p = tzParts(now, 'Asia/Taipei');
    const m = p.hh * 60 + p.mm;
    const wd = p.wd; // Mon..Sun
    const weekday = !['Sat', 'Sun'].includes(wd);
    if (key === 'TXF_D') return weekday && m >= 8 * 60 + 45 && m < 13 * 60 + 45;
    // 夜盤 15:00 ~ 次日 05:00（週一 15:00 起，至週六 05:00 止）
    if (m >= 15 * 60) return weekday;
    if (m < 5 * 60) return wd !== 'Sun' && wd !== 'Mon';
    return false;
  }
  function marketStatus(q) {
    if (!q) return { text: '—', cls: '' };
    if (q.stale) return { text: '延遲', cls: 'stale' };
    const now = Date.now();
    if (q.group === 'fut') return futSessionOpen(q.key, now) ? { text: '交易中', cls: 'live' } : { text: '收盤', cls: '' };
    if (q.session && now >= q.session.start && now < q.session.end) return { text: '交易中', cls: 'live' };
    return { text: '已收盤', cls: '' };
  }

  // ---------------- 快取（自動淨化） ----------------
  function purgeOldCaches() {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && /^stockdash:v\d+$/.test(k) && k !== CACHE_KEY) localStorage.removeItem(k);
      }
    } catch {}
  }
  function loadCache() {
    purgeOldCaches();
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (!c || c.version !== SCHEMA_VERSION || Date.now() - c.savedAt > CACHE_MAX_AGE || !c.quotes) {
        localStorage.removeItem(CACHE_KEY);
        return null;
      }
      // 結構檢查：缺基準價的項目一律捨棄，避免以錯誤基準計算漲跌
      for (const [k, q] of Object.entries(c.quotes)) if (!isNum(q.prevClose) || !isNum(q.price)) delete c.quotes[k];
      return c;
    } catch {
      localStorage.removeItem(CACHE_KEY);
      return null;
    }
  }
  let saveTimer = 0;
  function saveCache() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ version: SCHEMA_VERSION, savedAt: Date.now(), snapshotAt: state.snapshotAt, quotes: state.quotes }));
      } catch {}
    }, 500);
  }

  // ---------------- 合併報價 ----------------
  /** 新資料較新（或同時間）才覆寫；歷史 K 線與期貨盤中序列保留較完整者 */
  function mergeQuote(nq, { fromCache = false } = {}) {
    if (!nq || !nq.key) return false;
    const old = state.quotes[nq.key];
    if (!old) {
      state.quotes[nq.key] = { ...nq };
      return true;
    }
    const newer = (nq.time || 0) >= (old.time || 0);
    // 基準價跨日校正：若新資料時間較新且基準不同，以新資料為準（交易日已切換）
    if (!newer && !fromCache) {
      if (nq.daily?.length > (old.daily?.length || 0)) old.daily = nq.daily;
      return false;
    }
    const merged = { ...old, ...nq };
    for (const f of ['daily', 'intraday']) {
      if (!nq[f] || !nq[f].length) merged[f] = old[f] || [];
    }
    if (nq.group === 'fut' && old.intraday?.length && nq.intraday?.length && old.sessionDate === nq.sessionDate) {
      // 合併期貨走勢（去重、依時間排序）
      const map = new Map([...old.intraday, ...nq.intraday].map((p) => [p[0], p]));
      merged.intraday = [...map.values()].sort((a, b) => a[0] - b[0]).slice(-800);
    }
    if (!merged.daily?.length && old.daily?.length) merged.daily = old.daily;
    state.quotes[nq.key] = merged;
    return true;
  }

  // ---------------- 網路 ----------------
  async function fetchWithTimeout(url, opts = {}, ms = 7000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      return await fetch(url, { ...opts, signal: ctl.signal });
    } finally {
      clearTimeout(t);
    }
  }

  async function viaProxy(url, opts = {}, validate = () => true) {
    const n = PROXIES.length;
    for (let i = 0; i < n; i++) {
      const idx = (state.proxyIdx + i) % n;
      const proxy = PROXIES[idx];
      try {
        const fullUrl = proxy.build(url);
        const res = await fetchWithTimeout(fullUrl, { cache: 'no-store', ...opts }, 6000);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const raw = await res.json();
        const j = proxy.unwrap(raw);
        if (!validate(j)) throw new Error('validate failed');
        if (idx !== state.proxyIdx) {
          state.proxyIdx = idx;
          try { localStorage.setItem('stockdash:proxy', idx); } catch {}
        }
        return j;
      } catch (e) {
        // 嘗試下一個代理
      }
    }
    throw new Error('all proxies failed');
  }

  async function loadSnapshot() {
    const res = await fetchWithTimeout(`data.json?t=${Date.now()}`, { cache: 'no-store' }, 8000);
    if (!res.ok) throw new Error('data.json ' + res.status);
    const j = await res.json();
    if (j.version !== SCHEMA_VERSION) throw new Error('schema mismatch');
    const prevSnap = state.snapshotAt;
    state.snapshotAt = j.generatedAt;
    let changed = false;
    for (const q of Object.values(j.quotes || {})) changed = mergeQuote(q) || changed;
    if (j.generatedAt !== prevSnap) changed = true;
    return changed;
  }

  // 證交所 MIS 即時行情（加權指數、台積電、0050）
  async function loadTwseLive() {
    const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw|tse_2330.tw|tse_0050.tw&json=1&delay=0&_=${Date.now()}`;
    const j = await viaProxy(url, {}, (x) => Array.isArray(x?.msgArray) && x.msgArray.length > 0);
    let changed = false;
    for (const it of j.msgArray) {
      let key = null;
      if (it.c === 't00') key = 'TWII';
      else if (it.c === '2330') key = '2330';
      else if (it.c === '0050') key = '0050';
      if (!key) continue;
      const price = num(it.z) || num(it.pz);
      const prevClose = num(it.y);
      if (!isNum(price) || !isNum(prevClose)) continue;
      const time = num(it.tlong) || Date.now();
      const nq = {
        key,
        price,
        prevClose,
        open: num(it.o),
        high: num(it.h),
        low: num(it.l),
        volume: num(it.v),
        time,
        source: '證交所 MIS（即時）',
        stale: false,
      };
      changed = mergeQuote(nq) || changed;
    }
    return changed;
  }

  function parseYahooMeta(key, resp) {
    const m = resp.meta || {};
    const ts = resp.timestamp || [];
    const cl = resp.indicators?.quote?.[0]?.close || [];
    const intraday = [];
    for (let i = 0; i < ts.length; i++) if (cl[i] != null) intraday.push([ts[i] * 1000, cl[i]]);
    const prevClose = isNum(m.previousClose) ? m.previousClose : m.chartPreviousClose;
    if (!isNum(m.regularMarketPrice) || !isNum(prevClose)) return null;
    const q = {
      key,
      price: m.regularMarketPrice,
      prevClose,
      time: (m.regularMarketTime || 0) * 1000,
      intraday,
      source: 'Yahoo Finance（即時）',
    };
    if (m.currentTradingPeriod?.regular) q.session = { start: m.currentTradingPeriod.regular.start * 1000, end: m.currentTradingPeriod.regular.end * 1000 };
    if (isNum(m.regularMarketDayHigh)) q.high = m.regularMarketDayHigh;
    if (isNum(m.regularMarketDayLow)) q.low = m.regularMarketDayLow;
    if (isNum(m.regularMarketVolume)) q.volume = m.regularMarketVolume;
    return q;
  }

  async function loadYahooLive() {
    const syms = Object.values(META).filter((m) => m.y).map((m) => m.y).join(',');
    const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${encodeURIComponent(syms)}&range=1d&interval=5m&_=${Math.floor(Date.now() / 15000)}`;
    const j = await viaProxy(url, {}, (x) => Array.isArray(x?.spark?.result));
    let changed = false;
    for (const r of j.spark.result) {
      const key = Y2KEY[r.symbol];
      const resp = r.response?.[0];
      if (!key || !resp) continue;
      const q = parseYahooMeta(key, resp);
      if (q && q.time >= (state.quotes[key]?.time || 0)) {
        changed = mergeQuote({ ...q, stale: false }) || changed;
      }
    }
    return changed;
  }

  // ---------------- 渲染：卡片 ----------------
  function sparkSVG(q, dir) {
    const pts = (q.intraday || []).filter((p) => isNum(p[1]));
    const W = 108, H = 48, pad = 3;
    if (pts.length < 2) return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"></svg>`;
    const vals = pts.map((p) => p[1]).concat(isNum(q.prevClose) ? [q.prevClose] : []);
    let min = Math.min(...vals), max = Math.max(...vals);
    if (max === min) { max += 1; min -= 1; }
    const t0 = pts[0][0], t1 = pts[pts.length - 1][0] || t0 + 1;
    const x = (t) => pad + ((t - t0) / (t1 - t0 || 1)) * (W - pad * 2);
    const y = (v) => pad + (1 - (v - min) / (max - min)) * (H - pad * 2);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
    const area = `${d}L${x(t1).toFixed(1)},${H}L${x(t0).toFixed(1)},${H}Z`;
    const base = isNum(q.prevClose) ? `<line x1="0" x2="${W}" y1="${y(q.prevClose).toFixed(1)}" y2="${y(q.prevClose).toFixed(1)}" stroke="currentColor" stroke-opacity=".35" stroke-dasharray="2 3"/>` : '';
    const id = `g${q.key}`;
    return `<svg class="spark ${dir}" viewBox="0 0 ${W} ${H}" aria-hidden="true" preserveAspectRatio="none">
      <defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".28"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>
      ${base}<path d="${area}" fill="url(#${id})"/><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }

  function cardHTML(key) {
    const q = state.quotes[key];
    const meta = META[key];
    if (!q) {
      return `<div class="card-head"><div><div class="card-name">${meta.name}</div><div class="card-sym">${meta.symbol}</div></div><span class="badge">載入中</span></div>
        <div class="card-price"><div class="price">00,000.00</div><div class="chg">+000.00 (0.00%)</div></div><svg class="spark"></svg><div class="card-meta">&nbsp;</div>`;
    }
    const d = decimalsFor(key);
    const { chg, pct, dir } = calc(q);
    const st = marketStatus(q);
    const isFut = q.group === 'fut';
    const sym = isFut ? `${(q.symbol || '').replace(/-[FM]$/, '')} · ${q.contract || ''}` : meta.symbol;
    const baseLabel = isFut ? (key === 'TXF_D' ? '昨結' : '參考') : '昨收';
    return `<div class="card-head"><div style="min-width:0"><div class="card-name">${meta.name}</div><div class="card-sym">${sym}</div></div><span class="badge ${st.cls}">${st.text}</span></div>
      <div class="card-price"><div class="price ${dir}">${fmt(q.price, d)}</div>
        <div class="chg ${dir}"><span>${arrow(dir)} ${signed(chg, d)}</span><span class="pct">${signed(pct, 2)}%</span></div></div>
      ${sparkSVG(q, dir)}
      <div class="card-meta"><span>${baseLabel}<b class="num">${fmt(q.prevClose, d)}</b></span><span>高<b class="num">${fmt(q.high, d)}</b></span><span>低<b class="num">${fmt(q.low, d)}</b></span><span>${timeStr(q.time, meta.tz)}</span></div>`;
  }

  const lastPrices = {};
  function renderCards() {
    for (const [g, keys] of Object.entries(ORDER)) {
      const grid = $(`#grid-${g}`);
      for (const key of keys) {
        let el = grid.querySelector(`[data-key="${key}"]`);
        if (!el) {
          el = document.createElement('article');
          el.className = 'card';
          el.dataset.key = key;
          el.tabIndex = 0;
          el.id = `card-${key}`;
          el.setAttribute('role', 'button');
          el.addEventListener('click', () => openSheet(key));
          el.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), openSheet(key)));
          grid.appendChild(el);
        }
        const q = state.quotes[key];
        el.classList.toggle('skeleton', !q);
        el.innerHTML = cardHTML(key);
        if (q && isNum(q.price) && isNum(lastPrices[key]) && q.price !== lastPrices[key]) {
          const cls = q.price > lastPrices[key] ? 'flash-up' : 'flash-down';
          const p = el.querySelector('.price');
          p.classList.add(cls);
        }
        if (q) lastPrices[key] = q.price;
      }
    }
    renderHighlight();
  }

  function renderHighlight() {
    const fx = state.quotes.USDTWD, tsm = state.quotes.TSM, tw = state.quotes['2330'];
    if (fx && isNum(fx.price)) {
      const c = calc(fx);
      $('#fx-value').innerHTML = `<span class="${c.dir}">${fmt(fx.price, 3)}</span>`;
      $('#fx-detail').innerHTML = `<span class="${c.dir}">${arrow(c.dir)} ${signed(c.chg, 3)} (${signed(c.pct, 2)}%)</span> · 昨收 ${fmt(fx.prevClose, 3)}`;
    }
    if (fx && tsm && tw && isNum(fx.price) && isNum(tsm.price) && isNum(tw.price) && tw.price > 0) {
      const perShare = (tsm.price * fx.price) / 5; // 1 ADR = 5 股普通股
      const prem = (perShare / tw.price - 1) * 100;
      const p = round(prem, 2);
      const dir = p > 0 ? 'up' : p < 0 ? 'down' : 'flat';
      $('#adr-value').innerHTML = `<span class="${dir}">${p > 0 ? '溢價 ' : p < 0 ? '折價 ' : ''}${signed(p, 2)}%</span>`;
      $('#adr-detail').textContent = `ADR 換算 ${fmt(perShare, 1)} vs 現股 ${fmt(tw.price, 2)}（匯率 ${fmt(fx.price, 3)}）`;
    }
  }

  function renderStatus() {
    const dot = $('#status-dot'), txt = $('#status-text');
    const now = Date.now();
    const liveFresh = state.liveAt && (now - state.liveAt < 90_000);
    if (liveFresh && (state.liveOk || state.futLiveOk)) {
      dot.className = 'dot ok';
      txt.textContent = `即時連線 · ${new Date(state.liveAt).toLocaleTimeString('zh-TW', { hour12: false })}`;
    } else if (state.snapshotAt) {
      const ageMs = now - state.snapshotAt;
      dot.className = ageMs > 15 * 60_000 ? 'dot warn' : 'dot ok';
      txt.textContent = `定時快照 · ${ago(state.snapshotAt)}`;
    } else if (Object.keys(state.quotes).length) {
      dot.className = 'dot warn';
      txt.textContent = '顯示快取資料';
    } else {
      dot.className = 'dot';
      txt.textContent = '載入中…';
    }
    $('#foot-meta').textContent = state.snapshotAt ? `雲端快照產生時間：${timeStr(state.snapshotAt)}（台北）· 行情自動每分鐘更新` : '';
  }

  function renderAll() {
    renderCards();
    renderStatus();
    if (state.openKey) updateSheet(false);
    saveCache();
  }

  // ---------------- 技術指標 ----------------
  function sma(vals, n) {
    const out = new Array(vals.length).fill(null);
    let s = 0;
    for (let i = 0; i < vals.length; i++) {
      s += vals[i];
      if (i >= n) s -= vals[i - n];
      if (i >= n - 1) out[i] = s / n;
    }
    return out;
  }
  function rsi(vals, n = 14) {
    const out = new Array(vals.length).fill(null);
    if (vals.length <= n) return out;
    let g = 0, l = 0;
    for (let i = 1; i <= n; i++) {
      const d = vals[i] - vals[i - 1];
      if (d >= 0) g += d; else l -= d;
    }
    g /= n; l /= n;
    out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    for (let i = n + 1; i < vals.length; i++) {
      const d = vals[i] - vals[i - 1];
      g = (g * (n - 1) + Math.max(d, 0)) / n;
      l = (l * (n - 1) + Math.max(-d, 0)) / n;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return out;
  }

  /** 日 K 對齊最新報價：最後一根若為同一交易日則以現價校正，否則補上今日 K 棒 */
  function alignedDaily(q, tz) {
    const rows = (q.daily || []).map((r) => ({ date: tzParts(r[0], tz).date, o: r[1], h: r[2], l: r[3], c: r[4] }));
    if (!rows.length || !isNum(q.price) || !q.time) return rows;
    const today = tzParts(q.time, tz).date;
    const last = rows[rows.length - 1];
    if (last.date === today) {
      last.c = q.price;
      last.h = Math.max(last.h, q.price, isNum(q.high) ? q.high : -Infinity);
      last.l = Math.min(last.l, q.price, isNum(q.low) ? q.low : Infinity);
    } else if (today > last.date) {
      rows.push({ date: today, o: isNum(q.open) ? q.open : q.price, h: isNum(q.high) ? q.high : q.price, l: isNum(q.low) ? q.low : q.price, c: q.price });
    }
    return rows;
  }

  // ---------------- 詳細走勢 Bottom Sheet ----------------
  const cssVar = (n) => getComputedStyle(document.body).getPropertyValue(n).trim();
  function hslToHex(str) {
    // lightweight-charts 不支援 color-mix，這裡把 hsl() 轉 hex
    const m = str.match(/hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/);
    if (!m) return str;
    let [h, s, l] = [+m[1], +m[2] / 100, +m[3] / 100];
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))))).toString(16).padStart(2, '0');
    return `#${f(0)}${f(8)}${f(4)}`;
  }
  const colors = () => ({ up: hslToHex(cssVar(state.scheme === 'tw' ? '--red' : '--green')), down: hslToHex(cssVar(state.scheme === 'tw' ? '--green' : '--red')), flat: '#8b93a1' });

  function openSheet(key) {
    state.openKey = key;
    const q = state.quotes[key];
    const hasDaily = q?.daily?.length > 20;
    if (!hasDaily) state.range = '1d';
    for (const b of document.querySelectorAll('#sheet-tabs .tab')) {
      b.disabled = b.dataset.range !== '1d' && !hasDaily;
    }
    $('#sheet').hidden = false;
    $('#sheet-backdrop').hidden = false;
    document.body.style.overflow = 'hidden';
    updateSheet(true);
  }
  function closeSheet() {
    state.openKey = null;
    $('#sheet').hidden = true;
    $('#sheet-backdrop').hidden = true;
    document.body.style.overflow = '';
    destroyCharts();
  }
  function destroyCharts() {
    if (state.charts) {
      state.charts.main.remove();
      state.charts.rsi.remove();
      state.charts = null;
    }
  }

  function updateSheet(rebuild) {
    const key = state.openKey;
    const q = state.quotes[key];
    const meta = META[key];
    if (!q) return;
    const d = decimalsFor(key);
    const { chg, pct, dir } = calc(q);
    $('#sheet-title').textContent = meta.name;
    $('#sheet-sub').textContent = `${q.group === 'fut' ? `${q.contract || ''} ${q.symbol || ''}` : meta.symbol} · ${q.source || ''} · ${timeStr(q.time, meta.tz)}`;
    $('#sheet-price').innerHTML = `<span class="${dir}">${fmt(q.price, d)}</span>`;
    $('#sheet-chg').className = `chg ${dir}`;
    $('#sheet-chg').innerHTML = `<span>${arrow(dir)} ${signed(chg, d)}</span><span class="pct">${signed(pct, 2)}%</span>`;
    for (const b of document.querySelectorAll('#sheet-tabs .tab')) b.setAttribute('aria-selected', String(b.dataset.range === state.range));

    const series = buildSeries(q, meta.tz);
    drawCharts(series, q, rebuild);

    const lastMA = series.ma20.filter((p) => p).pop();
    const lastRSI = series.rsi.filter((p) => p).pop();
    $('#rsi-val').textContent = lastRSI ? lastRSI.value.toFixed(1) + (lastRSI.value >= 70 ? '（超買）' : lastRSI.value <= 30 ? '（超賣）' : '') : '—';
    const amp = isNum(q.high) && isNum(q.low) && isNum(q.prevClose) ? ((q.high - q.low) / q.prevClose) * 100 : null;
    const baseLabel = q.group === 'fut' ? (key === 'TXF_D' ? '昨日結算' : '參考價') : '昨收';
    const stats = [
      ['開盤', fmt(q.open, d)], ['最高', fmt(q.high, d)], ['最低', fmt(q.low, d)], [baseLabel, fmt(q.prevClose, d)],
      ['成交量', fmtVol(q.volume)], ['振幅', isNum(amp) ? amp.toFixed(2) + '%' : '—'],
      [state.range === '1d' ? 'MA20 (5分)' : 'MA20 (日)', lastMA ? fmt(lastMA.value, d) : '—'], ['狀態', marketStatus(q).text],
    ];
    $('#sheet-stats').innerHTML = stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  }

  function buildSeries(q, tz) {
    if (state.range === '1d') {
      const pts = (q.intraday || []).filter((p) => isNum(p[1]));
      const off = pts.length ? tzOffsetSec(pts[pts.length - 1][0], tz) : 0;
      const seen = new Set();
      const line = [];
      for (const p of pts) {
        const t = Math.floor(p[0] / 1000) + off;
        if (seen.has(t)) continue;
        seen.add(t);
        line.push({ time: t, value: p[1] });
      }
      const vals = line.map((p) => p.value);
      const m = sma(vals, 20), r = rsi(vals, 14);
      return {
        kind: 'line', line,
        ma20: line.map((p, i) => (m[i] != null ? { time: p.time, value: m[i] } : null)),
        ma60: [],
        rsi: line.map((p, i) => (r[i] != null ? { time: p.time, value: r[i] } : null)),
      };
    }
    const rows = alignedDaily(q, tz);
    const closes = rows.map((r) => r.c);
    const m20 = sma(closes, 20), m60 = sma(closes, 60), r = rsi(closes, 14);
    const n = { '3m': 63, '6m': 126, '1y': 260 }[state.range] || 126;
    const from = Math.max(0, rows.length - n);
    const sl = (arr) => arr.slice(from);
    return {
      kind: 'candle',
      candles: sl(rows).map((x) => ({ time: x.date, open: x.o, high: x.h, low: x.l, close: x.c })),
      ma20: sl(rows.map((x, i) => (m20[i] != null ? { time: x.date, value: m20[i] } : null))),
      ma60: sl(rows.map((x, i) => (m60[i] != null ? { time: x.date, value: m60[i] } : null))),
      rsi: sl(rows.map((x, i) => (r[i] != null ? { time: x.date, value: r[i] } : null))),
    };
  }

  function drawCharts(s, q, rebuild) {
    const LWC = window.LightweightCharts;
    const mainEl = $('#chart-main'), rsiEl = $('#chart-rsi');
    if (!LWC) {
      mainEl.innerHTML = '<div class="empty-chart">圖表元件載入中…</div>';
      setTimeout(() => state.openKey && updateSheet(true), 600);
      return;
    }
    const c = colors();
    const { dir } = calc(q);
    const lineColor = c[dir];
    const MA20 = '#f2b544', MA60 = '#5ab0f0';
    const empty = s.kind === 'line' ? s.line.length < 2 : s.candles.length < 2;

    if (rebuild || !state.charts || state.charts.kind !== s.kind) {
      destroyCharts();
      mainEl.innerHTML = '';
      rsiEl.innerHTML = '';
      if (empty) {
        mainEl.innerHTML = `<div class="empty-chart">${q.group === 'fut' ? '期貨走勢由雲端排程每 5 分鐘累積，開盤後即會出現' : '尚無走勢資料'}</div>`;
        $('#sheet-legend').innerHTML = '';
        return;
      }
      const base = {
        autoSize: true,
        layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#8b93a1', fontFamily: 'Inter, sans-serif', fontSize: 11 },
        grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(255,255,255,0.05)' } },
        rightPriceScale: { borderVisible: false, minimumWidth: 78 },
        timeScale: { borderVisible: false, timeVisible: s.kind === 'line', secondsVisible: false },
        crosshair: { mode: 0 },
        handleScroll: { vertTouchDrag: false },
      };
      const main = LWC.createChart(mainEl, base);
      const rsiC = LWC.createChart(rsiEl, { ...base, rightPriceScale: { borderVisible: false, minimumWidth: 78, scaleMargins: { top: 0.1, bottom: 0.1 } } });
      let price;
      if (s.kind === 'line') {
        price = main.addAreaSeries({ lineColor, topColor: lineColor + '55', bottomColor: lineColor + '00', lineWidth: 2, priceLineVisible: false });
      } else {
        price = main.addCandlestickSeries({ upColor: c.up, downColor: c.down, borderUpColor: c.up, borderDownColor: c.down, wickUpColor: c.up, wickDownColor: c.down, priceLineVisible: false });
      }
      const ma20 = main.addLineSeries({ color: MA20, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      const ma60 = main.addLineSeries({ color: MA60, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      const rsiS = rsiC.addLineSeries({ color: '#c9a7ff', lineWidth: 1.5, priceLineVisible: false });
      rsiS.createPriceLine({ price: 70, color: 'rgba(255,255,255,0.25)', lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
      rsiS.createPriceLine({ price: 30, color: 'rgba(255,255,255,0.25)', lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
      // 兩圖時間軸同步
      main.timeScale().subscribeVisibleLogicalRangeChange((r) => r && rsiC.timeScale().setVisibleLogicalRange(r));
      state.charts = { kind: s.kind, main, rsi: rsiC, price, ma20, ma60, rsiS, baseLine: null };
    }
    if (empty) return;
    const ch = state.charts;
    if (s.kind === 'line') {
      ch.price.applyOptions({ lineColor, topColor: lineColor + '55', bottomColor: lineColor + '00' });
      ch.price.setData(s.line);
      if (ch.baseLine) ch.price.removePriceLine(ch.baseLine);
      ch.baseLine = isNum(q.prevClose) ? ch.price.createPriceLine({ price: q.prevClose, color: '#8b93a1', lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: q.group === 'fut' ? '參考' : '昨收' }) : null;
    } else {
      ch.price.applyOptions({ upColor: c.up, downColor: c.down, borderUpColor: c.up, borderDownColor: c.down, wickUpColor: c.up, wickDownColor: c.down });
      ch.price.setData(s.candles);
    }
    ch.ma20.setData(s.ma20.filter(Boolean));
    ch.ma60.setData(s.ma60.filter(Boolean));
    ch.rsiS.setData(s.rsi.filter(Boolean));
    if (rebuild) {
      ch.main.timeScale().fitContent();
      ch.rsi.timeScale().fitContent();
    }
    $('#sheet-legend').innerHTML =
      `<span><i style="background:${MA20}"></i>MA20</span>` + (s.ma60.some(Boolean) ? `<span><i style="background:${MA60}"></i>MA60</span>` : '') +
      `<span>${s.kind === 'line' ? '5 分鐘走勢' : '日 K'}</span>`;
  }

  // ---------------- 事件 ----------------
  function applyScheme() {
    document.body.classList.toggle('scheme-tw', state.scheme === 'tw');
    document.body.classList.toggle('scheme-us', state.scheme === 'us');
    $('#scheme-label').textContent = state.scheme === 'tw' ? '台股配色' : '美股配色';
  }
  $('#btn-scheme').addEventListener('click', () => {
    state.scheme = state.scheme === 'tw' ? 'us' : 'tw';
    localStorage.setItem('stockdash:scheme', state.scheme);
    applyScheme();
    if (state.openKey) updateSheet(true);
  });
  $('#btn-refresh').addEventListener('click', () => refreshAll(true));
  $('#fx-card').addEventListener('click', () => openSheet('USDTWD'));
  $('#sheet-close').addEventListener('click', closeSheet);
  $('#sheet-backdrop').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && state.openKey && closeSheet());
  $('#sheet-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (!b || b.disabled) return;
    state.range = b.dataset.range;
    updateSheet(true);
  });
  // 下滑關閉 bottom sheet
  (() => {
    let y0 = null;
    const sheet = $('#sheet');
    sheet.addEventListener('touchstart', (e) => { if (sheet.scrollTop <= 0 && !e.target.closest('.chart-main,.chart-rsi')) y0 = e.touches[0].clientY; }, { passive: true });
    sheet.addEventListener('touchend', (e) => { if (y0 != null && e.changedTouches[0].clientY - y0 > 90) closeSheet(); y0 = null; }, { passive: true });
  })();

  // ---------------- 更新循環 ----------------
  let busy = false;
  async function refreshLive() {
    const tasks = [
      loadTwseLive().then((c) => { state.liveOk = true; return c; }).catch(() => false),
      loadYahooLive().then((c) => { state.liveOk = true; return c; }).catch(() => false),
    ];
    const res = await Promise.all(tasks);
    const anyOk = res.some(Boolean);
    if (state.liveOk) state.liveAt = Date.now();
    return anyOk;
  }

  async function refreshAll(manual = false) {
    if (busy) return;
    busy = true;
    const btn = $('#btn-refresh');
    btn.classList.add('spin');
    try {
      await Promise.allSettled([
        loadSnapshot().catch((e) => console.warn('snapshot', e)),
        refreshLive().catch((e) => console.warn('live', e)),
      ]);
      renderAll();
    } finally {
      busy = false;
      btn.classList.remove('spin');
    }
  }

  // 啟動
  applyScheme();
  const cache = loadCache();
  if (cache) {
    for (const q of Object.values(cache.quotes)) mergeQuote(q, { fromCache: true });
    state.snapshotAt = 0;
  }
  renderAll();
  refreshAll();
  setInterval(() => !document.hidden && loadSnapshot().then(renderAll).catch(() => {}), SNAPSHOT_INTERVAL);
  setInterval(() => !document.hidden && !busy && refreshLive().then(renderAll), LIVE_INTERVAL);
  setInterval(renderStatus, 5_000); // 每 5 秒平滑更新「X 秒前 / X 分鐘前」狀態
  document.addEventListener('visibilitychange', () => !document.hidden && refreshAll());
})();
