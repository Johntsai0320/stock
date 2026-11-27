// 由 GitHub Actions 執行：抓取真實市場數據並輸出 site/data.json
// 資料來源：Yahoo Finance (chart / spark)、期交所 MIS、證交所 MIS（若可連線）
// Node 20+（內建 fetch）

import { writeFile, readFile, mkdir } from 'node:fs/promises';

const SCHEMA_VERSION = 3;
const SITE_URL = process.env.SITE_URL || 'https://johntsai0320.github.io/stock/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const PRICE_INDEX_KEYS = new Set(['TWII', 'DJI', 'GSPC', 'IXIC', 'SOX', 'VIX', 'VIXTWN']);

// key, Yahoo symbol, 顯示名稱, 分組, TWSE MIS 代碼
export const SYMBOLS = [
  { key: 'TWII', y: '^TWII', name: '台灣加權指數', group: 'tw', mis: 'tse_t00.tw' },
  { key: 'TPEX', y: 'IX0043.TWO', name: '台灣櫃買指數', group: 'tw', mis: 'otc_o00.tw' },
  { key: '2330', y: '2330.TW', name: '台積電', group: 'tw', mis: 'tse_2330.tw' },
  { key: '0050', y: '0050.TW', name: '元大台灣50', group: 'tw', mis: 'tse_0050.tw' },
  { key: 'DJI', y: '^DJI', name: '道瓊工業', group: 'usidx' },
  { key: 'GSPC', y: '^GSPC', name: 'S&P 500', group: 'usidx' },
  { key: 'IXIC', y: '^IXIC', name: '那斯達克', group: 'usidx' },
  { key: 'SOX', y: '^SOX', name: '費城半導體', group: 'usidx' },
  { key: 'VIX', y: '^VIX', name: 'VIX 恐慌指數', group: 'usidx' },
  { key: 'TSM', y: 'TSM', name: '台積電 ADR', group: 'us' },
  { key: 'VT', y: 'VT', name: 'Vanguard 全世界股票', group: 'us' },
  { key: 'QQQM', y: 'QQQM', name: 'Invesco 那斯達克100', group: 'us' },
  { key: 'USDTWD', y: 'TWD=X', name: '美元/台幣', group: 'fx' },
];


const num = (v) => {
  if (v === null || v === undefined || v === '' || v === '-') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
const posNum = (v) => {
  const n = num(v);
  return n != null && n > 0 ? n : null;
};
const validVix = (v) => v != null && Number.isFinite(v) && v > 0 && Math.abs(v) < 9000;

function dateInTz(ms, tz = 'UTC') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

function rocToIso(roc) {
  const m = String(roc || '').trim().match(/^(\d{2,3})\/(\d{2})\/(\d{2})$/);
  return m ? `${+m[1] + 1911}-${m[2]}-${m[3]}` : null;
}

async function fetchJSON(url, opts = {}, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        ...opts,
        headers: { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*', ...(opts.headers || {}) },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return await res.json();
    } catch (e) {
      err = e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw err;
}

// ---------- Yahoo ----------
async function yahooChart(symbol, range, interval) {
  const hosts = ['query1', 'query2'];
  let lastErr;
  for (const h of hosts) {
    try {
      const url = `https://${h}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
      const j = await fetchJSON(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
        },
      });
      const r = j?.chart?.result?.[0];
      if (!r) throw new Error('empty chart ' + symbol);
      return r;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function parseIntraday(r) {
  const ts = r.timestamp || [];
  const c = r.indicators?.quote?.[0]?.close || [];
  const out = [];
  for (let i = 0; i < ts.length; i++) if (c[i] != null) out.push([ts[i] * 1000, +c[i].toFixed(4)]);
  return out;
}

function parseDaily(r) {
  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    if ([q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i]].some((v) => v == null)) continue;
    out.push([ts[i] * 1000, +q.open[i].toFixed(4), +q.high[i].toFixed(4), +q.low[i].toFixed(4), +q.close[i].toFixed(4), q.volume?.[i] ?? 0]);
  }
  return out;
}

async function fetchYahoo(def) {
  const [intra, daily] = await Promise.all([
    yahooChart(def.y, '1d', '1m').catch(() => yahooChart(def.y, '1d', '5m')),
    yahooChart(def.y, '2y', '1d').catch(() => yahooChart(def.y, '1y', '1d')).catch(() => null),
  ]);
  const m = intra.meta;
  const tz = m.exchangeTimezoneName || 'UTC';
  const dailyBars = daily ? parseDaily(daily) : [];
  const regTimeMs = (m.regularMarketTime || 0) * 1000;
  const regDate = regTimeMs ? dateInTz(regTimeMs, tz) : null;

  // 昨收：range=1d 時 previousClose / chartPreviousClose 皆為「前一交易日收盤」
  // 注意：Yahoo 對 ^TWII 偶爾回傳過期 previousClose、對 ^DJI 會四捨五入到 1 位小數；純價格指數可用日線前一日收盤精確校準
  let prevClose = num(m.previousClose) ?? num(m.chartPreviousClose);
  if (PRICE_INDEX_KEYS.has(def.key) && regDate && dailyBars.length) {
    let prevBar = null;
    for (let i = dailyBars.length - 1; i >= 0; i--) {
      if (dateInTz(dailyBars[i][0], tz) < regDate) { prevBar = dailyBars[i]; break; }
    }
    if (prevBar && prevBar[4] > 0) {
      const dailyPrev = +prevBar[4].toFixed(2);
      if (def.key === 'TWII' || prevClose == null || Math.abs(dailyPrev - prevClose) <= Math.max(0.5, prevClose * 0.0001)) {
        prevClose = dailyPrev;
      }
    }
  }

  const intraday = parseIntraday(intra);
  const quotes = intra.indicators?.quote?.[0] || {};
  const highs = (quotes.high || []).filter((v) => v != null);
  const lows = (quotes.low || []).filter((v) => v != null);
  const opens = (quotes.open || []).filter((v) => v != null);

  // 開盤價優先採用當日日線官方開盤價（避免 ^IXIC / 美股首根 1 分 K 與開盤集合競價落差）
  const todayDaily = regDate ? dailyBars.find((b) => dateInTz(b[0], tz) === regDate) : null;
  const open = todayDaily && todayDaily[1] > 0
    ? +todayDaily[1].toFixed(4)
    : (opens.length ? +opens[0].toFixed(4) : null);

  return {
    key: def.key,
    name: def.name,
    symbol: def.y,
    group: def.group,
    currency: m.currency,
    price: num(m.regularMarketPrice),
    prevClose,
    open,
    high: num(m.regularMarketDayHigh) ?? (highs.length ? +Math.max(...highs).toFixed(4) : null),
    low: num(m.regularMarketDayLow) ?? (lows.length ? +Math.min(...lows).toFixed(4) : null),
    volume: num(m.regularMarketVolume),
    time: regTimeMs,
    session: m.currentTradingPeriod?.regular
      ? { start: m.currentTradingPeriod.regular.start * 1000, end: m.currentTradingPeriod.regular.end * 1000 }
      : null,
    tz,
    source: 'Yahoo Finance',
    intraday,
    daily: dailyBars,
  };
}

// ---------- TWSE MIS（海外 IP 可能被擋或偶發 503，重試 2 次，失敗改以期交所/盤後官方報價補強）----------
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

async function fetchTwseMis() {
  const chs = SYMBOLS.filter((s) => s.mis).map((s) => s.mis).join('|');
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(chs)}&json=1&delay=0&_=${Date.now()}`;
  const j = await fetchJSON(url, { headers: { Referer: 'https://mis.twse.com.tw/stock/index.jsp' } }, 2);
  const out = {};
  for (const it of j.msgArray || []) {
    const key = SYMBOLS.find((s) => s.mis && s.mis.startsWith(`${it.ex}_${it.c}.`))?.key;
    if (!key) continue;
    const price = extractTwsePrice(it);
    const rawVol = num(it.v);
    // MIS 個股成交量 it.v 單位為「張」，統一換算為「股」以對齊 Yahoo 與證交所盤後 STOCK_DAY
    const volume = (key === '2330' || key === '0050') && rawVol != null ? rawVol * 1000 : rawVol;
    out[key] = {
      price,
      prevClose: posNum(it.y),
      open: posNum(it.o),
      high: posNum(it.h),
      low: posNum(it.l),
      volume,
      time: num(it.tlong) || Date.now(),
    };
  }
  return out;
}

// ---------- 櫃買指數兩年日 K（Yahoo IX0043.TWO 日線僅 1 筆，改用 FinMind + 櫃買中心 OpenAPI）----------
function twDateStr(ms) {
  return new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
}

function twDayTs(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 5, 30, 0); // 13:30 Asia/Taipei
}

async function fetchTpexDaily(prevDaily = []) {
  const byDate = new Map();
  const turnoverByDate = new Map();
  let latest = null;
  if (Array.isArray(prevDaily)) {
    for (const r of prevDaily) {
      if (Array.isArray(r) && r.length >= 5 && Number.isFinite(r[0]) && Number.isFinite(r[4])) {
        byDate.set(twDateStr(r[0]), r);
      }
    }
  }

  const startDate = new Date(Date.now() - 750 * 86400000).toISOString().slice(0, 10);
  const [fmRes, tpexRes] = await Promise.allSettled([
    fetchJSON(`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=TPEx&start_date=${startDate}`, {}, 2),
    fetchJSON('https://www.tpex.org.tw/openapi/v1/tpex_index', { headers: { Referer: 'https://www.tpex.org.tw/' } }, 2),
  ]);

  if (fmRes.status === 'fulfilled' && Array.isArray(fmRes.value?.data)) {
    for (const row of fmRes.value.data) {
      const o = num(row.open), h = num(row.max), l = num(row.min), c = num(row.close);
      if (!row.date || o == null || h == null || l == null || c == null) continue;
      byDate.set(row.date, [twDayTs(row.date), +o.toFixed(4), +h.toFixed(4), +l.toFixed(4), +c.toFixed(4), num(row.Trading_Volume) ?? 0]);
      const money = num(row.Trading_money);
      if (money != null && money > 0) turnoverByDate.set(row.date, +(money / 1e8).toFixed(2));
    }
  }

  if (tpexRes.status === 'fulfilled' && Array.isArray(tpexRes.value)) {
    for (const row of tpexRes.value) {
      const rawDate = String(row.Date || '').trim();
      if (!/^\d{8}$/.test(rawDate)) continue;
      const dateStr = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
      const o = num(row.Open), h = num(row.High), l = num(row.Low), c = num(row.Close);
      if (o == null || h == null || l == null || c == null) continue;
      const existing = byDate.get(dateStr);
      byDate.set(dateStr, [twDayTs(dateStr), +o.toFixed(4), +h.toFixed(4), +l.toFixed(4), +c.toFixed(4), existing?.[5] ?? 0]);
      const chg = num(row.Change);
      if (!latest || dateStr >= latest.date) {
        latest = {
          date: dateStr,
          open: o,
          high: h,
          low: l,
          close: c,
          prevClose: chg != null ? +(c - chg).toFixed(2) : null,
        };
      }
    }
  }

  const bars = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-520)
    .map(([, bar]) => bar);

  return { bars, latest, turnoverByDate };
}

// ---------- TAIFEX MIS 台指期（同時取得日盤現貨列 TXF-S 供加權指數交叉驗證）----------
function parseTaifexTs(d, cTime, night) {
  if (!d || !cTime || cTime.length < 6) return null;
  const hh = +cTime.slice(0, 2), mm = +cTime.slice(2, 4), ss = +cTime.slice(4, 6);
  let ts = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), hh - 8, mm, ss);
  if (night && hh < 12) ts += 86400000;
  return ts;
}

