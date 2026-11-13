// 由 GitHub Actions 執行：抓取真實市場數據並輸出 site/data.json
// 資料來源：Yahoo Finance (chart / spark)、期交所 MIS、證交所 MIS（若可連線）
// Node 20+（內建 fetch）

import { writeFile, mkdir } from 'node:fs/promises';

const SCHEMA_VERSION = 3;
const SITE_URL = process.env.SITE_URL || 'https://johntsai0320.github.io/stock/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// key, Yahoo symbol, 顯示名稱, 分組, TWSE MIS 代碼
export const SYMBOLS = [
  { key: 'TWII', y: '^TWII', name: '台灣加權指數', group: 'tw', mis: 'tse_t00.tw' },
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
  // 昨收：range=1d 時 previousClose / chartPreviousClose 皆為「前一交易日收盤」
  // （注意：長區間的 chartPreviousClose 是區間起點前的收盤，不可拿來當昨收）
  const prevClose = num(m.previousClose) ?? num(m.chartPreviousClose);
  const intraday = parseIntraday(intra);
  const quotes = intra.indicators?.quote?.[0] || {};
  const highs = (quotes.high || []).filter((v) => v != null);
  const lows = (quotes.low || []).filter((v) => v != null);
  const opens = (quotes.open || []).filter((v) => v != null);
  return {
    key: def.key,
    name: def.name,
    symbol: def.y,
    group: def.group,
    currency: m.currency,
    price: num(m.regularMarketPrice),
    prevClose,
    open: opens[0] ?? null,
    high: num(m.regularMarketDayHigh) ?? (highs.length ? Math.max(...highs) : null),
    low: num(m.regularMarketDayLow) ?? (lows.length ? Math.min(...lows) : null),
    volume: num(m.regularMarketVolume),
    time: (m.regularMarketTime || 0) * 1000,
    session: m.currentTradingPeriod?.regular
      ? { start: m.currentTradingPeriod.regular.start * 1000, end: m.currentTradingPeriod.regular.end * 1000 }
      : null,
    tz: m.exchangeTimezoneName,
    source: 'Yahoo Finance',
    intraday,
    daily: daily ? parseDaily(daily) : [],
  };
}

// ---------- TWSE MIS（海外 IP 可能被擋，失敗即略過，以 Yahoo 為準）----------
function extractTwsePrice(it) {
  const z = num(it.z);
  if (z != null) return z;
  const tz = num(it.trade?.z);
  if (tz != null) return tz;
  const pz = num(it.pz);
  if (pz != null) return pz;
  const b1 = num(it.b?.split('_')?.[0]);
  const a1 = num(it.a?.split('_')?.[0]);
  if (b1 != null && a1 != null) return (b1 + a1) / 2;
  return b1 ?? a1 ?? null;
}

