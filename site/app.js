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
  const CACHE_KEY = `stockdash:v${SCHEMA_VERSION}_3`;
  const CACHE_MAX_AGE = 1000 * 60 * 60 * 18; // 18 小時以上的快取直接丟棄
  const SNAPSHOT_INTERVAL = 8_000;  // 每 8 秒自動抓取雲端快照（極速同步）
  const LIVE_INTERVAL = 15_000;     // 每 15 秒嘗試抓取即時報價

  const ORDER = {
    tw: ['TWII', 'TPEX', '2330', '0050', 'VIXTWN'],
    fut: ['TXF_D', 'TXF_N'],
    usidx: ['DJI', 'GSPC', 'IXIC', 'SOX', 'FGI', 'VIX'],
    us: ['TSM', 'VT', 'QQQM'],
  };
  const META = {
    TWII: { name: '台灣加權指數', symbol: '^TWII', y: '^TWII', tz: 'Asia/Taipei' },
    TPEX: { name: '台灣櫃買指數', symbol: 'TPEx', y: 'IX0043.TWO', tz: 'Asia/Taipei' },
    2330: { name: '台積電', symbol: '2330.TW', y: '2330.TW', tz: 'Asia/Taipei' },
    '0050': { name: '元大台灣50', symbol: '0050.TW', y: '0050.TW', tz: 'Asia/Taipei' },
    VIXTWN: { name: '台股恐慌指數', symbol: 'VIXTWN · TAIWAN VIX', tz: 'Asia/Taipei' },
    TXF_D: { name: '台指期（日盤）', symbol: 'TXF', tz: 'Asia/Taipei' },
    TXF_N: { name: '台指期（夜盤）', symbol: 'TXF', tz: 'Asia/Taipei' },
    DJI: { name: '道瓊工業', symbol: '^DJI', y: '^DJI', tz: 'America/New_York' },
    GSPC: { name: 'S&P 500', symbol: '^GSPC', y: '^GSPC', tz: 'America/New_York' },
    IXIC: { name: '那斯達克', symbol: '^IXIC', y: '^IXIC', tz: 'America/New_York' },
    SOX: { name: '費城半導體', symbol: '^SOX', y: '^SOX', tz: 'America/New_York' },
    FGI: { name: 'CNN 恐慌貪婪指數', symbol: 'CNN Fear & Greed', tz: 'America/New_York' },
    VIX: { name: 'VIX 恐慌指數', symbol: '^VIX', y: '^VIX', tz: 'America/Chicago' },
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
  const posNum = (v) => {
    const n = num(v);
    return isNum(n) && n > 0 ? n : null;
  };
  const validVixTwn = (v) => isNum(v) && v > 0 && Math.abs(v) < 9000;
  function sanitizeVixDaily(daily) {
    if (!Array.isArray(daily)) return [];
    const out = [];
    for (const r of daily) {
      if (!Array.isArray(r) || r.length < 5 || !isNum(r[0]) || !validVixTwn(r[4])) continue;
      const c = round(r[4], 2);
      const o = validVixTwn(r[1]) ? round(r[1], 2) : c;
      const h = Math.max(...[validVixTwn(r[2]) ? round(r[2], 2) : null, o, c].filter(isNum));
      const l = Math.min(...[validVixTwn(r[3]) ? round(r[3], 2) : null, o, c].filter(isNum));
      out.push([r[0], o, h, l, c, r[5] ?? 0]);
    }
    return out;
  }
  function sanitizeQuote(q) {
    if (!q || typeof q !== 'object' || !q.key) return null;
    if (q.key === 'VIXTWN') {
      const daily = sanitizeVixDaily(q.daily);
      let intraday = Array.isArray(q.intraday)
        ? q.intraday.filter((p) => Array.isArray(p) && isNum(p[0]) && validVixTwn(p[1]))
        : [];
      if (intraday.length) {
        const latestDate = tzParts(intraday[intraday.length - 1][0], 'Asia/Taipei').date;
        intraday = intraday.filter((p) => tzParts(p[0], 'Asia/Taipei').date === latestDate);
      }
      const lastBar = daily[daily.length - 1] || null;
      const prevBar = daily.length >= 2 ? daily[daily.length - 2] : null;
      if (!validVixTwn(q.price)) {
        if (!lastBar) return null;
        const price = lastBar[4];
        return {
          ...q,
          price,
          prevClose: prevBar ? prevBar[4] : price,
          open: lastBar[1],
          high: lastBar[2],
          low: lastBar[3],
          time: lastBar[0],
          intraday,
          daily,
        };
      }
      const fallback = lastBar || [q.time || 0, q.price, q.price, q.price, q.price];
      return {
        ...q,
        prevClose: validVixTwn(q.prevClose) ? q.prevClose : (prevBar ? prevBar[4] : q.price),
        open: validVixTwn(q.open) ? q.open : fallback[1],
        high: validVixTwn(q.high) ? q.high : fallback[2],
        low: validVixTwn(q.low) ? q.low : fallback[3],
        intraday,
        daily,
      };
    }
    if (q.group !== 'twchip') {
      if (q.group === 'fut') {
        if (isNum(q.price) && q.price <= 0) {
          return { ...q, price: null, open: null, high: null, low: null };
        }
      } else if (q.price != null && (!isNum(q.price) || q.price <= 0)) {
        return null;
      }
    }
    return q;
  }
  const decimalsFor = (key) => (key === 'USDTWD' ? 3 : key === 'FGI' ? 1 : key.startsWith('TXF') ? 0 : 2);

  const fmt = (v, d = 2) => (isNum(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
  const fmtVol = (v, q) => {
    if (!isNum(v) || v <= 0) return '—';
    const key = q?.key;
    if (key === '2330' || key === '0050') {
      const lots = Math.round(v / 1000);
      if (lots >= 1e6) return (lots / 1e4).toFixed(1) + ' 萬張';
      return lots.toLocaleString('en-US') + ' 張';
    }
    if (q?.group === 'fut') return Math.round(v).toLocaleString('en-US') + ' 口';
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
    if (q.session && now >= q.session.start && now < q.session.end) {
      if (q.time && q.time < q.session.start) return { text: '盤前', cls: '' };
      return { text: '交易中', cls: 'live' };
    }
    return { text: '已收盤', cls: '' };
  }

  // ---------------- 快取（自動淨化） ----------------
  function purgeOldCaches() {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && /^stockdash:v[\w.]+$/.test(k) && k !== CACHE_KEY) localStorage.removeItem(k);
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
      // 結構檢查：缺基準價或含異常 0 值的項目一律淨化或捨棄，避免顯示 0 或錯誤漲跌
      for (const [k, q] of Object.entries(c.quotes)) {
        const clean = sanitizeQuote(q);
        if (!clean || !isNum(clean.prevClose) || !isNum(clean.price)) delete c.quotes[k];
        else c.quotes[k] = clean;
      }
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
  const isTwAuthSource = (s) => Boolean(s && /證交所|櫃買|期交所/.test(s));
  const PRICE_INDEX_KEYS = new Set(['TWII', 'DJI', 'GSPC', 'IXIC', 'SOX', 'VIX']);

  /** 新資料較新（或同時間）才覆寫；同日絕不讓 Yahoo 覆蓋證交所/櫃買/期交所權威報價 */
  function mergeQuote(rawNq, { fromCache = false } = {}) {
    const nq = sanitizeQuote(rawNq);
    if (!nq || !nq.key) return false;
    const old = state.quotes[nq.key];
    if (!old) {
      state.quotes[nq.key] = { ...nq };
      return true;
    }
    const tz = nq.tz || old.tz || META[nq.key]?.tz || 'UTC';
    const isSessionSwitched = Boolean(nq.sessionDate && old.sessionDate && nq.sessionDate !== old.sessionDate);
    const nqDay = isNum(nq.time) && nq.time > 0 ? tzParts(nq.time, tz).date : null;
    const oldDay = isNum(old.time) && old.time > 0 ? tzParts(old.time, tz).date : null;

    if (!fromCache && isTwAuthSource(old.source) && nq.source?.includes('Yahoo') && nqDay && oldDay && nqDay <= oldDay) {
      return false;
    }

    const isAuthOverridingYahoo = Boolean(isTwAuthSource(nq.source) && old.source?.includes('Yahoo'));
    const newer = (nq.time || 0) >= (old.time || 0) || isAuthOverridingYahoo || isSessionSwitched;
    if (!newer && !fromCache) {
      let touched = false;
      if (nq.daily?.length > (old.daily?.length || 0)) { old.daily = nq.daily; touched = true; }
      if (nqDay && oldDay && nqDay === oldDay) {
        if (isNum(nq.open) && !isNum(old.open)) { old.open = nq.open; touched = true; }
        if (isNum(nq.turnoverYi) && !isNum(old.turnoverYi)) { old.turnoverYi = nq.turnoverYi; touched = true; }
        if ((nq.key === '2330' || nq.key === '0050') && isNum(nq.volume) && (!isNum(old.volume) || nq.volume > old.volume)) {
          old.volume = nq.volume;
          touched = true;
        }
      }
      return touched;
    }
    if (isSessionSwitched) {
      // 交易日切換（如 15:00 夜盤開盤），以新開盤價、新基準價與新走勢完全替換舊時段
      state.quotes[nq.key] = { ...nq };
      return true;
    }

    const merged = { ...old, ...nq };
    const dayAdvanced = Boolean(nqDay && oldDay && nqDay > oldDay);
    if (dayAdvanced) {
      if (!isNum(nq.open)) merged.open = nq.intraday?.[0]?.[1] ?? null;
      if (!isNum(nq.turnoverYi)) delete merged.turnoverYi;
    } else if (nqDay && oldDay && nqDay === oldDay) {
      if (!isNum(merged.open) && isNum(old.open)) merged.open = old.open;
      if (!isNum(merged.high) && isNum(old.high)) merged.high = old.high;
      if (!isNum(merged.low) && isNum(old.low)) merged.low = old.low;
      if ((nq.key === '2330' || nq.key === '0050') && isNum(old.volume) && isNum(nq.volume)) {
        merged.volume = Math.max(old.volume, nq.volume);
      }
    }

    if (!nq.daily || !nq.daily.length) merged.daily = old.daily || [];

    if (nq.group === 'fut' && old.intraday?.length && nq.intraday?.length && old.sessionDate === nq.sessionDate) {
      const map = new Map([...old.intraday, ...nq.intraday].map((p) => [p[0], p]));
      merged.intraday = [...map.values()].sort((a, b) => a[0] - b[0]).slice(-800);
    } else if (nq.intraday?.length && old.intraday?.length && !dayAdvanced) {
      const sameDayOld = nqDay ? old.intraday.filter((p) => Array.isArray(p) && p[1] != null && tzParts(p[0], tz).date === nqDay) : old.intraday;
      const map = new Map([...sameDayOld, ...nq.intraday].map((p) => [p[0], p]));
      merged.intraday = [...map.values()].sort((a, b) => a[0] - b[0]);
    } else if (!nq.intraday || !nq.intraday.length) {
      if (dayAdvanced) {
        merged.intraday = isNum(nq.price) && isNum(nq.time) ? [[nq.time, nq.price]] : [];
      } else {
        merged.intraday = old.intraday || [];
        if (isNum(nq.price) && isNum(nq.time) && nq.group !== 'twchip') {
          const last = merged.intraday[merged.intraday.length - 1];
          if (!last || nq.time > last[0]) merged.intraday = [...merged.intraday, [nq.time, nq.price]];
        }
      }
    }

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
    const res = await fetchWithTimeout(`data.json?t=${Date.now()}&_r=${Math.random().toString(36).slice(2)}`, {
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
      },
    }, 8000);
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


  function extractTwsePrice(it) {
    const z = posNum(it.z);
    if (z != null) return z;
    const tz = posNum(it.trade?.z);
    if (tz != null) return tz;
    const pz = posNum(it.pz);
    if (pz != null) return pz;
    const b1 = posNum(it.b?.split('_')?.[0]);
    const a1 = posNum(it.a?.split('_')?.[0]);
    if (b1 != null && a1 != null) return (b1 + a1) / 2;
    return b1 ?? a1 ?? null;
  }

  // 證交所 MIS 即時行情（加權指數、櫃買指數、台積電、0050）
  async function loadTwseLive() {
    const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw|otc_o00.tw|tse_2330.tw|tse_0050.tw&json=1&delay=0&_=${Date.now()}`;
    const j = await viaProxy(url, {}, (x) => Array.isArray(x?.msgArray) && x.msgArray.length > 0);
    let changed = false;
    for (const it of j.msgArray) {
      let key = null;
      if (it.c === 't00') key = 'TWII';
      else if (it.c === 'o00') key = 'TPEX';
      else if (it.c === '2330') key = '2330';
      else if (it.c === '0050') key = '0050';
      if (!key) continue;
      const price = extractTwsePrice(it);
      const prevClose = posNum(it.y);
      if (!isNum(price) || price <= 0 || !isNum(prevClose) || prevClose <= 0) continue;
      const time = num(it.tlong) || Date.now();
      const rawVol = num(it.v);
      const volume = (key === '2330' || key === '0050') && isNum(rawVol) ? rawVol * 1000 : rawVol;
      const nq = {
        key,
        price,
        prevClose,
        open: posNum(it.o),
        high: posNum(it.h),
        low: posNum(it.l),
        volume,
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
    for (let i = 0; i < ts.length; i++) if (cl[i] != null && cl[i] > 0) intraday.push([ts[i] * 1000, cl[i]]);
    const prevClose = isNum(m.previousClose) ? m.previousClose : m.chartPreviousClose;
    if (!isNum(m.regularMarketPrice) || m.regularMarketPrice <= 0 || !isNum(prevClose) || prevClose <= 0) return null;
    const q = {
      key,
      price: m.regularMarketPrice,
      prevClose,
      time: (m.regularMarketTime || 0) * 1000,
      intraday,
      source: 'Yahoo Finance（即時）',
    };
    if (m.currentTradingPeriod?.regular) q.session = { start: m.currentTradingPeriod.regular.start * 1000, end: m.currentTradingPeriod.regular.end * 1000 };
    if (isNum(m.regularMarketDayHigh) && m.regularMarketDayHigh > 0) q.high = m.regularMarketDayHigh;
    if (isNum(m.regularMarketDayLow) && m.regularMarketDayLow > 0) q.low = m.regularMarketDayLow;
    if (isNum(m.regularMarketVolume)) q.volume = m.regularMarketVolume;
    return q;
  }

  async function loadYahooLive() {
    const syms = Object.values(META).filter((m) => m.y).map((m) => m.y).join(',');
    const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${encodeURIComponent(syms)}&range=1d&interval=1m&_=${Math.floor(Date.now() / 15000)}`;
    const j = await viaProxy(url, {}, (x) => Array.isArray(x?.spark?.result));
    let changed = false;
    for (const r of j.spark.result) {
      const key = Y2KEY[r.symbol];
      const resp = r.response?.[0];
      if (!key || !resp) continue;
      const q = parseYahooMeta(key, resp);
      if (!q) continue;
      const old = state.quotes[key];
      const tz = old?.tz || META[key]?.tz || 'UTC';
      const nqDay = q.time ? tzParts(q.time, tz).date : null;
      if (isTwAuthSource(old?.source) && old?.time && nqDay && nqDay <= tzParts(old.time, 'Asia/Taipei').date) {
        continue;
      }
      if (PRICE_INDEX_KEYS.has(key) && nqDay && old?.daily?.length) {
        let prevBar = null;
        for (let i = old.daily.length - 1; i >= 0; i--) {
          if (tzParts(old.daily[i][0], tz).date < nqDay) { prevBar = old.daily[i]; break; }
        }
        if (prevBar && prevBar[4] > 0) {
          const dPrev = round(prevBar[4], 2);
          if (key === 'TWII' || Math.abs(dPrev - q.prevClose) <= Math.max(0.5, q.prevClose * 0.0001)) {
            q.prevClose = dPrev;
          }
        }
      }
      if (q.time >= (old?.time || 0)) {
        changed = mergeQuote({ ...q, stale: false }) || changed;
      }
    }
    return changed;
  }

  // ---------------- 渲染：卡片 ----------------
  function sparkSVG(q, dir) {
    const pts = (q.intraday || []).filter((p) => isNum(p[1]) && (q.group === 'twchip' || p[1] > 0) && (q.key !== 'VIXTWN' || validVixTwn(p[1])));
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

  // 恐慌貪婪指數與 VIX 區間判定
  function getFgiZone(v) {
    if (!isNum(v)) return null;
    const score = Math.round(v);
    if (score <= 25) return { idx: 0, label: '極度恐懼', en: 'Extreme Fear', range: '0 – 25', cls: 'z-efear' };
    if (score <= 44) return { idx: 1, label: '恐懼', en: 'Fear', range: '26 – 44', cls: 'z-fear' };
    if (score <= 55) return { idx: 2, label: '中性 / 中立', en: 'Neutral', range: '45 – 55', cls: 'z-neutral' };
    if (score <= 74) return { idx: 3, label: '貪婪', en: 'Greed', range: '56 – 74', cls: 'z-greed' };
    return { idx: 4, label: '極度貪婪', en: 'Extreme Greed', range: '75 – 100', cls: 'z-egreed' };
  }

  function getVixZone(v) {
    if (!isNum(v)) return null;
    if (v < 20) return { idx: 0, label: '常態與相對平穩區間', short: '常態平穩 (10–20)', range: '10 - 20 之間', cls: 'z-vix-low' };
    if (v <= 30) return { idx: 1, label: '警戒區間', short: '警戒區間 (20–30)', range: '20 - 30 之間', cls: 'z-vix-mid' };
    return { idx: 2, label: '高度恐慌區間', short: '高度恐慌 (>30)', range: '超過 30 甚至 40 以上', cls: 'z-vix-high' };
  }

  function getVixTwnZone(v) {
    if (!isNum(v)) return null;
    if (v < 15) return { idx: 0, label: '低波動偏樂觀（留意過熱自滿）', short: '偏樂觀・過熱警戒 (<15)', range: '低於 15（過熱／自滿留意）', cls: 'z-vix-low' };
    if (v < 20) return { idx: 0, label: '市場情緒平穩偏樂觀', short: '情緒平穩 (15–20)', range: '低於 15～20', cls: 'z-vix-low' };
    if (v < 30) return { idx: 1, label: '不確定性升高（波動放大）', short: '不確定性升高 (20–30)', range: '20～30', cls: 'z-vix-mid' };
    if (v < 40) return { idx: 2, label: '恐慌情緒明顯升溫', short: '恐慌升溫 (30–40)', range: '30～40', cls: 'z-vix-elev' };
    return { idx: 3, label: '極度／非理性恐慌', short: '極度恐慌 (≥40)', range: '40 以上', cls: 'z-vix-high' };
  }

  function zoneLegendHTML(key, price) {
    if (key === 'FGI') {
      const z = getFgiZone(price);
      const pct = isNum(price) ? Math.max(0, Math.min(100, price)) : 50;
      const items = [
        [0, '0 – 25：極度恐懼（Extreme Fear）'],
        [1, '26 – 44：恐懼（Fear）'],
        [2, '45 – 55：中性 / 中立（Neutral）'],
        [3, '56 – 74：貪婪（Greed）'],
        [4, '75 – 100：極度貪婪（Extreme Greed）'],
      ];
      return `<div class="zone-box">
        <div class="zone-bar fgi-bar"><i class="zone-pin" style="left:${pct.toFixed(1)}%"></i></div>
        <ul class="zone-list">
          ${items.map(([i, txt]) => `<li class="${z && z.idx === i ? 'active ' + z.cls : ''}">• ${txt}</li>`).join('')}
        </ul>
      </div>`;
    }
    if (key === 'VIX') {
      const z = getVixZone(price);
      const pct = isNum(price) ? Math.max(0, Math.min(100, ((price - 10) / 35) * 100)) : 25;
      const items = [
        [0, '10 - 20 之間：常態與相對平穩區間。'],
        [1, '20 - 30 之間：警戒區間。'],
        [2, '超過 30 甚至 40 以上：高度恐慌區間。'],
      ];
      return `<div class="zone-box">
        <div class="zone-bar vix-bar"><i class="zone-pin" style="left:${pct.toFixed(1)}%"></i></div>
        <ul class="zone-list">
          ${items.map(([i, txt]) => `<li class="${z && z.idx === i ? 'active ' + z.cls : ''}">• ${txt}</li>`).join('')}
        </ul>
      </div>`;
    }
    if (key === 'VIXTWN') {
      const z = getVixTwnZone(price);
      const pct = isNum(price) ? Math.max(0, Math.min(100, ((price - 10) / 40) * 100)) : 20;
      const items = [
        [0, '低於 15～20：市場情緒平穩甚至偏樂觀，預期波動較小；低於 15 留意是否過熱或自滿。'],
        [1, '20～30：市場不確定性升高，消息面干擾增加，波動開始放大。'],
        [2, '30～40：恐慌情緒明顯升溫，通常伴隨大盤回檔或急跌，避險需求增加。'],
        [3, '40 以上：市場進入極度或非理性恐慌，震盪幅度劇烈。'],
      ];
      return `<div class="zone-box">
        <div class="zone-bar vixtwn-bar"><i class="zone-pin" style="left:${pct.toFixed(1)}%"></i></div>
        <ul class="zone-list">
          ${items.map(([i, txt]) => `<li class="${z && z.idx === i ? 'active ' + z.cls : ''}">• ${txt}</li>`).join('')}
        </ul>
      </div>`;
    }
    return '';
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

    let badgeHTML = `<span class="badge ${st.cls}">${st.text}</span>`;
    if (key === 'FGI') {
      const fz = getFgiZone(q.price);
      if (fz) badgeHTML = `<span class="badge zone-badge ${fz.cls}">${fz.label} (${fz.en})</span>`;
    } else if (key === 'VIX') {
      const vz = getVixZone(q.price);
      if (vz) badgeHTML = `<span class="badge zone-badge ${vz.cls}">${vz.short}</span>`;
    } else if (key === 'VIXTWN') {
      const vt = getVixTwnZone(q.price);
      if (vt) badgeHTML = `<span class="badge zone-badge ${vt.cls}">${vt.short}</span>`;
    }

    const timeDisplay = isNum(q.time) && q.time > 0
      ? `<span title="台北時間 ${timeStr(q.time, 'Asia/Taipei')}${meta.tz && meta.tz.startsWith('America/') ? '（美東 ' + timeStr(q.time, 'America/New_York') + '）' : ''}">${timeStr(q.time, 'Asia/Taipei')}</span>`
      : '<span>—</span>';

    const metaRow = key === 'FGI'
      ? `<div class="card-meta"><span>昨收<b class="num">${fmt(q.prevClose, d)}</b></span><span>1週前<b class="num">${fmt(q.prevWeek, d)}</b></span><span>1月前<b class="num">${fmt(q.prevMonth, d)}</b></span>${timeDisplay}</div>`
      : `<div class="card-meta"><span>${baseLabel}<b class="num">${fmt(q.prevClose, d)}</b></span><span>高<b class="num">${fmt(q.high, d)}</b></span><span>低<b class="num">${fmt(q.low, d)}</b></span>${timeDisplay}</div>`;

    return `<div class="card-head"><div style="min-width:0"><div class="card-name">${meta.name}</div><div class="card-sym">${sym}</div></div>${badgeHTML}</div>
      <div class="card-price"><div class="price ${dir}">${fmt(q.price, d)}</div>
        <div class="chg ${dir}"><span>${arrow(dir)} ${signed(chg, d)}</span><span class="pct">${signed(pct, 2)}%</span></div></div>
      ${sparkSVG(q, dir)}
      ${zoneLegendHTML(key, q.price)}
      ${metaRow}`;
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
          if (p) {
            p.classList.remove('flash-up', 'flash-down');
            void p.offsetWidth;
            p.classList.add(cls);
          }
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
    const liveFresh = state.liveAt && (now - state.liveAt < 45_000);
    if (liveFresh && (state.liveOk || state.futLiveOk)) {
      dot.className = 'dot ok';
      txt.textContent = `即時連線 · ${new Date(state.liveAt).toLocaleTimeString('zh-TW', { hour12: false })}`;
    } else if (state.snapshotAt) {
      const ageSec = Math.max(0, Math.round((now - state.snapshotAt) / 1000));
      const ageText = ageSec < 60 ? `${ageSec} 秒前` : `${Math.round(ageSec / 60)} 分鐘前`;
      if (ageSec > 180) {
        dot.className = 'dot warn';
        txt.textContent = `同步延遲 · ${ageText}（點擊重試）`;
      } else {
        dot.className = 'dot ok';
        txt.textContent = `自動同步中 · ${ageText}`;
      }
    } else if (Object.keys(state.quotes).length) {
      dot.className = 'dot warn';
      txt.textContent = '顯示快取資料';
    } else {
      dot.className = 'dot';
      txt.textContent = '載入中…';
    }
    $('#foot-meta').textContent = state.snapshotAt ? `雲端快照產生時間：${timeStr(state.snapshotAt)}（台北）· 行情每分鐘自動更新` : '';
  }

  function renderAll() {
    renderCards();
    renderStatus();
    if (state.openKey) updateSheet(false);
    saveCache();
    window.__STOCKDASH_QUOTES__ = state.quotes;
    window.dispatchEvent(new CustomEvent('stockdash:quotes', { detail: state.quotes }));
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

  function bollingerSeries(vals, n = 20, k = 2) {
    const len = vals.length;
    const mb = sma(vals, n);
    const ub = new Array(len).fill(null);
    const lb = new Array(len).fill(null);
    const pctB = new Array(len).fill(null);
    const bbw = new Array(len).fill(null);
    for (let i = n - 1; i < len; i++) {
      const m = mb[i];
      if (m == null) continue;
      let sq = 0;
      for (let j = i - n + 1; j <= i; j++) {
        const d = vals[j] - m;
        sq += d * d;
      }
      const sd = Math.sqrt(sq / n);
      const u = m + k * sd;
      const l = m - k * sd;
      ub[i] = u;
      lb[i] = l;
      const w = u - l;
      pctB[i] = w > 0 ? (vals[i] - l) / w : 0.5;
      bbw[i] = m > 0 ? (w / m) * 100 : null;
    }
    return { mb, ub, lb, pctB, bbw };
  }

  /** 日 K 對齊最新報價：依交易時區去重排序，最後一根若為同一交易日則以現價校正，否則補上今日 K 棒 */
  function alignedDaily(q, tz) {
    const byDate = new Map();
    const isVixTwn = q.key === 'VIXTWN';
    const okVal = (v) => (isVixTwn ? validVixTwn(v) : isNum(v));
    for (const r of q.daily || []) {
      if (!Array.isArray(r) || r.length < 5 || !isNum(r[0]) || !okVal(r[4])) continue;
      const date = tzParts(r[0], tz).date;
      const o = okVal(r[1]) ? r[1] : r[4];
      const h = okVal(r[2]) ? Math.max(r[2], o, r[4]) : Math.max(o, r[4]);
      const l = okVal(r[3]) ? Math.min(r[3], o, r[4]) : Math.min(o, r[4]);
      byDate.set(date, { date, o, h, l, c: r[4] });
    }
    const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    if (!rows.length || !okVal(q.price) || !q.time) return rows;
    const today = tzParts(q.time, tz).date;
    const last = rows[rows.length - 1];
    if (last.date === today) {
      last.c = q.price;
      last.h = Math.max(last.h, q.price, okVal(q.high) ? q.high : -Infinity);
      last.l = Math.min(last.l, q.price, okVal(q.low) ? q.low : Infinity);
    } else if (today > last.date) {
      const o = okVal(q.open) ? q.open : q.price;
      rows.push({
        date: today,
        o,
        h: Math.max(o, q.price, okVal(q.high) ? q.high : -Infinity),
        l: Math.min(o, q.price, okVal(q.low) ? q.low : Infinity),
        c: q.price,
      });
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
    const hasDaily = q?.daily?.length >= 5;
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
      state.charts.pctb?.remove();
      state.charts.bbw?.remove();
      state.charts = null;
    }
  }

  // ---------------- 均線型態與多空排列、黃金/死亡交叉分析 ----------------
  function analyzeMovingAverages(rows, currentPrice) {
    if (!rows || rows.length < 5) return null;
    const closes = rows.map((r) => r.c);
    const len = closes.length;
    const m5 = sma(closes, 5);
    const m10 = sma(closes, 10);
    const m20 = sma(closes, 20);
    const m60 = sma(closes, 60);
    const m120 = sma(closes, 120);
    const m240 = sma(closes, 240);

    const cur5 = m5[len - 1];
    const cur10 = m10[len - 1];
    const cur20 = m20[len - 1];
    const cur60 = m60[len - 1];
    const cur120 = m120[len - 1];
    const cur240 = m240[len - 1];

    const p = isNum(currentPrice) ? currentPrice : closes[len - 1];
    const calcBias = (ma) => (isNum(ma) && ma !== 0 ? +(((p - ma) / ma) * 100).toFixed(2) : null);

    const mas = {
      ma5: { name: '週線 (5MA)', label: '週線', days: 5, role: '短線強弱與極短線防守線', val: cur5, bias: calcBias(cur5), color: '#f1f5f9' },
      ma10: { name: '雙週線 (10MA)', label: '雙週線', days: 10, role: '短線波段與防守參考', val: cur10, bias: calcBias(cur10), color: '#22d3ee' },
      ma20: { name: '月線 (20MA)', label: '月線', days: 20, role: '波段多空生命線', val: cur20, bias: calcBias(cur20), color: '#f2b544' },
      ma60: { name: '季線 (60MA)', label: '季線', days: 60, role: '中期趨勢分水嶺', val: cur60, bias: calcBias(cur60), color: '#5ab0f0' },
      ma120: { name: '半年線 (120MA)', label: '半年線', days: 120, role: '中長線支撐壓力', val: cur120, bias: calcBias(cur120), color: '#c678dd' },
      ma240: { name: '年線 (240MA)', label: '年線', days: 240, role: '長期牛熊分界線', val: cur240, bias: calcBias(cur240), color: '#4cd964' },
    };

    // 短線 5MA（週線）與 10MA（雙週線）防守判定
    let shortDefense = null;
    if (isNum(cur5) && isNum(cur10)) {
      if (p >= cur5 && p >= cur10) {
        shortDefense = cur5 >= cur10
          ? { label: '守穩 5MA・極短線偏強', cls: 'bull', text: '現價站穩 5MA（週線）與 10MA（雙週線）之上，極短線與短波段防守皆穩健偏多。' }
          : { label: '重返 5MA・10MA 之上', cls: 'bull', text: '現價站上 5MA（週線）與 10MA（雙週線）防守參考，短線止穩轉強，觀察 5MA 能否上穿 10MA。' };
      } else if (p < cur5 && p >= cur10) {
        shortDefense = { label: '破 5MA・守 10MA 防守', cls: 'neutral', text: '跌破 5MA（極短線防守線），短線動能降溫，回測 10MA（雙週線）短線波段防守支撐。' };
      } else if (p >= cur5 && p < cur10) {
        shortDefense = { label: '站上 5MA・測 10MA 壓', cls: 'neutral', text: '重回 5MA（週線）極短線防守線之上，出現止穩契機，上方挑戰 10MA（雙週線）反壓。' };
      } else {
        shortDefense = { label: '跌破 5MA・10MA 防守', cls: 'bear', text: '現價位於 5MA（週線）與 10MA（雙週線）防守線之下，極短線與短波段皆偏弱整理。' };
      }
    } else if (isNum(cur5)) {
      shortDefense = p >= cur5
        ? { label: '站上 5MA 週線', cls: 'bull', text: '現價站穩 5MA（週線）極短線防守線之上。' }
        : { label: '跌破 5MA 週線', cls: 'bear', text: '現價跌破 5MA（週線）極短線防守線，短線轉弱。' };
    }

    // 實際檢查現價與中長期均線位置：切勿在已跌破年線／季線時誤稱下方具支撐
    const midLongList = [
      { key: 'ma60', label: '季線(60MA)', val: cur60 },
      { key: 'ma120', label: '半年線(120MA)', val: cur120 },
      { key: 'ma240', label: '年線(240MA)', val: cur240 },
    ].filter((x) => isNum(x.val));
    const supportMas = midLongList.filter((x) => p >= x.val).map((x) => x.label);
    const pressureMas = midLongList.filter((x) => p < x.val).map((x) => x.label);
    const allMasVals = [cur5, cur10, cur20, cur60, cur120, cur240].filter(isNum);
    const belowAllMas = allMasVals.length >= 2 && allMasVals.every((v) => p < v);
    const belowAnnual = isNum(cur240) && p < cur240;
    const belowQuarter = isNum(cur60) && p < cur60;

    let posSummary = '';
    if (belowAllMas && belowAnnual) {
      posSummary = '現價已跌破年線（240MA）與全數均線，下方已無均線支撐，上方週線至年線全面轉為反壓。';
    } else if (midLongList.length && supportMas.length === 0) {
      posSummary = `現價位於${pressureMas.join('、')}之下，下方無中長期均線支撐，上方均線全數轉為反壓。`;
    } else if (pressureMas.length && supportMas.length) {
      posSummary = `上方受${pressureMas.join('、')}反壓，下方僅餘${supportMas.join('、')}提供支撐觀察。`;
    } else if (supportMas.length) {
      posSummary = `現價仍站穩於${supportMas.join('、')}之上。`;
    }

    // 均線走向（斜率）
    const slopeAt = (arr, cur, lookback) => {
      const idx = Math.max(0, len - 1 - lookback);
      return isNum(cur) && isNum(arr[idx]) ? cur - arr[idx] : 0;
    };
    const slope5 = slopeAt(m5, cur5, 3);
    const slope10 = slopeAt(m10, cur10, 3);
    const slope20 = slopeAt(m20, cur20, 5);
    const slope60 = slopeAt(m60, cur60, 5);

    const orderedAll = [cur5, cur10, cur20, cur60, cur120, cur240].filter(isNum);
    const orderedMidLong = [cur20, cur60, cur120, cur240].filter(isNum);
    const hasShort3 = isNum(cur5) && isNum(cur10) && isNum(cur20);

    const isMonotoneDesc = (arr) => arr.length >= 2 && arr.every((v, i) => i === 0 || arr[i - 1] >= v);
    const isMonotoneAsc = (arr) => arr.length >= 2 && arr.every((v, i) => i === 0 || arr[i - 1] <= v);

    const isFullBull = isMonotoneDesc(orderedAll);
    const isFullBear = isMonotoneAsc(orderedAll);
    const isMidLongBull = isMonotoneDesc(orderedMidLong);
    const isMidLongBear = isMonotoneAsc(orderedMidLong);
    const isShortBull = hasShort3 && cur5 >= cur10 && cur10 >= cur20;
    const isShortBear = hasShort3 && cur5 <= cur10 && cur10 <= cur20;

    let pattern = { type: 'neutral', label: '均線糾結（整理）', cls: 'neutral', desc: '' };

    if (isFullBull) {
      if (belowAnnual) {
        pattern = {
          type: 'bull_broken_240',
          label: '急殺破年線（轉弱警示）',
          cls: 'bear',
          desc: `均線尚未翻空，但${posSummary}`,
        };
      } else if (belowQuarter) {
        pattern = {
          type: 'bull_broken_60',
          label: '均線尚多頭（回破季線）',
          cls: 'neutral',
          desc: `中長均線仍呈多頭順序，惟短線回落跌破季線；${posSummary}`,
        };
      } else if (slope5 > 0 && slope10 > 0 && slope20 > 0) {
        pattern = {
          type: 'bull_strong',
          label: '多頭排列（偏多）',
          cls: 'bull',
          desc: orderedAll.length >= 6
            ? '短中長期均線全數由上而下順序排列（週線 > 雙週線 > 月線 > 季線 > 半年線 > 年線），且由左下往右上揚升發展，呈標準多頭排列（偏多）。'
            : '短期均線全面在長期均線之上且由左下往右上揚升發展，呈多頭排列（偏多）。',
        };
      } else {
        pattern = {
          type: 'bull',
          label: '多頭排列（偏多・震盪）',
          cls: 'bull',
          desc: '各期均線維持多頭順向排列，惟短天期均線（5MA／10MA）走平或微幅收斂，維持偏多震盪整理。',
        };
      }
    } else if (isFullBear) {
      if (slope5 < 0 && slope10 < 0 && slope20 < 0) {
        pattern = {
          type: 'bear_strong',
          label: belowAnnual ? '空頭排列（破年線・偏空）' : '空頭排列（偏空）',
          cls: 'bear',
          desc: (orderedAll.length >= 6
            ? '短中長期均線全數反向蓋頭排列（週線 < 雙週線 < 月線 < 季線 < 半年線 < 年線），且由左上往右下發散，呈標準空頭排列（偏空）。'
            : '短期均線全面在長期均線之下且由左上往右下傾斜發散，呈空頭排列（偏空）。') + (posSummary ? posSummary : ''),
        };
      } else {
        pattern = {
          type: 'bear',
          label: belowAnnual ? '空頭排列（年線下反彈）' : '空頭排列（偏空・反彈）',
          cls: 'bear',
          desc: `短中長期均線仍處空頭排列，惟 5MA／10MA 極短線跌勢收斂；${posSummary}`,
        };
      }
    } else if (isMidLongBull) {
      if (belowAnnual) {
        pattern = {
          type: 'mid_bull_broken_240',
          label: '急跌破年線（中長轉弱）',
          cls: 'bear',
          desc: `中長期均線雖仍未完全翻轉，但${posSummary}`,
        };
      } else if (belowQuarter) {
        pattern = {
          type: 'mid_bull_broken_60',
          label: '跌破季線（波段修正）',
          cls: 'bear',
          desc: `半年線／年線順序尚在，但現價已跌破月線與季線轉弱；${posSummary}`,
        };
      } else {
        pattern = {
          type: 'mid_bull',
          label: '中長多頭（短線修正）',
          cls: 'bull',
          desc: `月線以上中長期均線仍維持多頭排列，惟 5MA（週線）／10MA（雙週線）處於短線回檔；${posSummary}`,
        };
      }
    } else if (isMidLongBear) {
      pattern = {
        type: 'mid_bear',
        label: belowAnnual ? '中長空頭（年線下）' : '中長空頭（短線反彈）',
        cls: 'bear',
        desc: `月線、季線等中長期均線呈空頭蓋頭排列，惟極短線 5MA／10MA 出現止穩試探；${posSummary}`,
      };
    } else if (isShortBull) {
      pattern = {
        type: 'short_bull',
        label: belowAnnual ? '年線下反彈（短線轉多）' : pressureMas.length ? '短線多頭（挑戰中長壓）' : '短線多頭排列（偏多）',
        cls: belowAnnual ? 'neutral' : 'bull',
        desc: `5MA（週線）> 10MA（雙週線）> 20MA（月線）短線均線形成多頭排列，短波段動能轉強；${posSummary}`,
      };
    } else if (isShortBear) {
      if (belowAnnual && belowAllMas) {
        const below240Order = isNum(cur20) && isNum(cur240) && cur20 <= cur240;
        pattern = {
          type: 'bear_below_annual',
          label: below240Order ? '空頭格局（跌破年線・全均線下）' : '空頭修正（跌破年線・偏空）',
          cls: 'bear',
          desc: `${below240Order ? '5MA < 10MA < 月線 < 年線（240MA）且' : '5MA（週線）< 10MA（雙週線）< 月線 < 季線呈空頭發散，且'}${posSummary}`,
        };
      } else if (isNum(cur60) && cur20 <= cur60) {
        pattern = {
          type: 'short_mid_bear',
          label: belowAnnual ? '短中期空頭（跌破年線）' : '短中期空頭（偏空）',
          cls: 'bear',
          desc: `5MA（週線）< 10MA（雙週線）< 月線 < 季線呈短中期偏空發散；${posSummary}`,
        };
      } else {
        pattern = {
          type: 'short_bear',
          label: belowAnnual ? '跌破年線（短線轉空）' : belowQuarter ? '跌破季線（波段轉空）' : '短線修正（短空）',
          cls: 'bear',
          desc: `5MA（週線）與 10MA（雙週線）低於月線呈現短線空頭順序；${posSummary}`,
        };
      }
    } else {
      if (isNum(cur5) && isNum(cur10) && cur5 > cur10 && (!isNum(cur20) || cur5 < cur20)) {
        pattern = {
          type: 'entangled_up',
          label: belowAnnual ? '年線下整理（短線止穩）' : '均線糾結（短線止穩）',
          cls: belowAnnual ? 'bear' : 'neutral',
          desc: `5MA（週線）領先站回 10MA（雙週線）之上出現止穩訊號；${posSummary}`,
        };
      } else if (isNum(cur5) && isNum(cur10) && cur5 < cur10 && slope60 >= 0 && !belowQuarter) {
        pattern = {
          type: 'entangled_down',
          label: '均線糾結（短線承壓）',
          cls: 'neutral',
          desc: `5MA（週線）暫壓於 10MA（雙週線）下方；${posSummary}`,
        };
      } else {
        pattern = {
          type: 'entangled',
          label: belowAnnual ? '年線下空頭震盪' : '均線糾結（整理）',
          cls: belowAnnual ? 'bear' : 'neutral',
          desc: `各期均線交錯整理，依 5MA 與 10MA 防守觀察方向；${posSummary}`,
        };
      }
    }

    // 均線交叉檢測（黃金交叉 / 死亡交叉：納入 5MA × 10MA、5MA × 20MA、10MA × 20MA 與中長均線組合）
    const pairs = [
      { name: '週線 × 雙週線', group: 'short', fast: m5, slow: m10, fName: '週線(5MA)', sName: '雙週線(10MA)' },
      { name: '週線 × 月線', group: 'short', fast: m5, slow: m20, fName: '週線(5MA)', sName: '月線(20MA)' },
      { name: '雙週線 × 月線', group: 'short', fast: m10, slow: m20, fName: '雙週線(10MA)', sName: '月線(20MA)' },
      { name: '月線 × 季線', group: 'mid', fast: m20, slow: m60, fName: '月線(20MA)', sName: '季線(60MA)' },
      { name: '月線 × 半年線', group: 'mid', fast: m20, slow: m120, fName: '月線(20MA)', sName: '半年線(120MA)' },
      { name: '月線 × 年線', group: 'mid', fast: m20, slow: m240, fName: '月線(20MA)', sName: '年線(240MA)' },
      { name: '季線 × 半年線', group: 'mid', fast: m60, slow: m120, fName: '季線(60MA)', sName: '半年線(120MA)' },
      { name: '季線 × 年線', group: 'mid', fast: m60, slow: m240, fName: '季線(60MA)', sName: '年線(240MA)' },
      { name: '半年線 × 年線', group: 'mid', fast: m120, slow: m240, fName: '半年線(120MA)', sName: '年線(240MA)' },
    ];

    const crossEvents = [];
    for (const pair of pairs) {
      for (let i = len - 1; i >= Math.max(1, len - 90); i--) {
        const f0 = pair.fast[i], s0 = pair.slow[i];
        const f1 = pair.fast[i - 1], s1 = pair.slow[i - 1];
        if (f0 == null || s0 == null || f1 == null || s1 == null) continue;
        if (f0 > s0 && f1 <= s1) {
          crossEvents.push({
            pair: pair.name,
            group: pair.group,
            type: 'golden',
            label: '黃金交叉（偏多訊號）',
            cls: 'bull',
            date: rows[i].date,
            daysAgo: len - 1 - i,
            desc: `${pair.fName} 向上穿越 ${pair.sName}，形成黃金交叉（偏多訊號）`,
          });
          break;
        } else if (f0 < s0 && f1 >= s1) {
          crossEvents.push({
            pair: pair.name,
            group: pair.group,
            type: 'death',
            label: '死亡交叉（偏空訊號）',
            cls: 'bear',
            date: rows[i].date,
            daysAgo: len - 1 - i,
            desc: `${pair.fName} 向下穿越 ${pair.sName}，形成死亡交叉（偏空訊號）`,
          });
          break;
        }
      }
    }

    crossEvents.sort((a, b) => a.daysAgo - b.daysAgo);
    const latestCross = crossEvents[0] || null;
    const latestMidCross = crossEvents.find((e) => e.group === 'mid' && e !== latestCross) || null;

    return {
      mas,
      shortDefense,
      pattern,
      latestCross,
      latestMidCross,
      crossEvents,
    };
  }

  function renderCrossBox(ev, prefix = '') {
    if (!ev) return '';
    return `<div class="ma-cross-box ${ev.cls}">
      <span class="ma-cross-tag">${prefix ? prefix + ' · ' : ''}${ev.type === 'golden' ? '✨ 黃金交叉（偏多訊號）' : '⚠️ 死亡交叉（偏空訊號）'}</span>
      <span class="ma-cross-detail">${ev.desc} · <strong>${ev.date}</strong>（${ev.daysAgo === 0 ? '今日發生' : ev.daysAgo + ' 天前'}）</span>
    </div>`;
  }

  function renderMaPanel(diag, d) {
    if (!diag) return '';
    const m = diag.mas;
    const crossHTML = diag.latestCross
      ? renderCrossBox(diag.latestCross, diag.latestMidCross ? '最新交叉' : '')
        + (diag.latestMidCross ? renderCrossBox(diag.latestMidCross, '中長期均線') : '')
      : '';

    const items = [m.ma5, m.ma10, m.ma20, m.ma60, m.ma120, m.ma240].filter((item) => item && isNum(item.val));

    return `<div class="ma-panel">
      <div class="ma-panel-head">
        <div class="ma-panel-title">均線型態與多空指標</div>
        <div class="ma-badges">
          <span class="ma-badge ${diag.pattern.cls}">${diag.pattern.label}</span>
          ${diag.shortDefense ? `<span class="ma-badge ${diag.shortDefense.cls}">${diag.shortDefense.label}</span>` : ''}
          ${diag.latestCross ? `<span class="ma-badge ${diag.latestCross.cls}">${diag.latestCross.type === 'golden' ? '黃金交叉' : '死亡交叉'}</span>` : ''}
        </div>
      </div>
      <p class="ma-desc">${diag.pattern.desc}${diag.shortDefense ? `<span class="ma-short-note">${diag.shortDefense.text}</span>` : ''}</p>
      ${crossHTML}
      <div class="ma-grid">
        ${items
          .map(
            (item) => `<div class="ma-item">
            <div class="ma-name"><i style="background:${item.color}"></i>${item.name}</div>
            <div class="ma-val">${fmt(item.val, d)}</div>
            <div class="ma-bias ${item.bias >= 0 ? 'up' : 'down'}">乖離 ${signed(item.bias, 2)}%</div>
            ${item.role ? `<div class="ma-role">${item.role}</div>` : ''}
          </div>`
          )
          .join('')}
      </div>
    </div>`;
  }

  // ---------------- 布林極限 %b 與帶寬 BBW 真假突破分析 ----------------
  function analyzeBollinger(rows, currentPrice) {
    if (!rows || rows.length < 22) return null;
    const closes = rows.map((r) => r.c);
    const len = closes.length;
    if (isNum(currentPrice) && currentPrice > 0) closes[len - 1] = currentPrice;
    const bb = bollingerSeries(closes, 20, 2);
    const last = len - 1;
    const prev1 = len - 2;
    const prev2 = len - 3;
    const pctB = bb.pctB[last];
    const curBbw = bb.bbw[last];
    const ub = bb.ub[last];
    const mb = bb.mb[last];
    const lb = bb.lb[last];
    if (!isNum(pctB) || !isNum(curBbw) || !isNum(ub) || !isNum(mb) || !isNum(lb)) return null;

    const prev1PctB = bb.pctB[prev1];
    const prev1Bbw = bb.bbw[prev1];
    const prev2Bbw = prev2 >= 0 ? bb.bbw[prev2] : null;
    const bbwChg = isNum(prev1Bbw) ? curBbw - prev1Bbw : 0;
    const bbwRel = isNum(prev1Bbw) && prev1Bbw > 0 ? bbwChg / prev1Bbw : 0;
    const flare = isNum(bb.ub[prev1]) && isNum(bb.lb[prev1]) && ub > bb.ub[prev1] && lb < bb.lb[prev1];
    const converging = isNum(bb.ub[prev1]) && isNum(bb.lb[prev1]) && ub <= bb.ub[prev1] && lb >= bb.lb[prev1];
    const bbwExpanding = isNum(prev1Bbw) && bbwChg > 0 && (bbwRel >= 0.015 || (isNum(prev2Bbw) && curBbw > prev1Bbw && prev1Bbw > prev2Bbw));
    const bbwStreakUp = isNum(prev1Bbw) && isNum(prev2Bbw) && curBbw > prev1Bbw && prev1Bbw > prev2Bbw;

    const winStart = Math.max(0, len - 120);
    const validWin = bb.bbw.slice(winStart).filter(isNum);
    const sortedWin = [...validWin].sort((a, b) => a - b);
    const bbwLow120 = sortedWin[0] ?? curBbw;
    const bbwHigh120 = sortedWin[sortedWin.length - 1] ?? curBbw;
    const squeezeThresh = sortedWin[Math.floor((sortedWin.length - 1) * 0.25)] ?? curBbw;
    const rank120 = validWin.length ? (validWin.filter((v) => v <= curBbw).length / validWin.length) * 100 : 50;

    let minRecentRank = rank120;
    for (let k = Math.max(20, len - 9); k < last; k++) {
      const bk = bb.bbw[k];
      if (!isNum(bk)) continue;
      const w = bb.bbw.slice(Math.max(0, k - 119), k + 1).filter(isNum);
      if (w.length) {
        const rk = (w.filter((v) => v <= bk).length / w.length) * 100;
        if (rk < minRecentRank) minRecentRank = rk;
      }
    }
    const wasSqueezed = rank120 <= 25 || minRecentRank <= 30;

    let scenarioKey = 'mid_bear';
    let label = '通道內偏空（%b < 0.5）';
    let cls = 'bear';
    let desc = '目前 %b 低於 0.5（中軌下方），代表處於偏弱格局；靜待 BBW 壓縮蓄勢後再觀察方向表態。';

    const quickPullback = isNum(prev1PctB) && prev1PctB >= 1.0 && pctB < 0.8 && (bbwChg <= 0 || bbwRel < 0.015);

    if (pctB >= 0.8 && (bbwExpanding || (flare && bbwChg > 0))) {
      scenarioKey = 'true_up';
      label = '真突破（有效起漲）';
      cls = 'bull';
      desc = `%b=${pctB.toFixed(2)} 衝破強勢區，且 BBW 同步放大（日變動 ${signed(bbwChg, 2)}%${flare ? '、上下軌同步張開' : ''}），${wasSqueezed ? '由低檔壓縮啟動，' : ''}多頭動能與波動率齊升，可順勢偏多看待。`;
    } else if (quickPullback || (pctB >= 0.9 && !bbwExpanding && (!flare || bbwChg <= 0))) {
      scenarioKey = 'false_up';
      label = '假突破（誘多拉回）';
      cls = 'warn';
      desc = quickPullback
        ? `前日 %b 曾突破 1.0 上軌，但今日立刻跌回 ${pctB.toFixed(2)} (< 0.8) 且 BBW ${bbwChg <= 0 ? '走平/收窄' : '擴張不足'}，符合假突破特徵，須留意拉回並執行停損。`
        : `%b=${pctB.toFixed(2)} 雖觸及或逼近上軌 1.0，但 BBW 走平或未見明顯擴張（${converging ? '上軌下彎、下軌上揚收斂' : `日變動 ${signed(bbwChg, 2)}%`}），缺乏波動支撐，慎防假突破誘多拉回。`;
    } else if (pctB <= 0.2 && (bbwExpanding || (flare && bbwChg > 0))) {
      scenarioKey = 'true_down';
      label = '真跌破（有效起跌）';
      cls = 'bear';
      desc = `%b=${pctB.toFixed(2)} 急跌破 ${pctB < 0 ? '0 下軌' : '0.2 弱勢區'}，且 BBW 明顯拐頭放大（日變動 ${signed(bbwChg, 2)}%${flare ? '、上下軌同步張開' : ''}），空方動能與賣壓湧現，應避開逆勢接刀。`;
    } else if ((pctB < 0 || (isNum(prev1PctB) && prev1PctB < 0 && pctB >= 0 && pctB < 0.35)) && !bbwExpanding && (!flare || bbwChg <= 0)) {
      scenarioKey = 'false_down';
      label = '假跌破（誘空反彈）';
      cls = 'neutral';
      desc = `%b=${pctB.toFixed(2)} ${pctB < 0 ? '短暫跌破 0 下軌' : '已由下軌外站回 0 以上'}，但 BBW 維持低檔走平或高檔收斂（日變動 ${signed(bbwChg, 2)}%），賣壓缺乏持續性，屬洗盤誘空格局，站穩 %b ≥ 0 易迎反彈。`;
    } else if (rank120 <= 25) {
      scenarioKey = 'squeeze';
      label = 'BBW 壓縮蓄勢（Squeeze）';
      cls = 'neutral';
      desc = `BBW 降至近 ${validWin.length} 根第 ${rank120.toFixed(0)}% 低分位（通道極度收窄），市場正在蓄勢待機，靜待 %b > 1.0 或 < 0 搭配 BBW「V 型反轉向上」同步表態。`;
    } else if (pctB >= 0.5) {
      scenarioKey = 'mid_bull';
      label = '通道內偏多（%b ≥ 0.5）';
      cls = 'bull';
      desc = `收盤位於 20MA 中軌上方（%b=${pctB.toFixed(2)} ≥ 0.5 多空分水嶺），多方占優；目前 BBW 日變動 ${signed(bbwChg, 2)}%（分位 ${rank120.toFixed(0)}%），留意是否進入上軌真突破或壓縮蓄勢。`;
    }

    const watershed = pctB >= 0.5
      ? { label: '%b ≥ 0.5（多方優勢）', cls: 'bull' }
      : { label: '%b < 0.5（空方劣勢）', cls: 'bear' };

    const steps = [
      {
        title: '1. BBW 壓縮期 (Squeeze)',
        state: rank120 <= 25 ? 'is-on' : wasSqueezed ? 'is-on' : '',
        status: rank120 <= 25 ? '壓縮蓄勢中' : wasSqueezed ? '近期曾壓縮' : `分位 ${rank120.toFixed(0)}%`,
        detail: rank120 <= 25
          ? `BBW ${curBbw.toFixed(2)}% 落於近 ${validWin.length} 日前 25% 極窄區（門檻 ≤ ${squeezeThresh.toFixed(2)}%），變盤前兆。`
          : wasSqueezed
            ? `近 8 日曾降至第 ${minRecentRank.toFixed(0)}% 低分位（目前回升至 ${rank120.toFixed(0)}%），符合壓縮後起爆條件。`
            : `目前 BBW 位於近 ${validWin.length} 日第 ${rank120.toFixed(0)}% 分位（區間 ${bbwLow120.toFixed(2)}%～${bbwHigh120.toFixed(2)}%）。`,
      },
      {
        title: '2. 雙指標同步表態',
        state: (scenarioKey === 'true_up' || scenarioKey === 'true_down') ? 'is-on' : (scenarioKey === 'false_up' ? 'is-warn' : ''),
        status: scenarioKey === 'true_up' ? '同步向上突破' : scenarioKey === 'true_down' ? '同步向下跌破' : scenarioKey === 'false_up' ? '波動未跟上' : '等待表態',
        detail: flare
          ? `上軌走升、下軌走降同步張開，%b=${pctB.toFixed(2)} 與 BBW（${signed(bbwChg, 2)}%）同向擴張。`
          : `BBW 日變動 ${signed(bbwChg, 2)}%（${converging ? '通道收斂中' : bbwChg > 0 ? '單邊略擴' : '走平或縮窄'}），目前 %b=${pctB.toFixed(2)}。`,
      },
      {
        title: '3. 後續 2～3 根延續性',
        state: (pctB >= 0.8 && bbwStreakUp) || (pctB <= 0.2 && bbwStreakUp) ? 'is-on' : quickPullback ? 'is-warn' : '',
        status: quickPullback ? '假突破停損警訊' : bbwStreakUp && pctB >= 0.8 ? '強勢沿上軌續漲' : bbwStreakUp && pctB <= 0.2 ? '賣壓連擴勿接刀' : '持續追蹤',
        detail: quickPullback
          ? '前日突破 1.0 後今日 %b 跌回 0.8 下且 BBW 未續擴，應判定假突破執行停損。'
          : bbwStreakUp && pctB >= 0.8
            ? 'BBW 連續走高且 %b 站穩 0.8 以上，確認真突破延續動能。'
            : bbwStreakUp && pctB <= 0.2
              ? 'BBW 連續擴大且 %b 貼近下軌 0.2 以下，跌勢動能延續中。'
              : '真突破後須觀察 2～3 根內 BBW 續升且 %b 守住 0.8；跌破即防假突破。',
      },
    ];

    return {
      pctB,
      curBbw,
      bbwChg,
      rank120,
      bbwLow120,
      bbwHigh120,
      squeezeThresh,
      ub,
      mb,
      lb,
      flare,
      watershed,
      scenarioKey,
      label,
      cls,
      desc,
      steps,
    };
  }

  function renderBbPanel(bb, d) {
    if (!bb) return '';
    const rows = [
      { key: 'true_up', name: '真突破（有效起漲）', pb: '快速衝破 0.8 ～ 1.0 以上', bw: '從低檔極度收窄明顯拐頭向上放大', act: '盤整結束、上下軌張開，多頭動能強勁偏多看待。' },
      { key: 'false_up', name: '假突破（誘多拉回）', pb: '短暫觸及或微幅突破 1.0', bw: '處於高檔走平，或甚至向下收斂', act: '波動未跟上（收斂末期），極易迅速跌回通道內。' },
      { key: 'true_down', name: '真跌破（有效起跌）', pb: '快速跌破 0.2 ～ 0 以下', bw: '從低檔收窄處明顯拐頭向上放大', act: '恐慌賣壓湧現、上下軌同步擴張，應避開接刀。' },
      { key: 'false_down', name: '假跌破（誘空反彈）', pb: '短暫跌破 0', bw: '維持低檔走平或高檔收斂', act: '賣壓缺乏持續性，站回 0 以上時容易迎來反彈。' },
    ];
    return `<div class="ma-panel">
      <div class="ma-panel-head">
        <div class="ma-panel-title">布林通道 BB %b × BBW 真假突破診斷</div>
        <div class="ma-badges">
          <span class="ma-badge ${bb.cls}">${bb.label}</span>
          <span class="ma-badge ${bb.watershed.cls}">${bb.watershed.label}</span>
          ${bb.rank120 <= 25 ? '<span class="ma-badge neutral">Squeeze 壓縮低檔</span>' : ''}
        </div>
      </div>
      <p class="ma-desc">${bb.desc}</p>
      <div class="bb-grid">
        <div class="ma-item">
          <div class="ma-name">BB %b (20,2)</div>
          <div class="ma-val ${bb.pctB >= 0.5 ? 'up' : 'down'}">${bb.pctB.toFixed(2)} <small style="font-weight:500;font-size:.74rem">(${(bb.pctB * 100).toFixed(0)}%)</small></div>
          <div class="bb-sub">${bb.pctB > 1 ? '突破上軌 (>1.0)' : bb.pctB < 0 ? '跌破下軌 (<0)' : bb.pctB >= 0.5 ? '中軌上偏多 (≥0.5)' : '中軌下偏空 (<0.5)'}</div>
        </div>
        <div class="ma-item">
          <div class="ma-name">BBW 布林帶寬</div>
          <div class="ma-val">${bb.curBbw.toFixed(2)}%</div>
          <div class="bb-sub ${bb.bbwChg >= 0 ? 'up' : 'down'}">日變動 ${signed(bb.bbwChg, 2)}% · ${bb.flare ? '上下軌張開' : bb.bbwChg > 0 ? '溫和放大' : '收窄走平'}</div>
        </div>
        <div class="ma-item">
          <div class="ma-name">120 日波動壓縮分位</div>
          <div class="ma-val">${bb.rank120.toFixed(0)}%</div>
          <div class="bb-sub">低檔壓縮線 ≤ ${bb.squeezeThresh.toFixed(2)}%（範圍 ${bb.bbwLow120.toFixed(1)}～${bb.bbwHigh120.toFixed(1)}%）</div>
        </div>
        <div class="ma-item">
          <div class="ma-name">布林三軌價位</div>
          <div class="ma-val" style="font-size:.82rem">${fmt(bb.ub, d)} / ${fmt(bb.lb, d)}</div>
          <div class="bb-sub">上軌 ${fmt(bb.ub, d)} · 中軌 ${fmt(bb.mb, d)} · 下軌 ${fmt(bb.lb, d)}</div>
        </div>
      </div>
      <div class="bb-steps">
        ${bb.steps.map((st) => `<div class="bb-step ${st.state}">
          <div class="bb-step-head"><span>${st.title}</span><span>${st.status}</span></div>
          <div>${st.detail}</div>
        </div>`).join('')}
      </div>
      <details class="bb-guide">
        <summary>展開：真突破 vs. 假突破判讀對照表與抓突破 3 步驟</summary>
        <div class="bb-guide-wrap">
          <table class="bb-guide-table">
            <thead>
              <tr><th>市場情境</th><th>%b 表現（位置）</th><th>BBW 表現（波動率）</th><th>盤面意義與操作判讀</th></tr>
            </thead>
            <tbody>
              ${rows.map((r) => `<tr class="${bb.scenarioKey === r.key ? 'is-cur' : ''}">
                <td><strong>${r.name}</strong></td><td>${r.pb}</td><td>${r.bw}</td><td>${r.act}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </details>
    </div>`;
  }

  function updateSheet(rebuild) {
    const key = state.openKey;
    const q = state.quotes[key];
    const meta = META[key];
    if (!q) return;
    const d = decimalsFor(key);
    const { chg, pct, dir } = calc(q);
    const tz = q.tz || meta.tz || 'UTC';
    const tzNote = meta.tz && meta.tz.startsWith('America/')
      ? `台北 ${timeStr(q.time, 'Asia/Taipei')}（美東 ${timeStr(q.time, 'America/New_York')}）`
      : timeStr(q.time, 'Asia/Taipei');
    $('#sheet-title').textContent = meta.name;
    $('#sheet-sub').textContent = `${q.group === 'fut' ? `${q.contract || ''} ${q.symbol || ''}` : meta.symbol} · ${q.source || ''} · ${tzNote}`;
    const btBtn = $('#sheet-bt-btn');
    if (btBtn) {
      btBtn.hidden = !(Array.isArray(q.daily) && q.daily.length >= 30 && key !== 'FGI');
    }
    $('#sheet-price').innerHTML = `<span class="${dir}">${fmt(q.price, d)}</span>`;
    $('#sheet-chg').className = `chg ${dir}`;
    $('#sheet-chg').innerHTML = `<span>${arrow(dir)} ${signed(chg, d)}</span><span class="pct">${signed(pct, 2)}%</span>`;
    for (const b of document.querySelectorAll('#sheet-tabs .tab')) b.setAttribute('aria-selected', String(b.dataset.range === state.range));

    const series = buildSeries(q, tz);
    drawCharts(series, q, rebuild);

    const rows = alignedDaily(q, tz);
    const diag = analyzeMovingAverages(rows, q.price);
    const maEl = $('#sheet-ma');
    if (maEl) maEl.innerHTML = renderMaPanel(diag, d);
    const bbDiag = analyzeBollinger(rows, q.price);
    const bbEl = $('#sheet-bb');
    if (bbEl) bbEl.innerHTML = renderBbPanel(bbDiag, d);
    const pctbValEl = $('#pctb-val');
    if (pctbValEl) {
      pctbValEl.textContent = bbDiag
        ? `${bbDiag.pctB.toFixed(2)}（${bbDiag.pctB > 1 ? '破上軌' : bbDiag.pctB < 0 ? '破下軌' : bbDiag.pctB >= 0.5 ? '偏多 ≥0.5' : '偏空 <0.5'}）`
        : '—';
    }
    const bbwValEl = $('#bbw-val');
    if (bbwValEl) {
      bbwValEl.textContent = bbDiag
        ? `${bbDiag.curBbw.toFixed(2)}%（${signed(bbDiag.bbwChg, 2)}% · 分位 ${bbDiag.rank120.toFixed(0)}%）`
        : '—';
    }

    const lastMA = series.ma20.filter((p) => p).pop();
    const lastRSI = series.rsi.filter((p) => p).pop();
    $('#rsi-val').textContent = lastRSI ? lastRSI.value.toFixed(1) + (lastRSI.value >= 70 ? '（超買）' : lastRSI.value <= 30 ? '（超賣）' : '') : '—';
    const amp = isNum(q.high) && isNum(q.low) && isNum(q.prevClose) ? ((q.high - q.low) / q.prevClose) * 100 : null;
    const baseLabel = q.group === 'fut' ? (key === 'TXF_D' ? '昨日結算' : '參考價') : '昨收';

    let stats;
    const bbPctStat = ['BB %b (20,2)', bbDiag ? `${bbDiag.pctB.toFixed(2)}（${bbDiag.pctB >= 0.5 ? '偏多' : '偏空'}）` : '—'];
    const bbwStat = ['BBW 帶寬', bbDiag ? `${bbDiag.curBbw.toFixed(2)}%（${signed(bbDiag.bbwChg, 2)}%）` : '—'];
    if (key === 'FGI') {
      const fz = getFgiZone(q.price);
      stats = [
        ['當前情緒', fz ? `${fz.label} (${fz.en})` : '—'],
        ['所屬區間', fz ? fz.range : '—'],
        ['昨日收盤', fmt(q.prevClose, d)],
        ['1 週前', fmt(q.prevWeek, d)],
        ['1 個月前', fmt(q.prevMonth, d)],
        ['1 年前', fmt(q.prevYear, d)],
        ['週線 (5MA)', diag?.mas?.ma5?.val ? fmt(diag.mas.ma5.val, d) : '—'],
        ['雙週線 (10MA)', diag?.mas?.ma10?.val ? fmt(diag.mas.ma10.val, d) : '—'],
        ['月線 (20MA)', diag?.mas?.ma20?.val ? fmt(diag.mas.ma20.val, d) : (lastMA ? fmt(lastMA.value, d) : '—')],
        ['季線 (60MA)', diag?.mas?.ma60?.val ? fmt(diag.mas.ma60.val, d) : '—'],
        ['半年線 (120MA)', diag?.mas?.ma120?.val ? fmt(diag.mas.ma120.val, d) : '—'],
        ['年線 (240MA)', diag?.mas?.ma240?.val ? fmt(diag.mas.ma240.val, d) : '—'],
        bbPctStat,
        bbwStat,
        ['均線型態', diag?.pattern?.label || '—'],
        ['資料來源', 'CNN Business'],
      ];
    } else if (key === 'VIX') {
      const vz = getVixZone(q.price);
      stats = [
        ['所屬區間', vz ? vz.label : '—'],
        ['區間範圍', vz ? vz.range : '—'],
        ['開盤', fmt(q.open, d)],
        ['最高', fmt(q.high, d)],
        ['最低', fmt(q.low, d)],
        ['昨收', fmt(q.prevClose, d)],
        ['振幅', isNum(amp) ? amp.toFixed(2) + '%' : '—'],
        ['週線 (5MA)', diag?.mas?.ma5?.val ? fmt(diag.mas.ma5.val, d) : '—'],
        ['雙週線 (10MA)', diag?.mas?.ma10?.val ? fmt(diag.mas.ma10.val, d) : '—'],
        [state.range === '1d' ? '分時 MA20' : '月線 (20MA)', lastMA ? fmt(lastMA.value, d) : '—'],
        ['季線 (60MA)', diag?.mas?.ma60?.val ? fmt(diag.mas.ma60.val, d) : '—'],
        ['半年線 (120MA)', diag?.mas?.ma120?.val ? fmt(diag.mas.ma120.val, d) : '—'],
        ['年線 (240MA)', diag?.mas?.ma240?.val ? fmt(diag.mas.ma240.val, d) : '—'],
        bbPctStat,
        bbwStat,
        ['均線型態', diag?.pattern?.label || '—'],
      ];
    } else if (key === 'VIXTWN') {
      const vt = getVixTwnZone(q.price);
      const sigma30d = isNum(q.price) ? (q.price / Math.sqrt(12)).toFixed(2) + '%' : '—';
      stats = [
        ['所屬區間', vt ? vt.label : '—'],
        ['區間範圍', vt ? vt.range : '—'],
        ['未來30天1σ波動', sigma30d],
        ['編製指標', '期交所 TXO 年化%×100'],
        ['開盤', fmt(q.open, d)],
        ['最高', fmt(q.high, d)],
        ['最低', fmt(q.low, d)],
        ['昨收', fmt(q.prevClose, d)],
        ['週線 (5MA)', diag?.mas?.ma5?.val ? fmt(diag.mas.ma5.val, d) : '—'],
        ['雙週線 (10MA)', diag?.mas?.ma10?.val ? fmt(diag.mas.ma10.val, d) : '—'],
        [state.range === '1d' ? '分時 MA20' : '月線 (20MA)', lastMA ? fmt(lastMA.value, d) : '—'],
        ['季線 (60MA)', diag?.mas?.ma60?.val ? fmt(diag.mas.ma60.val, d) : '—'],
        bbPctStat,
        bbwStat,
        ['均線型態', diag?.pattern?.label || '—'],
        ['狀態', marketStatus(q).text],
      ];
    } else {
      const volStat = isNum(q.turnoverYi) && (!isNum(q.volume) || q.volume <= 0)
        ? ['成交金額', `${fmt(q.turnoverYi, 1)} 億`]
        : ['成交量', fmtVol(q.volume, q)];
      stats = [
        ['開盤', fmt(q.open, d)], ['最高', fmt(q.high, d)], ['最低', fmt(q.low, d)], [baseLabel, fmt(q.prevClose, d)],
        volStat, ['振幅', isNum(amp) ? amp.toFixed(2) + '%' : '—'],
        ['週線 (5MA)', diag?.mas?.ma5?.val ? fmt(diag.mas.ma5.val, d) : '—'],
        ['雙週線 (10MA)', diag?.mas?.ma10?.val ? fmt(diag.mas.ma10.val, d) : '—'],
        ['月線 (20MA)', diag?.mas?.ma20?.val ? fmt(diag.mas.ma20.val, d) : '—'],
        ['季線 (60MA)', diag?.mas?.ma60?.val ? fmt(diag.mas.ma60.val, d) : '—'],
        ['半年線 (120MA)', diag?.mas?.ma120?.val ? fmt(diag.mas.ma120.val, d) : '—'],
        ['年線 (240MA)', diag?.mas?.ma240?.val ? fmt(diag.mas.ma240.val, d) : '—'],
        bbPctStat,
        bbwStat,
        ['均線型態', diag?.pattern?.label || '—'],
        ['狀態', marketStatus(q).text],
      ];
    }
    $('#sheet-stats').innerHTML = stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('') +
      (key === 'FGI' || key === 'VIX' || key === 'VIXTWN' ? `<div class="sheet-zone-wrap">${zoneLegendHTML(key, q.price)}</div>` : '');
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
        ma5: [],
        ma10: [],
        ma20: line.map((p, i) => (m[i] != null ? { time: p.time, value: m[i] } : null)),
        ma60: [],
        ma120: [],
        ma240: [],
        bbUb: [],
        bbLb: [],
        pctB: [],
        bbw: [],
        bbwSqueezeThresh: null,
        rsi: line.map((p, i) => (r[i] != null ? { time: p.time, value: r[i] } : null)),
      };
    }
    const rows = alignedDaily(q, tz);
    const closes = rows.map((r) => r.c);
    const m5 = sma(closes, 5), m10 = sma(closes, 10), m20 = sma(closes, 20), m60 = sma(closes, 60), m120 = sma(closes, 120), m240 = sma(closes, 240);
    const r = rsi(closes, 14);
    const bbAll = bollingerSeries(closes, 20, 2);
    const bbwWin = bbAll.bbw.slice(Math.max(0, rows.length - 120)).filter(isNum).sort((a, b) => a - b);
    const bbwSqueezeThresh = bbwWin.length ? bbwWin[Math.floor((bbwWin.length - 1) * 0.25)] : null;
    const n = { '3m': 63, '6m': 126, '1y': 260 }[state.range] || 126;
    const from = Math.max(0, rows.length - n);
    const sl = (arr) => arr.slice(from);
    return {
      kind: 'candle',
      candles: sl(rows).map((x) => ({ time: x.date, open: x.o, high: x.h, low: x.l, close: x.c })),
      ma5: sl(rows.map((x, i) => (m5[i] != null ? { time: x.date, value: m5[i] } : null))),
      ma10: sl(rows.map((x, i) => (m10[i] != null ? { time: x.date, value: m10[i] } : null))),
      ma20: sl(rows.map((x, i) => (m20[i] != null ? { time: x.date, value: m20[i] } : null))),
      ma60: sl(rows.map((x, i) => (m60[i] != null ? { time: x.date, value: m60[i] } : null))),
      ma120: sl(rows.map((x, i) => (m120[i] != null ? { time: x.date, value: m120[i] } : null))),
      ma240: sl(rows.map((x, i) => (m240[i] != null ? { time: x.date, value: m240[i] } : null))),
      bbUb: sl(rows.map((x, i) => (bbAll.ub[i] != null ? { time: x.date, value: bbAll.ub[i] } : null))),
      bbLb: sl(rows.map((x, i) => (bbAll.lb[i] != null ? { time: x.date, value: bbAll.lb[i] } : null))),
      pctB: sl(rows.map((x, i) => (bbAll.pctB[i] != null ? { time: x.date, value: bbAll.pctB[i] } : null))),
      bbw: sl(rows.map((x, i) => (bbAll.bbw[i] != null ? { time: x.date, value: bbAll.bbw[i] } : null))),
      bbwSqueezeThresh,
      rsi: sl(rows.map((x, i) => (r[i] != null ? { time: x.date, value: r[i] } : null))),
    };
  }

  function drawCharts(s, q, rebuild) {
    const LWC = window.LightweightCharts;
    const mainEl = $('#chart-main'), rsiEl = $('#chart-rsi'), pctbEl = $('#chart-pctb'), bbwEl = $('#chart-bbw');
    const bbSubWrap = $('#bb-subcharts');
    if (!LWC) {
      mainEl.innerHTML = '<div class="empty-chart">圖表元件載入中…</div>';
      if (bbSubWrap) bbSubWrap.hidden = true;
      setTimeout(() => state.openKey && updateSheet(true), 600);
      return;
    }
    const c = colors();
    const { dir } = calc(q);
    const lineColor = c[dir];
    const MA5 = '#f1f5f9', MA10 = '#22d3ee', MA20 = '#f2b544', MA60 = '#5ab0f0', MA120 = '#c678dd', MA240 = '#4cd964', BB_COLOR = '#38bdf8';
    const empty = s.kind === 'line' ? s.line.length < 2 : s.candles.length < 2;
    const hasBb = !empty && s.kind === 'candle' && (s.pctB || []).some(Boolean);
    if (bbSubWrap) bbSubWrap.hidden = !hasBb;

    if (rebuild || !state.charts || state.charts.kind !== s.kind || Boolean(state.charts.pctb) !== hasBb) {
      destroyCharts();
      mainEl.innerHTML = '';
      rsiEl.innerHTML = '';
      if (pctbEl) pctbEl.innerHTML = '';
      if (bbwEl) bbwEl.innerHTML = '';
      if (empty) {
        mainEl.innerHTML = `<div class="empty-chart">${q.group === 'fut' ? '期貨走勢由雲端排程隨盤中每分鐘累積，開盤後即會出現' : '尚無走勢資料'}</div>`;
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
      const ma5 = main.addLineSeries({ color: MA5, lineWidth: 1.4, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      const ma10 = main.addLineSeries({ color: MA10, lineWidth: 1.4, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      const ma20 = main.addLineSeries({ color: MA20, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      const ma60 = main.addLineSeries({ color: MA60, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      const ma120 = main.addLineSeries({ color: MA120, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      const ma240 = main.addLineSeries({ color: MA240, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      const bbUb = s.kind === 'candle' ? main.addLineSeries({ color: BB_COLOR, lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }) : null;
      const bbLb = s.kind === 'candle' ? main.addLineSeries({ color: BB_COLOR, lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }) : null;
      const rsiS = rsiC.addLineSeries({ color: '#c9a7ff', lineWidth: 1.5, priceLineVisible: false });
      rsiS.createPriceLine({ price: 70, color: 'rgba(255,255,255,0.25)', lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
      rsiS.createPriceLine({ price: 30, color: 'rgba(255,255,255,0.25)', lineStyle: 2, lineWidth: 1, axisLabelVisible: false });

      let pctbC = null, pctbS = null, bbwC = null, bbwS = null;
      if (hasBb && pctbEl && bbwEl) {
        pctbC = LWC.createChart(pctbEl, { ...base, rightPriceScale: { borderVisible: false, minimumWidth: 78, scaleMargins: { top: 0.12, bottom: 0.12 } } });
        pctbS = pctbC.addLineSeries({ color: BB_COLOR, lineWidth: 1.8, priceLineVisible: false });
        pctbS.createPriceLine({ price: 1, color: 'rgba(248,113,113,0.45)', lineStyle: 2, lineWidth: 1, axisLabelVisible: false, title: '1.0' });
        pctbS.createPriceLine({ price: 0.5, color: 'rgba(242,181,68,0.55)', lineStyle: 2, lineWidth: 1, axisLabelVisible: false, title: '0.5' });
        pctbS.createPriceLine({ price: 0, color: 'rgba(74,222,128,0.45)', lineStyle: 2, lineWidth: 1, axisLabelVisible: false, title: '0.0' });

        bbwC = LWC.createChart(bbwEl, { ...base, rightPriceScale: { borderVisible: false, minimumWidth: 78, scaleMargins: { top: 0.12, bottom: 0.08 } } });
        bbwS = bbwC.addAreaSeries({ lineColor: '#a78bfa', topColor: 'rgba(167,139,250,0.32)', bottomColor: 'rgba(167,139,250,0.02)', lineWidth: 1.8, priceLineVisible: false });
        if (isNum(s.bbwSqueezeThresh)) {
          bbwS.createPriceLine({ price: s.bbwSqueezeThresh, color: 'rgba(242,181,68,0.55)', lineStyle: 2, lineWidth: 1, axisLabelVisible: false, title: '低壓縮' });
        }
      }

      // 多圖時間軸雙向同步
      const allCharts = [main, rsiC, pctbC, bbwC].filter(Boolean);
      let syncing = false;
      for (const src of allCharts) {
        src.timeScale().subscribeVisibleLogicalRangeChange((r) => {
          if (!r || syncing) return;
          syncing = true;
          for (const dst of allCharts) {
            if (dst !== src) dst.timeScale().setVisibleLogicalRange(r);
          }
          syncing = false;
        });
      }
      state.charts = { kind: s.kind, main, rsi: rsiC, pctb: pctbC, bbw: bbwC, price, ma5, ma10, ma20, ma60, ma120, ma240, bbUb, bbLb, rsiS, pctbS, bbwS, baseLine: null };
    }
    if (empty) return;
    const ch = state.charts;
    const padToCandles = (candles, pts) => {
      const m = new Map();
      for (const p of pts || []) {
        if (p && isNum(p.value)) m.set(p.time, p.value);
      }
      return candles.map((c0) => (m.has(c0.time) ? { time: c0.time, value: m.get(c0.time) } : { time: c0.time }));
    };
    if (s.kind === 'line') {
      ch.price.applyOptions({ lineColor, topColor: lineColor + '55', bottomColor: lineColor + '00' });
      ch.price.setData(s.line);
      if (ch.baseLine) ch.price.removePriceLine(ch.baseLine);
      ch.baseLine = isNum(q.prevClose) ? ch.price.createPriceLine({ price: q.prevClose, color: '#8b93a1', lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: q.group === 'fut' ? '參考' : '昨收' }) : null;
      ch.rsiS.setData(s.rsi.filter(Boolean));
    } else {
      ch.price.applyOptions({ upColor: c.up, downColor: c.down, borderUpColor: c.up, borderDownColor: c.down, wickUpColor: c.up, wickDownColor: c.down });
      ch.price.setData(s.candles);
      ch.rsiS.setData(padToCandles(s.candles, s.rsi));
      if (ch.bbUb) ch.bbUb.setData((s.bbUb || []).filter(Boolean));
      if (ch.bbLb) ch.bbLb.setData((s.bbLb || []).filter(Boolean));
      if (ch.pctbS) ch.pctbS.setData(padToCandles(s.candles, s.pctB));
      if (ch.bbwS) ch.bbwS.setData(padToCandles(s.candles, s.bbw));
    }
    if (ch.ma5) ch.ma5.setData((s.ma5 || []).filter(Boolean));
    if (ch.ma10) ch.ma10.setData((s.ma10 || []).filter(Boolean));
    ch.ma20.setData(s.ma20.filter(Boolean));
    ch.ma60.setData(s.ma60.filter(Boolean));
    if (ch.ma120) ch.ma120.setData((s.ma120 || []).filter(Boolean));
    if (ch.ma240) ch.ma240.setData((s.ma240 || []).filter(Boolean));
    if (rebuild) {
      ch.main.timeScale().fitContent();
      ch.rsi.timeScale().fitContent();
      if (ch.pctb) ch.pctb.timeScale().fitContent();
      if (ch.bbw) ch.bbw.timeScale().fitContent();
    }
    if (s.kind === 'line') {
      $('#sheet-legend').innerHTML =
        `<span><i style="background:${MA20}"></i>分時 MA20</span>` +
        `<span>分時走勢</span>`;
    } else {
      $('#sheet-legend').innerHTML =
        ((s.ma5 || []).some(Boolean) ? `<span><i style="background:${MA5}"></i>週線 5MA</span>` : '') +
        ((s.ma10 || []).some(Boolean) ? `<span><i style="background:${MA10}"></i>雙週線 10MA</span>` : '') +
        (s.ma20.some(Boolean) ? `<span><i style="background:${MA20}"></i>月線 20MA</span>` : '') +
        (s.ma60.some(Boolean) ? `<span><i style="background:${MA60}"></i>季線 60MA</span>` : '') +
        ((s.ma120 || []).some(Boolean) ? `<span><i style="background:${MA120}"></i>半年線 120MA</span>` : '') +
        ((s.ma240 || []).some(Boolean) ? `<span><i style="background:${MA240}"></i>年線 240MA</span>` : '') +
        ((s.bbUb || []).some(Boolean) ? `<span><i style="background:${BB_COLOR}"></i>BB 上下軌</span>` : '') +
        `<span>日 K</span>`;
    }
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
    window.dispatchEvent(new CustomEvent('stockdash:scheme', { detail: { scheme: state.scheme } }));
  });
  $('#btn-refresh').addEventListener('click', () => refreshAll(true));
  $('#status-line').addEventListener('click', () => refreshAll(true));
  $('#status-line').style.cursor = 'pointer';
  $('#fx-card').addEventListener('click', () => openSheet('USDTWD'));
  $('#sheet-close').addEventListener('click', closeSheet);
  $('#sheet-backdrop').addEventListener('click', closeSheet);
  $('#sheet-bt-btn')?.addEventListener('click', () => {
    const key = state.openKey;
    if (!key) return;
    closeSheet();
    window.__STOCKDASH_OPEN_BACKTEST__?.(key);
  });
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
    sheet.addEventListener('touchstart', (e) => { if (sheet.scrollTop <= 0 && !e.target.closest('.chart-main,.chart-rsi,.chart-bb')) y0 = e.touches[0].clientY; }, { passive: true });
    sheet.addEventListener('touchend', (e) => { if (y0 != null && e.changedTouches[0].clientY - y0 > 90) closeSheet(); y0 = null; }, { passive: true });
  })();

  // ---------------- 回測用歷史日 K 載入橋接 ----------------
  const btHistCache = new Map();
  async function fetchYahooChartDaily(sym, range = '5y') {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${encodeURIComponent(range)}&interval=1d&_=${Math.floor(Date.now() / 60000)}`;
    const j = await viaProxy(url, {}, (x) => Array.isArray(x?.chart?.result) && x.chart.result[0]?.timestamp?.length > 5);
    const resp = j.chart.result[0];
    const m = resp.meta || {};
    const tz = m.exchangeTimezoneName || (sym.endsWith('.TW') || sym.endsWith('.TWO') || sym === '^TWII' ? 'Asia/Taipei' : 'America/New_York');
    const ts = resp.timestamp || [];
    const q = resp.indicators?.quote?.[0] || {};
    const adjArr = resp.indicators?.adjclose?.[0]?.adjclose || [];
    const byDate = new Map();
    for (let i = 0; i < ts.length; i++) {
      const c = q.close?.[i];
      if (!isNum(c) || c <= 0 || !isNum(ts[i])) continue;
      const date = tzParts(ts[i] * 1000, tz).date;
      const o0 = q.open?.[i], h0 = q.high?.[i], l0 = q.low?.[i], ac0 = adjArr[i];
      const o = isNum(o0) && o0 > 0 ? o0 : c;
      const h = isNum(h0) && h0 > 0 ? Math.max(h0, o, c) : Math.max(o, c);
      const l = isNum(l0) && l0 > 0 ? Math.min(l0, o, c) : Math.min(o, c);
      const adj = isNum(ac0) && ac0 > 0 ? ac0 : c;
      byDate.set(date, { date, o, h, l, c, adj, v: q.volume?.[i] ?? 0 });
    }
    const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    return {
      symbol: m.symbol || sym,
      name: m.shortName || m.longName || sym,
      currency: m.currency || '',
      hasAdj: adjArr.some((v) => isNum(v) && v > 0),
      source: 'Yahoo Finance',
      rows,
    };
  }

  async function fetchFinMindDaily(stockId, years = 5) {
    const start = new Date(Date.now() - years * 365.25 * 86400000).toISOString().slice(0, 10);
    const r = await fetchWithTimeout(`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${encodeURIComponent(stockId)}&start_date=${start}`, {}, 9000);
    if (!r.ok) throw new Error(`FinMind HTTP ${r.status}`);
    const j = await r.json();
    if (!Array.isArray(j?.data) || j.data.length < 10) throw new Error('FinMind no data');
    const byDate = new Map();
    for (const row of j.data) {
      const c = num(row.close);
      if (!row.date || !isNum(c) || c <= 0) continue;
      const o0 = num(row.open), h0 = num(row.max), l0 = num(row.min);
      const o = isNum(o0) && o0 > 0 ? o0 : c;
      const h = isNum(h0) && h0 > 0 ? Math.max(h0, o, c) : Math.max(o, c);
      const l = isNum(l0) && l0 > 0 ? Math.min(l0, o, c) : Math.min(o, c);
      byDate.set(row.date, { date: row.date, o, h, l, c, adj: c, v: num(row.Trading_Volume) ?? 0 });
    }
    const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    return {
      symbol: `${stockId}.TW`,
      name: `台股 ${stockId}`,
      currency: 'TWD',
      hasAdj: false,
      source: 'FinMind 台股日線（未還原）',
      rows,
    };
  }

  window.__STOCKDASH_FETCH_DAILY__ = async function (rawInput, range = '5y') {
    const key = String(rawInput || '').trim();
    const upper = key.toUpperCase();
    const cacheKey = `${upper}|${range}`;
    if (btHistCache.has(cacheKey)) return btHistCache.get(cacheKey);

    const builtInKey = state.quotes[key] ? key : state.quotes[upper] ? upper : null;
    const q = builtInKey ? state.quotes[builtInKey] : null;
    const meta = builtInKey ? META[builtInKey] : null;
    const isBuiltIn2YOnly = range === '6m' || range === '1y' || range === '2y';

    const fromBuiltIn = () => {
      if (!q || !Array.isArray(q.daily) || q.daily.length < 10) return null;
      const tz = q.tz || meta?.tz || 'UTC';
      const rows = alignedDaily(q, tz).map((r) => ({ ...r, adj: r.c }));
      return {
        key: builtInKey,
        symbol: meta?.y || meta?.symbol || builtInKey,
        name: meta?.name || q.name || builtInKey,
        currency: q.currency || '',
        hasAdj: false,
        source: '內建看盤快照',
        rows,
      };
    };

    if (builtInKey && (isBuiltIn2YOnly || builtInKey === 'VIXTWN')) {
      const localRes = fromBuiltIn();
      if (localRes) {
        btHistCache.set(cacheKey, localRes);
        return localRes;
      }
    }

    const candidates = [];
    if (meta?.y) {
      candidates.push(meta.y);
    } else if (/^\d{4,6}[A-Z]?$/.test(upper)) {
      candidates.push(`${upper}.TW`, `${upper}.TWO`);
    } else {
      candidates.push(upper);
    }

    for (const sym of candidates) {
      try {
        const res = await fetchYahooChartDaily(sym, range === '2y' || range === '1y' || range === '6m' ? '2y' : range);
        if (res.rows.length >= 20) {
          const out = {
            key: builtInKey || upper,
            symbol: res.symbol,
            name: meta?.name || res.name || upper,
            currency: res.currency,
            hasAdj: res.hasAdj,
            source: res.source,
            rows: res.rows,
          };
          btHistCache.set(cacheKey, out);
          return out;
        }
      } catch {}
    }

    if (/^\d{4,6}[A-Z]?$/.test(upper)) {
      try {
        const years = range === '5y' ? 5 : range === '3y' ? 3 : 2;
        const fmRes = await fetchFinMindDaily(upper, years);
        if (fmRes.rows.length >= 20) {
          const out = {
            key: builtInKey || upper,
            symbol: fmRes.symbol,
            name: meta?.name || fmRes.name,
            currency: 'TWD',
            hasAdj: false,
            source: fmRes.source,
            rows: fmRes.rows,
          };
          btHistCache.set(cacheKey, out);
          return out;
        }
      } catch {}
    }

    const fallback = fromBuiltIn();
    if (fallback) {
      btHistCache.set(cacheKey, fallback);
      return fallback;
    }
    throw new Error(`找不到「${key}」的歷史日K資料（台股請輸入代號如 2317／006208，美股如 NVDA／SPY）`);
  };

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
  setInterval(renderStatus, 1_000); // 每 1 秒即時推進「X 秒前」計時，動態可見
  document.addEventListener('visibilitychange', () => !document.hidden && refreshAll());
})();