async function fetchTaifex(marketType) {
  const body = {
    MarketType: String(marketType), // 0 = 一般(日盤), 1 = 盤後(夜盤)
    SymbolType: 'F',
    KindID: '1',
    CID: 'TXF',
    ExpireMonth: '',
    RowSize: '全部',
    PageNo: '',
    SortColumn: '',
    AscDesc: 'A',
  };
  const j = await fetchJSON('https://mis.taifex.com.tw/futures/api/getQuoteList', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Referer: 'https://mis.taifex.com.tw/futures/' },
    body: JSON.stringify(body),
  });
  const list = j?.RtData?.QuoteList || [];
  // 近月合約：第一個 TXF??-F / -M（排除現貨列 TXF-S / TXF-P）
  const q = list.find((x) => /^TXF[A-Z]\d-[FM]$/.test(x.SymbolID));
  if (!q) throw new Error('TAIFEX: near-month contract not found');
  const night = marketType === 1;
  const cleanTaifex = (v) => {
    const n = posNum(v);
    return n != null && n < 900000 ? n : null;
  };
  const ref = cleanTaifex(q.CRefPrice); // 日盤 = 昨日結算價；夜盤 = 當日日盤結算價（期交所提供）
  const last = cleanTaifex(q.CLastPrice);
  const d = q.CDate; // 交易時段起始日
  const time = parseTaifexTs(d, q.CTime, night);

  let spot = null;
  if (!night) {
    const sr = list.find((x) => x.SymbolID === 'TXF-S');
    const spotPrice = sr ? cleanTaifex(sr.CLastPrice) : null;
    if (sr && spotPrice != null && /^\d{8}$/.test(String(sr.CDate || ''))) {
      const sd = sr.CDate;
      spot = {
        date: `${sd.slice(0, 4)}-${sd.slice(4, 6)}-${sd.slice(6, 8)}`,
        price: spotPrice,
        prevClose: cleanTaifex(sr.CRefPrice),
        open: cleanTaifex(sr.COpenPrice),
        high: cleanTaifex(sr.CHighPrice),
        low: cleanTaifex(sr.CLowPrice),
        time: parseTaifexTs(sd, sr.CTime, false) || Date.now(),
      };
    }
  }

  return {
    quote: {
      key: night ? 'TXF_N' : 'TXF_D',
      name: night ? '台指期（夜盤）' : '台指期（日盤）',
      symbol: q.SymbolID,
      contract: q.DispCName,
      group: 'fut',
      currency: 'TWD',
      price: last,
      prevClose: ref,
      open: last != null ? cleanTaifex(q.COpenPrice) : null,
      high: last != null ? cleanTaifex(q.CHighPrice) : null,
      low: last != null ? cleanTaifex(q.CLowPrice) : null,
      volume: num(q.CTotalVolume),
      bid: cleanTaifex(q.CBidPrice1),
      ask: cleanTaifex(q.CAskPrice1),
      settlement: cleanTaifex(q.SettlementPrice),
      sessionDate: d,
      time,
      source: '期交所 MIS',
      intraday: [],
      daily: [],
    },
    spot,
  };
}

// ---------- 臺指選擇權波動率指數（TAIWAN VIX / VIXTWN）----------
function vixDayTs(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 5, 45, 0); // 13:45 Asia/Taipei 收盤揭示
}