async function fetchTwseMis() {
  const chs = SYMBOLS.filter((s) => s.mis).map((s) => s.mis).join('|');
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(chs)}&json=1&delay=0&_=${Date.now()}`;
  const j = await fetchJSON(url, { headers: { Referer: 'https://mis.twse.com.tw/stock/index.jsp' } }, 1);
  const out = {};
  for (const it of j.msgArray || []) {
    const key = SYMBOLS.find((s) => s.mis && s.mis.startsWith(`${it.ex}_${it.c}.`))?.key;
    if (!key) continue;
    const price = extractTwsePrice(it);
    out[key] = {
      price,
      prevClose: num(it.y),
      open: num(it.o),
      high: num(it.h),
      low: num(it.l),
      volume: num(it.v),
      time: num(it.tlong) || Date.now(),
    };
  }
  return out;
}

// ---------- TAIFEX MIS 台指期 ----------
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
  const ref = num(q.CRefPrice); // 日盤 = 昨日結算價；夜盤 = 當日日盤結算價（期交所提供）
  const last = num(q.CLastPrice);
  const d = q.CDate; // 交易時段起始日
  let time = null;
  if (d && q.CTime) {
    const hh = +q.CTime.slice(0, 2), mm = +q.CTime.slice(2, 4), ss = +q.CTime.slice(4, 6);
    // 以台北時間 (UTC+8) 建立時間戳；夜盤跨日（00:00~05:00）需 +1 天
    time = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), hh - 8, mm, ss);
    if (night && hh < 12) time += 86400000;
  }
  return {
    key: night ? 'TXF_N' : 'TXF_D',
    name: night ? '台指期（夜盤）' : '台指期（日盤）',
    symbol: q.SymbolID,
    contract: q.DispCName,
    group: 'fut',
    currency: 'TWD',
    price: last,
    prevClose: ref,
    open: num(q.COpenPrice),
    high: num(q.CHighPrice),
    low: num(q.CLowPrice),
    volume: num(q.CTotalVolume),
    bid: num(q.CBidPrice1),
    ask: num(q.CAskPrice1),
    settlement: num(q.SettlementPrice),
    sessionDate: d,
    time,
    source: '期交所 MIS',
    intraday: [],
    daily: [],
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
  const hist = (j?.fear_and_greed_historical?.data || [])
    .filter((p) => p && p.x != null && p.y != null)
    .map((p) => {
      const v = +Number(p.y).toFixed(1);
      return [Number(p.x), v, v, v, v, 0];
    })
    .sort((a, b) => a[0] - b[0]);
  const intraday = hist.slice(-60).map((d) => [d[0], d[4]]);
  const recent7 = hist.slice(-7).map((d) => d[4]);
  return {
    key: 'FGI',
    name: 'CNN 恐慌貪婪指數',
    symbol: 'CNN F&G',
    group: 'usidx',
    currency: 'PTS',
    price,
    prevClose,
    open: prevClose,
    high: recent7.length ? Math.max(...recent7, price) : price,
    low: recent7.length ? Math.min(...recent7, price) : price,
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

async function fetchTwseInst() {
  const j = await fetchJSON('https://www.twse.com.tw/rwd/zh/fund/BFI82U?response=json&type=day', {
    headers: { Referer: 'https://www.twse.com.tw/zh/trading/foreign/bfi82u.html' },
  });
  if (j?.stat !== 'OK' || !Array.isArray(j.data)) {
    throw new Error(`TWSE BFI82U stat=${j?.stat || 'unknown'}`);
  }
  const byName = (kw) => {
    const row = j.data.find((r) => String(r[0]).includes(kw));
    return row ? num(row[3]) : 0;
  };
  const foreignNet = (byName('外資及陸資') ?? 0) + (byName('外資自營商') ?? 0);
  const trustNet = byName('投信') ?? 0;
  const dealerNet = (byName('自營商(自行買賣)') ?? 0) + (byName('自營商(避險)') ?? 0);
  const totalNet = byName('合計') ?? (foreignNet + trustNet + dealerNet);
  const toYi = (v) => +(v / 1e8).toFixed(2);
  const foreignYi = toYi(foreignNet);
  const trustYi = toYi(trustNet);
  const dealerYi = toYi(dealerNet);
  const totalYi = toYi(totalNet);
  return {
    key: 'INST',
    name: '外資買賣超',
    symbol: 'TWSE Foreign Net',
    group: 'twchip',
    currency: '億TWD',
    price: foreignYi,
    prevClose: 0,
    foreignYi,
    trustYi,
    dealerYi,
    totalYi,
    date: j.date || '',
    time: Date.now(),
    tz: 'Asia/Taipei',
    source: '證交所三大法人',
  };
}

async function loadPrevious() {
  try {
    return await fetchJSON(`${SITE_URL.replace(/\/?$/, '/')}data.json?_=${Date.now()}`, {}, 1);
  } catch {
    return null;
  }
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

  // CNN 恐慌貪婪指數
  try {
    quotes.FGI = await fetchCnnFearGreed();
  } catch (e) {
    errors.push(`CNN FGI: ${e.message}`);
    const old = prev?.version === SCHEMA_VERSION ? prev.quotes?.FGI : null;
    if (old) quotes.FGI = { ...old, stale: true };
  }

  // 證交所 MIS 覆寫（即時真實報價），優先於延遲的 Yahoo
  try {
    const mis = await fetchTwseMis();
    for (const [k, v] of Object.entries(mis)) {
      const q = quotes[k];
      if (!q) continue;
      if (v.prevClose != null) q.prevClose = v.prevClose;
      if (v.price != null) {
        q.price = v.price;
        if (v.open != null) q.open = v.open;
        if (v.high != null) q.high = Math.max(q.high ?? -Infinity, v.high, v.price);
        if (v.low != null) q.low = Math.min(q.low ?? Infinity, v.low, v.price);
        if (v.volume != null) q.volume = v.volume;
        if (v.time != null) q.time = v.time;
        q.source = '證交所 MIS';
        q.stale = false;
        if (Array.isArray(q.intraday)) {
          const lastPt = q.intraday[q.intraday.length - 1];
          if (!lastPt || lastPt[0] < v.time) {
            q.intraday.push([v.time, v.price]);
          } else if (lastPt && lastPt[0] === v.time) {
            lastPt[1] = v.price;
          }
        }
      }
    }
  } catch (e) {
    errors.push(`TWSE MIS: ${e.message}`);
  }

  for (const mt of [0, 1]) {
    try {
      const f = await fetchTaifex(mt);
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


  // 證交所融資餘額 & 外資買賣超（盤後更新；盤中若尚未公布則沿用前一交易日快照）
  for (const [key, fn, label] of [
    ['MARGIN', fetchTwseMargin, 'TWSE Margin'],
    ['INST', fetchTwseInst, 'TWSE Inst'],
  ]) {
    try {
      const item = await fn();
      const old = prev?.version === SCHEMA_VERSION ? prev.quotes?.[key] : null;
      const prevHist = Array.isArray(old?.history) ? old.history : [];
      const entry = key === 'MARGIN'
        ? { date: item.date, v: item.price, chg: item.chg }
        : { date: item.date, v: item.foreignYi, total: item.totalYi };
      const filtered = prevHist.filter((h) => h.date !== item.date);
      item.history = [...filtered, entry].slice(-30);
      quotes[key] = item;
    } catch (e) {
      errors.push(`${label}: ${e.message}`);
      const old = prev?.version === SCHEMA_VERSION ? prev.quotes?.[key] : null;
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