async function fetchTaiwanVix(prevQuote = null) {
  const byDate = new Map();
  if (Array.isArray(prevQuote?.daily)) {
    for (const r of prevQuote.daily) {
      if (!Array.isArray(r) || r.length < 5 || !Number.isFinite(r[0]) || !validVix(r[4])) continue;
      const c = +r[4].toFixed(2);
      const o = validVix(r[1]) ? +r[1].toFixed(2) : c;
      const hCandidates = [validVix(r[2]) ? +r[2].toFixed(2) : null, o, c].filter((x) => x != null);
      const lCandidates = [validVix(r[3]) ? +r[3].toFixed(2) : null, o, c].filter((x) => x != null);
      byDate.set(twDateStr(r[0]), [r[0], o, +Math.max(...hCandidates).toFixed(2), +Math.min(...lCandidates).toFixed(2), c, 0]);
    }
  }

  // 1) 官方歷史日收盤（前 3 個月＋當月 YYYYMMnew.txt，累進合併保留長期資料）
  let files = [];
  try {
    const res = await fetch('https://www.taifex.com.tw/cht/7/vixDaily3MNew', {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const html = await res.text();
      files = [...new Set([...html.matchAll(/log2data\/(\d{6}new\.txt)/g)].map((m) => m[1]))];
    }
  } catch {}
  if (!files.length) {
    const nowTpe = new Date(Date.now() + 8 * 3600000);
    for (let k = 0; k < 4; k++) {
      const d = new Date(Date.UTC(nowTpe.getUTCFullYear(), nowTpe.getUTCMonth() - k, 1));
      files.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}new.txt`);
    }
  }

  const dailyResults = await Promise.allSettled(
    files.map((f) =>
      fetch(`https://www.taifex.com.tw/file/taifex/Dailydownload/vix/log2data/${f}`, {
        headers: { 'User-Agent': UA, Referer: 'https://www.taifex.com.tw/cht/7/vixDaily3MNew' },
        signal: AbortSignal.timeout(10000),
      }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
    )
  );
  for (const res of dailyResults) {
    if (res.status !== 'fulfilled') continue;
    for (const rawLine of res.value.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!/^\d{8}\b/.test(line)) continue;
      const cols = line.split(/\s+/);
      const rawDate = cols[0];
      const closeVal = num(cols[2]) ?? num(cols[3]);
      if (!validVix(closeVal)) continue;
      const iso = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
      const c = +closeVal.toFixed(2);
      const ex = byDate.get(iso);
      if (ex && (ex[2] > ex[3] || ex[1] !== ex[4])) {
        const h = validVix(ex[2]) ? +Math.max(ex[2], c).toFixed(2) : +Math.max(ex[1], c).toFixed(2);
        const l = validVix(ex[3]) ? +Math.min(ex[3], c).toFixed(2) : +Math.min(ex[1], c).toFixed(2);
        byDate.set(iso, [ex[0] || vixDayTs(iso), ex[1], h, l, c, 0]);
      } else {
        byDate.set(iso, [vixDayTs(iso), c, c, c, c, 0]);
      }
    }
  }

  // 2) 即時行情與盤中走勢（期交所 MIS getQuoteListVIX + getChartDataTick）
  let misQuote = null;
  let intraday = Array.isArray(prevQuote?.intraday)
    ? prevQuote.intraday.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && validVix(p[1]))
    : [];
  if (intraday.length) {
    const latestIntraDate = twDateStr(intraday[intraday.length - 1][0]);
    intraday = intraday.filter((p) => twDateStr(p[0]) === latestIntraDate);
  }
  let tickByMin = null;
  try {
    const misHeaders = { 'Content-Type': 'application/json', Referer: 'https://mis.taifex.com.tw/futures/VolatilityQuotes/' };
    const j = await fetchJSON('https://mis.taifex.com.tw/futures/api/getQuoteListVIX', {
      method: 'POST',
      headers: misHeaders,
      body: JSON.stringify({ SortColumn: '', AscDesc: 'A' }),
    }, 2);
    const list = j?.RtData?.QuoteList || [];
    misQuote = list.find((x) => x.SymbolID === 'TAIWANVIX') || list[0] || null;

    if (misQuote?.SymbolID && /^\d{8}$/.test(String(misQuote.CDate || ''))) {
      try {
        const tj = await fetchJSON('https://mis.taifex.com.tw/futures/api/getChartDataTick', {
          method: 'POST',
          headers: misHeaders,
          body: JSON.stringify({ SymbolID: misQuote.SymbolID }),
        }, 2);
        const byMin = new Map();
        for (const row of tj?.RtData?.Ticks || []) {
          const hhmmss = String(row?.[0] || '').trim();
          const val = num(row?.[4]);
          if (hhmmss.length < 6 || !validVix(val)) continue;
          const ts = parseTaifexTs(misQuote.CDate, hhmmss, false);
          if (ts != null) byMin.set(hhmmss.slice(0, 4), [ts, +val.toFixed(2)]);
        }
        if (byMin.size) tickByMin = byMin;
      } catch {}
    }
  } catch {}

  // 未開盤時 MIS 會回傳 CLastPrice=0、CHighPrice=-99999、CLowPrice=99999，須視為無效並沿用前一交易日資料
  const validRawDate = misQuote && /^\d{8}$/.test(String(misQuote.CDate || '')) ? misQuote.CDate : null;
  const rawMisPrice = misQuote ? num(misQuote.CLastPrice) : null;
  const misPrice = validVix(rawMisPrice) ? rawMisPrice : null;
  const rawMisRef = misQuote ? num(misQuote.CRefPrice) : null;
  const misRef = validVix(rawMisRef) ? rawMisRef : null;
  const rawMisOpen = misQuote ? num(misQuote.COpenPrice) : null;
  const misOpen = validVix(rawMisOpen) ? rawMisOpen : null;
  const rawMisHigh = misQuote ? num(misQuote.CHighPrice) : null;
  const misHigh = validVix(rawMisHigh) ? rawMisHigh : null;
  const rawMisLow = misQuote ? num(misQuote.CLowPrice) : null;
  const misLow = validVix(rawMisLow) ? rawMisLow : null;
  const misTime = validRawDate && misPrice != null
    ? parseTaifexTs(validRawDate, String(misQuote.CTime || '134500'), false)
    : null;

  if (validRawDate && misPrice != null) {
    const isoToday = `${validRawDate.slice(0, 4)}-${validRawDate.slice(4, 6)}-${validRawDate.slice(6, 8)}`;
    const o = +(misOpen ?? misPrice).toFixed(2);
    const c = +misPrice.toFixed(2);
    const h = +Math.max(misHigh ?? c, o, c).toFixed(2);
    const l = +Math.min(misLow ?? c, o, c).toFixed(2);
    const ex = byDate.get(isoToday);
    byDate.set(isoToday, [
      vixDayTs(isoToday),
      o,
      ex && validVix(ex[2]) ? +Math.max(ex[2], h).toFixed(2) : h,
      ex && validVix(ex[3]) ? +Math.min(ex[3], l).toFixed(2) : l,
      c,
      0,
    ]);
    if (tickByMin && tickByMin.size) {
      intraday = [...tickByMin.values()].sort((a, b) => a[0] - b[0]);
    } else {
      intraday = intraday.filter((p) => twDateStr(p[0]) === isoToday);
    }
    if (misTime && (!intraday.length || intraday[intraday.length - 1][0] <= misTime)) {
      const last = intraday[intraday.length - 1];
      if (last && last[0] === misTime) last[1] = c;
      else intraday.push([misTime, c]);
    }
  }

  const daily = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-520)
    .map(([, bar]) => bar);
  if (!daily.length && misPrice == null) throw new Error('TAIFEX VIXTWN: no quote or daily rows');

  const lastBar = daily[daily.length - 1] || null;
  const prevBar = daily.length >= 2 ? daily[daily.length - 2] : null;
  const hasLiveMis = misPrice != null;
  const prevQuoteValid = validVix(prevQuote?.price);

  const price = hasLiveMis ? misPrice : (lastBar?.[4] ?? (prevQuoteValid ? prevQuote.price : null));
  const prevClose = hasLiveMis
    ? (misRef ?? prevBar?.[4] ?? (validVix(prevQuote?.prevClose) ? prevQuote.prevClose : null) ?? price)
    : (prevBar?.[4] ?? (validVix(prevQuote?.prevClose) ? prevQuote.prevClose : null) ?? price);
  const open = hasLiveMis
    ? (misOpen ?? lastBar?.[1] ?? price)
    : (lastBar?.[1] ?? (validVix(prevQuote?.open) ? prevQuote.open : null) ?? price);
  const high = hasLiveMis
    ? (misHigh ?? lastBar?.[2] ?? price)
    : (lastBar?.[2] ?? (validVix(prevQuote?.high) ? prevQuote.high : null) ?? price);
  const low = hasLiveMis
    ? (misLow ?? lastBar?.[3] ?? price)
    : (lastBar?.[3] ?? (validVix(prevQuote?.low) ? prevQuote.low : null) ?? price);
  const time = hasLiveMis
    ? (misTime ?? lastBar?.[0] ?? prevQuote?.time ?? Date.now())
    : ((prevQuoteValid && prevQuote?.time && lastBar && twDateStr(prevQuote.time) === twDateStr(lastBar[0]))
        ? prevQuote.time
        : (lastBar?.[0] ?? (prevQuoteValid ? prevQuote?.time : null) ?? Date.now()));
  const refRawDate = validRawDate || (time ? twDateStr(time).replace(/-/g, '') : null);
  let session = null;
  if (refRawDate && /^\d{8}$/.test(refRawDate)) {
    const y = +refRawDate.slice(0, 4), m = +refRawDate.slice(4, 6), d = +refRawDate.slice(6, 8);
    session = { start: Date.UTC(y, m - 1, d, 1, 0, 0), end: Date.UTC(y, m - 1, d, 5, 45, 0) };
  }

  return {
    key: 'VIXTWN',
    name: '台股恐慌指數',
    symbol: 'VIXTWN · TAIWAN VIX',
    group: 'tw',
    currency: 'PTS',
    price,
    prevClose,
    open,
    high,
    low,
    volume: null,
    time,
    session,
    tz: 'Asia/Taipei',
    source: hasLiveMis ? '期交所 VIX (MIS)' : '期交所 VIX',
    stale: !misQuote && Boolean(prevQuote?.stale),
    intraday: intraday.slice(-360),
    daily,
  };
}

// ---------- CNN 恐慌貪婪指數 ----------
async function fetchCnnFearGreed() {
  const j = await fetchJSON('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
    headers: {
      Referer: 'https://www.cnn.com/markets/fear-and-greed',
      Origin: 'https://www.cnn.com',
    },
  });
  const fg = j?.fear_and_greed;
  if (!fg || fg.score == null) throw new Error('CNN FGI: missing score');
  const price = +Number(fg.score).toFixed(1);
  const prevClose = fg.previous_close != null ? +Number(fg.previous_close).toFixed(1) : price;
  const time = fg.timestamp ? new Date(fg.timestamp).getTime() : Date.now();
  const byDate = new Map();
  for (const p of j?.fear_and_greed_historical?.data || []) {
    if (!p || p.x == null || p.y == null) continue;
    const rawTs = Number(p.x);
    // CNN 歷史點以 UTC 午夜（% 86400000 === 0）代表美東交易日，若不調整會在 America/New_York 時區倒退一天
    const ts = rawTs % 86400000 === 0 ? rawTs + 16 * 3600000 : rawTs;
    const v = +Number(p.y).toFixed(1);
    byDate.set(dateInTz(ts, 'America/New_York'), [ts, v, v, v, v, 0]);
  }
  const hist = [...byDate.values()].sort((a, b) => a[0] - b[0]);
  const intraday = hist.slice(-60).map((d) => [d[0], d[4]]);
  return {
    key: 'FGI',
    name: 'CNN 恐慌貪婪指數',
    symbol: 'CNN F&G',
    group: 'usidx',
    currency: 'PTS',
    price,
    prevClose,
    open: prevClose,
    high: Math.max(price, prevClose),
    low: Math.min(price, prevClose),
    prevWeek: fg.previous_1_week != null ? +Number(fg.previous_1_week).toFixed(1) : null,
    prevMonth: fg.previous_1_month != null ? +Number(fg.previous_1_month).toFixed(1) : null,
    prevYear: fg.previous_1_year != null ? +Number(fg.previous_1_year).toFixed(1) : null,
    rating: fg.rating || '',
    time,
    tz: 'America/New_York',
    source: 'CNN Business',
    intraday,
    daily: hist,
  };
}

// ---------- 證交所：融資餘額 & 三大法人（外資買賣超） ----------
async function fetchTwseMargin() {
  const j = await fetchJSON('https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?response=json&selectType=MS', {
    headers: { Referer: 'https://www.twse.com.tw/zh/trading/margin/mi-margn.html' },
  });
  if (j?.stat !== 'OK' || !Array.isArray(j.tables) || !j.tables.length) {
    throw new Error(`TWSE MI_MARGN stat=${j?.stat || 'unknown'}`);
  }
  const rows = j.tables[0]?.data || [];
  const amtRow = rows.find((r) => String(r[0]).includes('融資金額'));
  const shortRow = rows.find((r) => String(r[0]).includes('融券'));
  if (!amtRow) throw new Error('TWSE MI_MARGN: missing 融資金額 row');
  const prevK = num(amtRow[4]); // 仟元
  const todayK = num(amtRow[5]);
  if (todayK == null || prevK == null) throw new Error('TWSE MI_MARGN: invalid balance');
  const balanceYi = +(todayK / 1e5).toFixed(2); // 仟元 -> 億元
  const prevBalanceYi = +(prevK / 1e5).toFixed(2);
  const chgYi = +(balanceYi - prevBalanceYi).toFixed(2);
  const chgPct = prevBalanceYi > 0 ? +((chgYi / prevBalanceYi) * 100).toFixed(2) : 0;
  const shortShares = shortRow ? num(shortRow[5]) : null;
  const prevShortShares = shortRow ? num(shortRow[4]) : null;
  return {
    key: 'MARGIN',
    name: '台股融資餘額',
    symbol: 'TWSE Margin',
    group: 'twchip',
    currency: '億TWD',
    price: balanceYi,
    prevClose: prevBalanceYi,
    chg: chgYi,
    chgPct,
    shortShares,
    shortChg: shortShares != null && prevShortShares != null ? shortShares - prevShortShares : null,
    date: j.date || '',
    time: Date.now(),
    tz: 'Asia/Taipei',
    source: '證交所信用交易',
  };
}

const FM_INST_MAP = [
  ['Dealer_self', '自營商(自行買賣)'],
  ['Dealer_Hedging', '自營商(避險)'],
  ['Investment_Trust', '投信'],
  ['Foreign_Investor', '外資及陸資(不含外資自營商)'],
  ['Foreign_Dealer_Self', '外資自營商'],
  ['total', '合計'],
];

async function fetchTwseInst(prevInst = null) {
  const j = await fetchJSON('https://www.twse.com.tw/rwd/zh/fund/BFI82U?response=json&type=day', {
    headers: { Referer: 'https://www.twse.com.tw/zh/trading/foreign/bfi82u.html' },
  });
  if (j?.stat !== 'OK' || !Array.isArray(j.data)) {
    throw new Error(`TWSE BFI82U stat=${j?.stat || 'unknown'}`);
  }
  const rows = j.data
    .map((r) => ({
      name: String(r[0] || '').trim(),
      buy: num(r[1]) ?? 0,
      sell: num(r[2]) ?? 0,
      diff: num(r[3]) ?? 0,
    }))
    .filter((r) => r.name);

  const byExact = (name) => rows.find((r) => r.name === name)?.diff ?? null;
  const byPrefix = (prefix) => rows.find((r) => r.name.startsWith(prefix))?.diff ?? null;
  // 證交所 BFI82U「外資及陸資(不含外資自營商)」名稱內含「外資自營商」字樣，不可用 includes('外資自營商')；
  // 且依證交所說明，外資自營商已計入自營商，故外資買賣超取「外資及陸資(不含外資自營商)」與三大法人合計一致
  const foreignNet = byPrefix('外資及陸資') ?? 0;
  const trustNet = byExact('投信') ?? byPrefix('投信') ?? 0;
  const dealerSelfNet = byExact('自營商(自行買賣)') ?? byPrefix('自營商(自行買賣)') ?? 0;
  const dealerHedgeNet = byExact('自營商(避險)') ?? byPrefix('自營商(避險)') ?? 0;
  const dealerNet = dealerSelfNet + dealerHedgeNet;
  const totalNet = byExact('合計') ?? (foreignNet + trustNet + dealerNet);
  const toYi = (v) => +(v / 1e8).toFixed(2);
  const foreignYi = toYi(foreignNet);
  const trustYi = toYi(trustNet);
  const dealerSelfYi = toYi(dealerSelfNet);
  const dealerHedgeYi = toYi(dealerHedgeNet);
  const dealerYi = toYi(dealerNet);
  const totalYi = toYi(totalNet);
  const date = String(j.date || '').trim();

  // 歷史近 30 交易日明細：從上一版快照延續，必要時（初次、換交易日或每 6 小時）透過 FinMind 補齊完整買賣金額明細
  const histByDate = new Map();
  for (const h of Array.isArray(prevInst?.history) ? prevInst.history : []) {
    if (h?.date && h.exact && Array.isArray(h.rows) && h.rows.length) {
      histByDate.set(h.date, h);
    }
  }
  let histSyncedAt = prevInst?.histSyncedAt || 0;
  const needHistSync = histByDate.size < 15
    || (date && prevInst?.date !== date)
    || (Date.now() - histSyncedAt > 6 * 3600 * 1000);

  if (needHistSync) {
    try {
      const start = twDateStr(Date.now() - 48 * 86400000);
      const fm = await fetchJSON(
        `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockTotalInstitutionalInvestors&start_date=${start}`,
        {},
        2
      );
      if (Array.isArray(fm?.data) && fm.data.length) {
        const grouped = new Map();
        for (const r of fm.data) {
          const d = String(r.date || '').replace(/-/g, '');
          if (!/^\d{8}$/.test(d) || (date && d > date)) continue;
          if (!grouped.has(d)) grouped.set(d, new Map());
          const buy = num(r.buy) ?? 0;
          const sell = num(r.sell) ?? 0;
          grouped.get(d).set(String(r.name || ''), { buy, sell, diff: buy - sell });
        }
        for (const [d, m] of grouped.entries()) {
          const fRows = FM_INST_MAP
            .filter(([k]) => m.has(k))
            .map(([k, label]) => ({ name: label, ...m.get(k) }));
          if (!fRows.length) continue;
          const fNet = m.get('Foreign_Investor')?.diff ?? 0;
          const tNet = m.get('Investment_Trust')?.diff ?? 0;
          const dsNet = m.get('Dealer_self')?.diff ?? 0;
          const dhNet = m.get('Dealer_Hedging')?.diff ?? 0;
          const dNet = dsNet + dhNet;
          const totNet = m.get('total')?.diff ?? (fNet + tNet + dNet);
          histByDate.set(d, {
            date: d,
            foreignYi: toYi(fNet),
            trustYi: toYi(tNet),
            dealerSelfYi: toYi(dsNet),
            dealerHedgeYi: toYi(dhNet),
            dealerYi: toYi(dNet),
            totalYi: toYi(totNet),
            v: toYi(fNet),
            total: toYi(totNet),
            exact: true,
            rows: fRows,
          });
        }
        histSyncedAt = Date.now();
      }
    } catch {
      // 歷史補齊失敗不影響當日證交所官方數據
    }
  }

  if (date) {
    histByDate.set(date, {
      date,
      foreignYi,
      trustYi,
      dealerSelfYi,
      dealerHedgeYi,
      dealerYi,
      totalYi,
      v: foreignYi,
      total: totalYi,
      exact: true,
      rows,
    });
  }
  const history = [...histByDate.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-30);

  return {
    key: 'INST',
    name: '外資買賣超',
    symbol: 'TWSE Foreign Net',
    group: 'twchip',
    currency: '億TWD',
    title: j.title || '',
    price: foreignYi,
    prevClose: 0,
    foreignYi,
    trustYi,
    dealerSelfYi,
    dealerHedgeYi,
    dealerYi,
    totalYi,
    rows,
    history,
    histSyncedAt,
    date,
    time: Date.now(),
    tz: 'Asia/Taipei',
    source: '證交所三大法人',
  };
}

// ---------- 期交所：三大法人台指期（外資期貨多空未平倉口數淨額 & 單日增減 + 完整三大法人明細）----------
async function resolveTaifexEndFmt(viewUrl) {
  let endFmt = twDateStr(Date.now()).replace(/-/g, '/');
  try {
    const res = await fetch(viewUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const html = await res.text();
      const m = html.match(/id="lastDate"[^>]*value="(\d{4}-\d{2}-\d{2})/);
      if (m) endFmt = m[1].replace(/-/g, '/');
    }
  } catch {}
  return endFmt;
}

async function fetchTaifexForeignOi() {
  const byDate = new Map();
  let sourceLabel = '期交所';

  try {
    const startFmt = twDateStr(Date.now() - 45 * 86400000).replace(/-/g, '/');
    const viewUrl = 'https://www.taifex.com.tw/cht/3/futContractsDateView';
    const endFmt = await resolveTaifexEndFmt(viewUrl);
    const res = await fetch('https://www.taifex.com.tw/cht/3/futContractsDateDown', {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: viewUrl,
      },
      body: `queryStartDate=${startFmt}&queryEndDate=${endFmt}&commodityId=TXF`,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const txt = new TextDecoder('big5').decode(await res.arrayBuffer());
    const lines = txt.trim().split(/\r?\n/);
    for (const line of lines.slice(1)) {
      const cols = line.split(',').map((s) => s.trim());
      if (cols.length < 15 || !/^\d{4}\/\d{2}\/\d{2}$/.test(cols[0])) continue;
      const date = cols[0].replace(/\//g, '');
      const role = cols[2];
      const longOI = num(cols[9]);
      const shortOI = num(cols[11]);
      const netOI = num(cols[13]);
      if (longOI == null || shortOI == null || netOI == null) continue;
      const entry = {
        longOI,
        shortOI,
        netOI,
        longAmt: num(cols[10]),
        shortAmt: num(cols[12]),
        netAmt: num(cols[14]),
        tradeLong: num(cols[3]),
        tradeShort: num(cols[5]),
        tradeNet: num(cols[7]),
      };
      if (!byDate.has(date)) byDate.set(date, {});
      const d = byDate.get(date);
      if (role.includes('外資')) d.foreign = entry;
      else if (role.includes('投信')) d.trust = entry;
      else if (role.includes('自營')) d.dealer = entry;
    }
  } catch {
    byDate.clear();
  }

  // Fallback: FinMind TaiwanFuturesInstitutionalInvestors (TX)
  if (byDate.size < 2) {
    const start = twDateStr(Date.now() - 45 * 86400000);
    const fm = await fetchJSON(
      `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanFuturesInstitutionalInvestors&data_id=TX&start_date=${start}`,
      {},
      2
    );
    if (Array.isArray(fm?.data)) {
      byDate.clear();
      for (const row of fm.data) {
        const date = String(row.date || '').replace(/-/g, '');
        if (!/^\d{8}$/.test(date)) continue;
        const longOI = num(row.long_open_interest_balance_volume);
        const shortOI = num(row.short_open_interest_balance_volume);
        if (longOI == null || shortOI == null) continue;
        const longAmt = num(row.long_open_interest_balance_amount);
        const shortAmt = num(row.short_open_interest_balance_amount);
        const tradeLong = num(row.long_deal_volume);
        const tradeShort = num(row.short_deal_volume);
        const entry = {
          longOI,
          shortOI,
          netOI: longOI - shortOI,
          longAmt,
          shortAmt,
          netAmt: longAmt != null && shortAmt != null ? longAmt - shortAmt : null,
          tradeLong,
          tradeShort,
          tradeNet: tradeLong != null && tradeShort != null ? tradeLong - tradeShort : null,
        };
        if (!byDate.has(date)) byDate.set(date, {});
        const d = byDate.get(date);
        const role = String(row.institutional_investors || '');
        if (role.includes('外資')) d.foreign = entry;
        else if (role.includes('投信')) d.trust = entry;
        else if (role.includes('自營')) d.dealer = entry;
      }
      sourceLabel = 'FinMind / 期交所';
    }
  }

  const dates = [...byDate.keys()]
    .filter((d) => byDate.get(d)?.foreign)
    .sort();
  if (!dates.length) throw new Error('TAIFEX Foreign OI: no data');

  const kToYi = (k) => (k != null ? +(k / 1e5).toFixed(2) : null);
  const buildDayRecord = (date, cur, prevD) => {
    const roles = [
      ['dealer', '自營商'],
      ['trust', '投信'],
      ['foreign', '外資及陸資'],
    ];
    const rows = [];
    let totLong = 0, totShort = 0, totNet = 0, totTradeNet = 0, totNetAmt = 0;
    let hasTrade = false, hasAmt = false;
    let prevTotNet = 0, hasPrevTot = Boolean(prevD);

    for (const [k, label] of roles) {
      const c = cur[k];
      if (!c) continue;
      const p = prevD?.[k];
      const chg = p ? c.netOI - p.netOI : null;
      totLong += c.longOI;
      totShort += c.shortOI;
      totNet += c.netOI;
      if (p) prevTotNet += p.netOI;
      else hasPrevTot = false;
      if (c.tradeNet != null) { totTradeNet += c.tradeNet; hasTrade = true; }
      if (c.netAmt != null) { totNetAmt += c.netAmt; hasAmt = true; }
      rows.push({
        role: label,
        longOI: c.longOI,
        shortOI: c.shortOI,
        netOI: c.netOI,
        chg,
        netAmtYi: kToYi(c.netAmt),
        tradeNet: c.tradeNet ?? null,
      });
    }
    const totalChg = hasPrevTot ? totNet - prevTotNet : null;
    rows.push({
      role: '合計',
      longOI: totLong,
      shortOI: totShort,
      netOI: totNet,
      chg: totalChg,
      netAmtYi: hasAmt ? kToYi(totNetAmt) : null,
      tradeNet: hasTrade ? totTradeNet : null,
    });

    const fChg = prevD?.foreign ? cur.foreign.netOI - prevD.foreign.netOI : null;
    const tChg = cur.trust && prevD?.trust ? cur.trust.netOI - prevD.trust.netOI : null;
    const dChg = cur.dealer && prevD?.dealer ? cur.dealer.netOI - prevD.dealer.netOI : null;
    return {
      date,
      foreign: cur.foreign.netOI,
      foreignChg: fChg,
      longOI: cur.foreign.longOI,
      shortOI: cur.foreign.shortOI,
      foreignAmtYi: kToYi(cur.foreign.netAmt),
      trust: cur.trust?.netOI ?? null,
      trustChg: tChg,
      dealer: cur.dealer?.netOI ?? null,
      dealerChg: dChg,
      total: totNet,
      totalChg,
      net: cur.foreign.netOI,
      chg: fChg ?? 0,
      rows,
    };
  };

  const allHistory = dates.map((d, i) => buildDayRecord(d, byDate.get(d), i > 0 ? byDate.get(dates[i - 1]) : null));
  const history = allHistory.slice(-30);
  const latestRec = allHistory[allHistory.length - 1];
  const prevRec = allHistory.length >= 2 ? allHistory[allHistory.length - 2] : null;

  return {
    key: 'FUT_OI',
    name: '外資期貨多空口數淨額',
    symbol: 'TAIFEX TXF Foreign OI',
    group: 'twchip',
    currency: '口',
    price: latestRec.foreign,
    prevClose: prevRec ? prevRec.foreign : latestRec.foreign,
    chg: latestRec.foreignChg ?? 0,
    longOI: latestRec.longOI,
    shortOI: latestRec.shortOI,
    trustNetOI: latestRec.trust,
    trustChg: latestRec.trustChg,
    dealerNetOI: latestRec.dealer,
    dealerChg: latestRec.dealerChg,
    totalNetOI: latestRec.total,
    totalChg: latestRec.totalChg,
    rows: latestRec.rows,
    history,
    date: latestRec.date,
    time: Date.now(),
    tz: 'Asia/Taipei',
    source: sourceLabel,
  };
}

// ---------- 期交所：三大法人臺指選擇權（外資選擇權多空總數淨額 & 單日增減 + 買權/賣權分計明細）----------
async function fetchTaifexOptionOi() {
  const byDate = new Map();
  let sourceLabel = '期交所';

  const putEntry = (date, cpType, roleKey, entry) => {
    if (!byDate.has(date)) byDate.set(date, {});
    const dayObj = byDate.get(date);
    if (!dayObj[roleKey]) dayObj[roleKey] = {};
    dayObj[roleKey][cpType] = entry;
  };

  try {
    const startFmt = twDateStr(Date.now() - 45 * 86400000).replace(/-/g, '/');
    const viewUrl = 'https://www.taifex.com.tw/cht/3/callsAndPutsDateView';
    const endFmt = await resolveTaifexEndFmt(viewUrl);
    const res = await fetch('https://www.taifex.com.tw/cht/3/callsAndPutsDateDown', {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: viewUrl,
      },
      body: `queryStartDate=${startFmt}&queryEndDate=${endFmt}&commodityId=TXO`,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const txt = new TextDecoder('big5').decode(await res.arrayBuffer());
    const lines = txt.trim().split(/\r?\n/);
    for (const line of lines.slice(1)) {
      const cols = line.split(',').map((s) => s.trim());
      if (cols.length < 15 || !/^\d{4}\/\d{2}\/\d{2}$/.test(cols[0])) continue;
      const date = cols[0].replace(/\//g, '');
      const cpRaw = String(cols[2] || '').toUpperCase();
      const cpType = cpRaw === 'CALL' || cpRaw.includes('買權') ? 'call' : (cpRaw === 'PUT' || cpRaw.includes('賣權') ? 'put' : null);
      const role = String(cols[3] || '');
      const roleKey = role.includes('外資') ? 'foreign' : role.includes('投信') ? 'trust' : role.includes('自營') ? 'dealer' : null;
      const longOI = num(cols[10]);
      const shortOI = num(cols[12]);
      const netOI = num(cols[14]);
      if (!cpType || !roleKey || longOI == null || shortOI == null || netOI == null) continue;
      putEntry(date, cpType, roleKey, {
        longOI,
        shortOI,
        netOI,
        longAmt: num(cols[11]),
        shortAmt: num(cols[13]),
        netAmt: num(cols[15]),
        tradeLong: num(cols[4]),
        tradeShort: num(cols[6]),
        tradeNet: num(cols[8]),
      });
    }
  } catch {
    byDate.clear();
  }

  // Fallback: FinMind TaiwanOptionInstitutionalInvestors (TXO)
  if (byDate.size < 2) {
    const start = twDateStr(Date.now() - 45 * 86400000);
    const fm = await fetchJSON(
      `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanOptionInstitutionalInvestors&data_id=TXO&start_date=${start}`,
      {},
      2
    );
    if (Array.isArray(fm?.data)) {
      byDate.clear();
      for (const row of fm.data) {
        const date = String(row.date || '').replace(/-/g, '');
        if (!/^\d{8}$/.test(date)) continue;
        const cpStr = String(row.call_put || '');
        const cpType = cpStr.includes('買') || cpStr.toUpperCase() === 'CALL' ? 'call' : (cpStr.includes('賣') || cpStr.toUpperCase() === 'PUT' ? 'put' : null);
        const role = String(row.institutional_investors || '');
        const roleKey = role.includes('外資') ? 'foreign' : role.includes('投信') ? 'trust' : role.includes('自營') ? 'dealer' : null;
        const longOI = num(row.long_open_interest_balance_volume);
        const shortOI = num(row.short_open_interest_balance_volume);
        if (!cpType || !roleKey || longOI == null || shortOI == null) continue;
        const longAmt = num(row.long_open_interest_balance_amount);
        const shortAmt = num(row.short_open_interest_balance_amount);
        const tradeLong = num(row.long_deal_volume);
        const tradeShort = num(row.short_deal_volume);
        putEntry(date, cpType, roleKey, {
          longOI,
          shortOI,
          netOI: longOI - shortOI,
          longAmt,
          shortAmt,
          netAmt: longAmt != null && shortAmt != null ? longAmt - shortAmt : null,
          tradeLong,
          tradeShort,
          tradeNet: tradeLong != null && tradeShort != null ? tradeLong - tradeShort : null,
        });
      }
      sourceLabel = 'FinMind / 期交所';
    }
  }

  const dates = [...byDate.keys()]
    .filter((d) => byDate.get(d)?.foreign?.call && byDate.get(d)?.foreign?.put)
    .sort();
  if (!dates.length) throw new Error('TAIFEX Option OI: no data');

  const kToYi = (k) => (k != null ? +(k / 1e5).toFixed(2) : null);
  // 依期交所口徑：看多 = 買權買方 + 賣權賣方；看空 = 買權賣方 + 賣權買方；多空淨額 = 買權淨額 - 賣權淨額
  const summarizeRole = (rec) => {
    if (!rec?.call && !rec?.put) return null;
    const c = rec.call || { longOI: 0, shortOI: 0, netOI: 0, netAmt: null, tradeNet: null };
    const p = rec.put || { longOI: 0, shortOI: 0, netOI: 0, netAmt: null, tradeNet: null };
    const bullOI = c.longOI + p.shortOI;
    const bearOI = c.shortOI + p.longOI;
    const netOI = c.netOI - p.netOI;
    const netAmt = c.netAmt != null && p.netAmt != null ? c.netAmt - p.netAmt : null;
    const tradeNet = c.tradeNet != null && p.tradeNet != null ? c.tradeNet - p.tradeNet : null;
    return {
      bullOI,
      bearOI,
      netOI,
      netAmt,
      tradeNet,
      callLongOI: c.longOI,
      callShortOI: c.shortOI,
      callNetOI: c.netOI,
      callNetAmtYi: kToYi(c.netAmt),
      callTradeNet: c.tradeNet ?? null,
      putLongOI: p.longOI,
      putShortOI: p.shortOI,
      putNetOI: p.netOI,
      putNetAmtYi: kToYi(p.netAmt),
      putTradeNet: p.tradeNet ?? null,
    };
  };

  const buildDayRecord = (date, cur, prevD) => {
    const roles = [
      ['dealer', '自營商'],
      ['trust', '投信'],
      ['foreign', '外資及陸資'],
    ];
    const sumByRole = {};
    const rows = [];
    let totBull = 0, totBear = 0, totNet = 0, totCallNet = 0, totPutNet = 0, totNetAmt = 0, totTradeNet = 0;
    let hasAmt = false, hasTrade = false;
    let prevTotNet = 0, hasPrevTot = Boolean(prevD);

    for (const [rk, label] of roles) {
      const s = summarizeRole(cur[rk]);
      if (!s) continue;
      sumByRole[rk] = s;
      const ps = summarizeRole(prevD?.[rk]);
      const chg = ps ? s.netOI - ps.netOI : null;
      totBull += s.bullOI;
      totBear += s.bearOI;
      totNet += s.netOI;
      totCallNet += s.callNetOI;
      totPutNet += s.putNetOI;
      if (ps) prevTotNet += ps.netOI;
      else hasPrevTot = false;
      if (s.netAmt != null) { totNetAmt += s.netAmt; hasAmt = true; }
      if (s.tradeNet != null) { totTradeNet += s.tradeNet; hasTrade = true; }

      rows.push({
        role: label,
        bullOI: s.bullOI,
        bearOI: s.bearOI,
        netOI: s.netOI,
        chg,
        netAmtYi: kToYi(s.netAmt),
        tradeNet: s.tradeNet,
        callLongOI: s.callLongOI,
        callShortOI: s.callShortOI,
        callNetOI: s.callNetOI,
        callChg: ps ? s.callNetOI - ps.callNetOI : null,
        callNetAmtYi: s.callNetAmtYi,
        callTradeNet: s.callTradeNet,
        putLongOI: s.putLongOI,
        putShortOI: s.putShortOI,
        putNetOI: s.putNetOI,
        putChg: ps ? s.putNetOI - ps.putNetOI : null,
        putNetAmtYi: s.putNetAmtYi,
        putTradeNet: s.putTradeNet,
      });
    }

    const totalChg = hasPrevTot ? totNet - prevTotNet : null;
    rows.push({
      role: '合計',
      bullOI: totBull,
      bearOI: totBear,
      netOI: totNet,
      chg: totalChg,
      netAmtYi: hasAmt ? kToYi(totNetAmt) : null,
      tradeNet: hasTrade ? totTradeNet : null,
      callNetOI: totCallNet,
      putNetOI: totPutNet,
    });

    const f = sumByRole.foreign;
    const pf = summarizeRole(prevD?.foreign);
    const t = sumByRole.trust;
    const pt = summarizeRole(prevD?.trust);
    const dl = sumByRole.dealer;
    const pdl = summarizeRole(prevD?.dealer);
    const fChg = pf ? f.netOI - pf.netOI : null;

    return {
      date,
      foreign: f.netOI,
      foreignChg: fChg,
      bullOI: f.bullOI,
      bearOI: f.bearOI,
      callNetOI: f.callNetOI,
      putNetOI: f.putNetOI,
      foreignAmtYi: kToYi(f.netAmt),
      callAmtYi: f.callNetAmtYi,
      putAmtYi: f.putNetAmtYi,
      trust: t?.netOI ?? null,
      trustChg: t && pt ? t.netOI - pt.netOI : null,
      dealer: dl?.netOI ?? null,
      dealerChg: dl && pdl ? dl.netOI - pdl.netOI : null,
      total: totNet,
      totalChg,
      net: f.netOI,
      chg: fChg ?? 0,
      rows,
    };
  };

  const allHistory = dates.map((d, i) => buildDayRecord(d, byDate.get(d), i > 0 ? byDate.get(dates[i - 1]) : null));
  const history = allHistory.slice(-30);
  const latestRec = allHistory[allHistory.length - 1];
  const prevRec = allHistory.length >= 2 ? allHistory[allHistory.length - 2] : null;

  return {
    key: 'OPT_OI',
    name: '外資選擇權多空總數淨額',
    symbol: 'TAIFEX TXO Foreign OI',
    group: 'twchip',
    currency: '口',
    price: latestRec.foreign,
    prevClose: prevRec ? prevRec.foreign : latestRec.foreign,
    chg: latestRec.foreignChg ?? 0,
    bullOI: latestRec.bullOI,
    bearOI: latestRec.bearOI,
    callNetOI: latestRec.callNetOI,
    putNetOI: latestRec.putNetOI,
    foreignAmtYi: latestRec.foreignAmtYi,
    callAmtYi: latestRec.callAmtYi,
    putAmtYi: latestRec.putAmtYi,
    trustNetOI: latestRec.trust,
    trustChg: latestRec.trustChg,
    dealerNetOI: latestRec.dealer,
    dealerChg: latestRec.dealerChg,
    totalNetOI: latestRec.total,
    totalChg: latestRec.totalChg,
    rows: latestRec.rows,
    history,
    date: latestRec.date,
    time: Date.now(),
    tz: 'Asia/Taipei',
    source: sourceLabel,
  };
}

async function fetchTwseFmtqik() {
  const j = await fetchJSON('https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?response=json', {
    headers: { Referer: 'https://www.twse.com.tw/zh/afterTrading/fmtqik.html' },
  }, 2);
  if (j?.stat !== 'OK' || !Array.isArray(j.data) || !j.data.length) return null;
  const last = j.data[j.data.length - 1];
  const date = rocToIso(last[0]);
  const close = num(last[4]);
  const chg = num(last[5]);
  const amountTwd = num(last[2]);
  if (!date || close == null) return null;
  return {
    date,
    close,
    chg,
    prevClose: chg != null ? +(close - chg).toFixed(2) : null,
    shares: num(last[1]),
    turnoverYi: amountTwd != null ? +(amountTwd / 1e8).toFixed(2) : null,
  };
}

async function fetchTwseStockDay(stockNo) {
  const j = await fetchJSON(`https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?response=json&stockNo=${encodeURIComponent(stockNo)}`, {
    headers: { Referer: 'https://www.twse.com.tw/zh/afterTrading/stock-day.html' },
  }, 2);
  if (j?.stat !== 'OK' || !Array.isArray(j.data) || !j.data.length) return null;
  const last = j.data[j.data.length - 1];
  const date = rocToIso(last[0]);
  const volume = num(last[1]); // 總成交股數（含盤中零股、盤後定價/零股）
  const amountTwd = num(last[2]);
  const open = num(last[3]);
  const high = num(last[4]);
  const low = num(last[5]);
  const close = num(last[6]);
  const chgRaw = String(last[7] || '').trim();
  const isEx = /^[Xx]/.test(chgRaw); // 除權息日為 X 開頭，不可直接用 close - chg 推算昨收參考價
  const chg = isEx ? null : num(chgRaw);
  if (!date || close == null) return null;
  return {
    date,
    volume,
    turnoverYi: amountTwd != null ? +(amountTwd / 1e8).toFixed(2) : null,
    open,
    high,
    low,
    close,
    isEx,
    prevClose: chg != null ? +(close - chg).toFixed(2) : null,
  };
}

async function loadPrevious() {
  const [remoteRes, localRes] = await Promise.allSettled([
    fetchJSON(`${SITE_URL.replace(/\/?$/, '/')}data.json?_=${Date.now()}`, {}, 1),
    readFile('site/data.json', 'utf8').then((s) => JSON.parse(s)),
  ]);
  const candidates = [remoteRes, localRes]
    .filter((r) => r.status === 'fulfilled' && r.value?.version === SCHEMA_VERSION && r.value?.quotes)
    .map((r) => r.value)
    .sort((a, b) => (b.generatedAt || 0) - (a.generatedAt || 0));
  return candidates[0] || null;
}

async function main() {
  const prev = await loadPrevious();
  const quotes = {};
  const errors = [];

  const results = await Promise.allSettled(SYMBOLS.map(fetchYahoo));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') quotes[SYMBOLS[i].key] = r.value;
    else {
      errors.push(`${SYMBOLS[i].y}: ${r.reason?.message}`);
      // 抓不到時沿用上一版（並標記 stale），避免畫面空白
      const old = prev?.version === SCHEMA_VERSION ? prev.quotes?.[SYMBOLS[i].key] : null;
      if (old) quotes[SYMBOLS[i].key] = { ...old, stale: true };
    }
  });

  // 櫃買指數兩年日 K + 最新官方開高低收（FinMind + 櫃買中心 OpenAPI）
  let tpexInfo = { bars: [], latest: null, turnoverByDate: new Map() };
  try {
    const oldTpex = prev?.version === SCHEMA_VERSION ? prev.quotes?.TPEX : null;
    if (!quotes.TPEX) {
      quotes.TPEX = {
        key: 'TPEX', name: '台灣櫃買指數', symbol: 'IX0043.TWO', group: 'tw',
        currency: 'TWD', price: null, prevClose: null, open: null, high: null, low: null,
        volume: null, time: 0, session: null, tz: 'Asia/Taipei', source: 'FinMind',
        intraday: [], daily: [],
      };
    }
    tpexInfo = await fetchTpexDaily(oldTpex?.daily);
    if (tpexInfo.bars.length) quotes.TPEX.daily = tpexInfo.bars;
  } catch (e) {
    errors.push(`TPEX daily: ${e.message}`);
  }

  // CNN 恐慌貪婪指數
  try {
    quotes.FGI = await fetchCnnFearGreed();
  } catch (e) {
    errors.push(`CNN FGI: ${e.message}`);
    const old = prev?.version === SCHEMA_VERSION ? prev.quotes?.FGI : null;
    if (old) quotes.FGI = { ...old, stale: true };
  }

  // 台股恐慌指數（臺指選擇權波動率指數 VIXTWN）
  try {
    const oldVixTwn = prev?.version === SCHEMA_VERSION ? prev.quotes?.VIXTWN : null;
    quotes.VIXTWN = await fetchTaiwanVix(oldVixTwn);
  } catch (e) {
    errors.push(`TAIFEX VIXTWN: ${e.message}`);
    const old = prev?.version === SCHEMA_VERSION ? prev.quotes?.VIXTWN : null;
    if (old) quotes.VIXTWN = { ...old, stale: true };
  }

  // 證交所 MIS 覆寫（即時真實報價），優先於延遲的 Yahoo
  try {
    const mis = await fetchTwseMis();
    for (const [k, v] of Object.entries(mis)) {
      const q = quotes[k];
      if (!q) continue;
      if (v.price != null && v.price > 0) {
        if (v.prevClose != null) q.prevClose = v.prevClose;
        const vDate = v.time ? twDateStr(v.time) : null;
        const qDate = q.time ? twDateStr(q.time) : null;
        const sameDay = !vDate || !qDate || vDate === qDate;
        q.price = v.price;
        if (v.open != null) q.open = v.open;
        if (v.high != null) q.high = sameDay ? Math.max(q.high ?? -Infinity, v.high, v.price) : Math.max(v.high, v.price);
        if (v.low != null) q.low = sameDay ? Math.min(q.low ?? Infinity, v.low, v.price) : Math.min(v.low, v.price);
        if (v.volume != null) q.volume = v.volume;
        if (v.time != null) q.time = v.time;
        q.source = '證交所 MIS';
        q.stale = false;
        if (Array.isArray(q.intraday) && v.time) {
          const old = prev?.version === SCHEMA_VERSION ? prev.quotes?.[k] : null;
          const sameDayYahoo = q.intraday.filter((p) => Array.isArray(p) && p[1] != null && (!vDate || twDateStr(p[0]) === vDate));
          const yLast = sameDayYahoo.length ? sameDayYahoo[sameDayYahoo.length - 1][0] : 0;
          const mergedMap = new Map(sameDayYahoo.map((p) => [p[0], p]));
          if (Array.isArray(old?.intraday)) {
            for (const p of old.intraday) {
              if (Array.isArray(p) && p[1] != null && (!vDate || twDateStr(p[0]) === vDate) && p[0] > yLast) {
                mergedMap.set(p[0], p);
              }
            }
          }
          mergedMap.set(v.time, [v.time, v.price]);
          q.intraday = [...mergedMap.values()].sort((a, b) => a[0] - b[0]);
        }
      }
    }
  } catch (e) {
    errors.push(`TWSE MIS: ${e.message}`);
  }

  let txfSpot = null;
  for (const mt of [0, 1]) {
    try {
      const { quote: f, spot } = await fetchTaifex(mt);
      if (spot) txfSpot = spot;
      // 累積期貨盤中走勢（從上一版 data.json 接續，換交易時段就重置）
      const old = prev?.version === SCHEMA_VERSION ? prev.quotes?.[f.key] : null;
      let series = old && old.sessionDate === f.sessionDate && old.symbol === f.symbol ? old.intraday || [] : [];
      if (f.price != null && f.time && (!series.length || series[series.length - 1][0] < f.time)) {
        series = [...series, [f.time, f.price]];
      }
      f.intraday = series.slice(-600);
      quotes[f.key] = f;
    } catch (e) {
      errors.push(`TAIFEX ${mt}: ${e.message}`);
      const k = mt ? 'TXF_N' : 'TXF_D';
      const old = prev?.version === SCHEMA_VERSION ? prev.quotes?.[k] : null;
      if (old) quotes[k] = { ...old, stale: true };
    }
  }

  // 台股官方交叉校準：當證交所 MIS 盤後 503 或個股盤後定價/零股總量差異時，以期交所 TXF-S、證交所 FMTQIK / STOCK_DAY 與櫃買 OpenAPI 校準
  const [fmtqikRes, sd2330Res, sd0050Res] = await Promise.allSettled([
    fetchTwseFmtqik(),
    fetchTwseStockDay('2330'),
    fetchTwseStockDay('0050'),
  ]);
  const fmtqik = fmtqikRes.status === 'fulfilled' ? fmtqikRes.value : null;
  const stockDays = {
    2330: sd2330Res.status === 'fulfilled' ? sd2330Res.value : null,
    '0050': sd0050Res.status === 'fulfilled' ? sd0050Res.value : null,
  };

  if (quotes.TWII) {
    const q = quotes.TWII;
    let qDate = q.time ? twDateStr(q.time) : null;
    if (txfSpot && (!qDate || txfSpot.date >= qDate)) {
      if (!q.source?.includes('證交所 MIS')) {
        q.price = txfSpot.price;
        if (txfSpot.prevClose != null) q.prevClose = txfSpot.prevClose;
        if (txfSpot.open != null) q.open = txfSpot.open;
        if (txfSpot.high != null) q.high = Math.max(txfSpot.high, txfSpot.price);
        if (txfSpot.low != null) q.low = Math.min(txfSpot.low, txfSpot.price);
        q.time = txfSpot.time;
        q.source = '期交所現貨';
        q.stale = false;
        qDate = txfSpot.date;
      } else if (txfSpot.date === qDate && q.prevClose == null && txfSpot.prevClose != null) {
        q.prevClose = txfSpot.prevClose;
      }
    }
    if (fmtqik) {
      if (qDate === fmtqik.date) {
        if (fmtqik.turnoverYi != null) q.turnoverYi = fmtqik.turnoverYi;
        if (fmtqik.prevClose != null) q.prevClose = fmtqik.prevClose;
        if (fmtqik.close != null && !q.source?.includes('證交所 MIS')) {
          q.price = fmtqik.close;
          q.source = q.source?.includes('期交所') ? '期交所現貨 / 證交所盤後' : '證交所盤後';
          q.stale = false;
        }
        if (Array.isArray(q.daily) && q.daily.length) {
          const lastBar = q.daily[q.daily.length - 1];
          if (twDateStr(lastBar[0]) === fmtqik.date) lastBar[4] = fmtqik.close;
        }
      } else if (!q.source?.includes('證交所 MIS') && !txfSpot && qDate && qDate > fmtqik.date && Array.isArray(q.daily)) {
        let prevBar = null;
        for (let i = q.daily.length - 1; i >= 0; i--) {
          if (twDateStr(q.daily[i][0]) < qDate) { prevBar = q.daily[i]; break; }
        }
        if (prevBar && twDateStr(prevBar[0]) === fmtqik.date) q.prevClose = fmtqik.close;
      }
    }
  }

  if (quotes.TPEX) {
    const q = quotes.TPEX;
    const qDate = q.time ? twDateStr(q.time) : tpexInfo.latest?.date || null;
    if (qDate && tpexInfo.turnoverByDate.has(qDate)) {
      q.turnoverYi = tpexInfo.turnoverByDate.get(qDate);
    }
    if (tpexInfo.latest && (!qDate || tpexInfo.latest.date === qDate)) {
      if (!q.source?.includes('證交所 MIS')) {
        if (tpexInfo.latest.prevClose != null) q.prevClose = tpexInfo.latest.prevClose;
        if (tpexInfo.latest.open != null) q.open = tpexInfo.latest.open;
        if (tpexInfo.latest.high != null) q.high = tpexInfo.latest.high;
        if (tpexInfo.latest.low != null) q.low = tpexInfo.latest.low;
        if (tpexInfo.latest.close != null) q.price = tpexInfo.latest.close;
        if (!q.time) q.time = twDayTs(tpexInfo.latest.date);
        q.source = '櫃買中心 OpenAPI';
        q.stale = false;
      } else if (tpexInfo.latest.prevClose != null && q.prevClose == null) {
        q.prevClose = tpexInfo.latest.prevClose;
      }
    }
  }

  for (const key of ['2330', '0050']) {
    const q = quotes[key];
    const sd = stockDays[key];
    if (!q || !sd) continue;
    const qDate = q.time ? twDateStr(q.time) : null;
    if (qDate === sd.date) {
      // 以證交所 STOCK_DAY 官方總成交股數（含盤後零股與定價交易）補強 MIS 盤中股數
      if (sd.volume != null && sd.volume > 0) q.volume = Math.max(q.volume ?? 0, sd.volume);
      if (sd.turnoverYi != null) q.turnoverYi = sd.turnoverYi;
      if (!q.source?.includes('證交所 MIS')) {
        if (sd.open != null) q.open = sd.open;
        if (sd.high != null) q.high = sd.high;
        if (sd.low != null) q.low = sd.low;
        if (sd.close != null) q.price = sd.close;
        if (sd.prevClose != null) q.prevClose = sd.prevClose;
        q.source = '證交所盤後';
        q.stale = false;
      }
      if (Array.isArray(q.daily) && q.daily.length) {
        const bar = q.daily.find((b) => twDateStr(b[0]) === sd.date);
        if (bar) {
          if (sd.open != null) bar[1] = sd.open;
          if (sd.high != null) bar[2] = sd.high;
          if (sd.low != null) bar[3] = sd.low;
          if (sd.close != null) bar[4] = sd.close;
          if (sd.volume != null) bar[5] = sd.volume;
        }
      }
    }
  }

  // 證交所融資餘額、外資買賣超、期交所外資期貨多空淨口數 & 選擇權多空總數淨額（盤後更新；盤中沿用前一交易日快照）
  for (const [key, fn, label] of [
    ['MARGIN', fetchTwseMargin, 'TWSE Margin'],
    ['INST', fetchTwseInst, 'TWSE Inst'],
    ['FUT_OI', fetchTaifexForeignOi, 'TAIFEX Foreign OI'],
    ['OPT_OI', fetchTaifexOptionOi, 'TAIFEX Option OI'],
  ]) {
    const old = prev?.version === SCHEMA_VERSION ? prev.quotes?.[key] : null;
    try {
      const item = await fn(old);
      if (!Array.isArray(item.history) || !item.history.length) {
        const prevHist = Array.isArray(old?.history) ? old.history : [];
        const entry = key === 'MARGIN'
          ? { date: item.date, v: item.price, chg: item.chg }
          : key === 'INST'
          ? { date: item.date, v: item.foreignYi, total: item.totalYi, exact: true }
          : key === 'OPT_OI'
          ? { date: item.date, net: item.price, chg: item.chg, bullOI: item.bullOI, bearOI: item.bearOI, callNetOI: item.callNetOI, putNetOI: item.putNetOI }
          : { date: item.date, net: item.price, chg: item.chg, longOI: item.longOI, shortOI: item.shortOI };
        const filtered = prevHist.filter((h) => h.date !== item.date && (key !== 'INST' || h.exact));
        item.history = [...filtered, entry].slice(-30);
      }
      quotes[key] = item;
    } catch (e) {
      errors.push(`${label}: ${e.message}`);
      if (old) quotes[key] = { ...old, stale: true };
    }
  }

  const data = { version: SCHEMA_VERSION, generatedAt: Date.now(), quotes, errors };
  await mkdir('site', { recursive: true });
  await writeFile('site/data.json', JSON.stringify(data));
  console.log(`Wrote site/data.json with ${Object.keys(quotes).length} quotes`);
  for (const q of Object.values(quotes)) {
    const chg = q.price != null && q.prevClose != null ? q.price - q.prevClose : null;
    console.log(`  ${q.key.padEnd(7)} ${String(q.price).padStart(10)}  prev ${String(q.prevClose).padStart(10)}  chg ${chg?.toFixed(2)}  [${q.source}]`);
  }
  if (errors.length) console.warn('Errors:\n  ' + errors.join('\n  '));
  if (Object.keys(quotes).length === 0) process.exit(1);
}

main();
