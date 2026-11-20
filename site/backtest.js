/* 股票策略回測引擎與互動圖表（布林 %b / 雙均線 / 單均線防守 / RSI / 區間突破停損 / 定期定額 DCA） */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const esc = (str) =>
    String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  const TARGET_PRESETS = [
    { key: '2330', label: '2330 台積電', fee: 'tw_stock' },
    { key: '0050', label: '0050 台灣50', fee: 'tw_etf' },
    { key: 'TWII', label: 'TWII 加權', fee: 'zero' },
    { key: 'TPEX', label: 'TPEX 櫃買', fee: 'zero' },
    { key: 'TSM', label: 'TSM ADR', fee: 'us' },
    { key: 'QQQM', label: 'QQQM', fee: 'us' },
    { key: 'VT', label: 'VT', fee: 'us' },
    { key: 'SOX', label: 'SOX 費半', fee: 'zero' },
    { key: 'GSPC', label: 'S&P 500', fee: 'zero' },
    { key: 'IXIC', label: 'IXIC 那指', fee: 'zero' },
    { key: 'DJI', label: 'DJI 道瓊', fee: 'zero' },
  ];

  const FEE_PRESETS = {
    tw_stock: { label: '台股個股（買 0.0855% / 賣 0.3855%）', buy: 0.0855, sell: 0.3855 },
    tw_etf: { label: '台股 ETF（買 0.0855% / 賣 0.1855%）', buy: 0.0855, sell: 0.1855 },
    us: { label: '美股 / ADR / ETF（零手續費 0% / 0%）', buy: 0, sell: 0 },
    zero: { label: '指數 / 無交易成本（0% / 0%）', buy: 0, sell: 0 },
    custom: { label: '自訂費率', buy: 0.1, sell: 0.1 },
  };

  const QUICK_SCENARIOS = [
    {
      id: '0050_bb',
      label: '0050：BB %b 為負買・3個月後賣',
      target: '0050',
      strategy: 'bb_pctb',
      params: { bbPeriod: 20, bbStd: 2, bbEntry: 0, bbExitMode: 'hold_months', bbHoldMonths: 3, bbSignalMode: 'single_pos', bbLotAmount: 100000, stopLossPct: 0 },
    },
    {
      id: '0050_bb_all',
      label: '0050：每次 %b < 0 各買10萬・3月後賣',
      target: '0050',
      strategy: 'bb_pctb',
      params: { bbPeriod: 20, bbStd: 2, bbEntry: 0, bbExitMode: 'hold_months', bbHoldMonths: 3, bbSignalMode: 'every_signal', bbLotAmount: 100000, stopLossPct: 0 },
    },
    {
      id: '2330_ma',
      label: '2330：5MA × 20MA 黃金交叉',
      target: '2330',
      strategy: 'ma_cross',
      params: { shortMa: 5, longMa: 20, stopLossPct: 0 },
    },
    {
      id: '0050_dca',
      label: '0050：定期定額每月 2 萬',
      target: '0050',
      strategy: 'dca',
      params: { dcaAmount: 20000, dcaFreq: 'monthly' },
    },
    {
      id: '2330_bb_brk',
      label: '2330：BB %b × BBW 真突破順勢',
      target: '2330',
      strategy: 'bb_breakout',
      params: { bbPeriod: 20, bbStd: 2, bbSqueezePct: 35, bbEntryPctB: 0.85, bbHoldConfirm: true, bbExitPctB: 0.5, stopLossPct: 0 },
    },
    {
      id: 'qqqm_rsi',
      label: 'QQQM：RSI ≤ 30 超賣買進',
      target: 'QQQM',
      strategy: 'rsi_reversion',
      params: { rsiPeriod: 14, rsiBuy: 30, rsiSell: 70, stopLossPct: 0 },
    },
  ];

  const STRATEGIES = {
    bb_pctb: {
      name: '布林通道 %b 進場（例：%b < 0 買・3個月後賣出）',
      desc: '計算 BB %b = (收盤 − 下軌) ÷ (上軌 − 下軌)；當 %b 為負（跌破布林下軌）時進場買進，可設定於 N 個月後、N 交易日後或反彈達目標 %b 時賣出，並支援單筆資金輪動或每次訊號獨立買進試算。',
    },
    bb_breakout: {
      name: '布林 %b × BBW 真突破順勢策略（壓縮表態追多）',
      desc: '實戰 3 步驟：1. 近期 BBW 曾壓縮至 120 日低分位（Squeeze）；2. 等待 %b 衝破門檻同時 BBW 明顯拐頭擴張、上下軌張開表態進場；3. 若突破後 2～3 根內 %b 立刻跌回 0.8 以下且 BBW 走平則視為假突破停損，否則續抱至 %b 跌破出場線。',
    },
    ma_cross: {
      name: '雙均線交叉（黃金交叉買 / 死亡交叉賣）',
      desc: '短天期均線向上穿越長天期均線（黃金交叉）買進，向下穿越（死亡交叉）賣出；預設 T 日收盤確認訊號、T+1 日開盤執行（無未來函數）。',
    },
    ma_single: {
      name: '單均線防守（站上買進 / 跌破賣出）',
      desc: '收盤站上指定均線（如 5MA 週線、10MA 雙週線、20MA 月線或 60MA 季線）時進場，跌破該均線防守即出場保留現金。',
    },
    rsi_reversion: {
      name: 'RSI 逆勢區間（超賣買進 / 超買賣出）',
      desc: '當相對強弱指標 RSI(N) 落入超賣區（預設 ≤30）逢低買進，反彈至超買區（預設 ≥70）分批獲利出場。',
    },
    breakout_stop: {
      name: '右側突破＋移動停利／停損（吃筍紀律）',
      desc: '收盤突破近 N 日新高時右側進場，若觸及固定停損（如 -8%）或自波段高點回撤達移動停利門檻（如 -10%）即果斷出場。',
    },
    dca: {
      name: '定期定額（DCA）vs 單筆買進持有',
      desc: '於固定週期（每月／雙週／每週）投入固定金額買入，統計總投入本金、期末市值、現金報酬率與真實年化內部報酬率（XIRR）。',
    },
  };

  const btState = {
    target: '0050',
    customInput: '',
    range: '2y',
    startDate: '',
    endDate: '',
    strategy: 'bb_pctb',
    capital: 1000000,
    feePreset: 'tw_etf',
    feeBuyPct: 0.0855,
    feeSellPct: 0.1855,
    useAdj: true,
    execMode: 'next_open', // 'next_open' | 'close'
    activeScenario: '0050_bb',
    params: {
      bbPeriod: 20,
      bbStd: 2,
      bbEntry: 0,
      bbExitMode: 'hold_months', // 'hold_months' | 'hold_days' | 'bb_target'
      bbHoldMonths: 3,
      bbHoldDays: 60,
      bbExitTarget: 1.0,
      bbSignalMode: 'single_pos', // 'single_pos' | 'every_signal'
      bbLotAmount: 100000,
      bbSqueezePct: 35,
      bbEntryPctB: 0.85,
      bbHoldConfirm: true,
      bbExitPctB: 0.5,
      shortMa: 5,
      longMa: 20,
      singleMa: 20,
      confirmDays: 1,
      rsiPeriod: 14,
      rsiBuy: 30,
      rsiSell: 70,
      breakoutDays: 20,
      trailStopPct: 10,
      stopLossPct: 0,
      dcaAmount: 20000,
      dcaFreq: 'monthly',
    },
    dataObj: null,
    loading: false,
    error: null,
    result: null,
    charts: { eq: null, sig: null },
  };

  // ---------------- 技術指標計算 ----------------
  function sma(vals, n) {
    const out = new Array(vals.length).fill(null);
    if (n <= 0) return out;
    let sum = 0;
    for (let i = 0; i < vals.length; i++) {
      sum += vals[i];
      if (i >= n) sum -= vals[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  function bollinger(vals, n = 20, k = 2) {
    const mb = sma(vals, n);
    const ub = new Array(vals.length).fill(null);
    const lb = new Array(vals.length).fill(null);
    const pctB = new Array(vals.length).fill(null);
    const bbw = new Array(vals.length).fill(null);
    for (let i = n - 1; i < vals.length; i++) {
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
      pctB[i] = u > l ? (vals[i] - l) / (u - l) : 0.5;
      bbw[i] = m > 0 ? ((u - l) / m) * 100 : null;
    }
    return { mb, ub, lb, pctB, bbw };
  }

  function rsi(vals, n = 14) {
    const out = new Array(vals.length).fill(null);
    if (vals.length <= n || n < 2) return out;
    let g = 0;
    let l = 0;
    for (let i = 1; i <= n; i++) {
      const d = vals[i] - vals[i - 1];
      if (d >= 0) g += d;
      else l -= d;
    }
    g /= n;
    l /= n;
    out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    for (let i = n + 1; i < vals.length; i++) {
      const d = vals[i] - vals[i - 1];
      g = (g * (n - 1) + Math.max(d, 0)) / n;
      l = (l * (n - 1) + Math.max(-d, 0)) / n;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    return out;
  }

  function rollingPrevHigh(highs, n) {
    const out = new Array(highs.length).fill(null);
    if (n < 1) return out;
    for (let i = n; i < highs.length; i++) {
      let mx = -Infinity;
      for (let j = i - n; j < i; j++) {
        if (highs[j] > mx) mx = highs[j];
      }
      out[i] = mx;
    }
    return out;
  }

  function addCalendarMonths(dateStr, months) {
    const dt = new Date(dateStr + 'T00:00:00Z');
    const origDay = dt.getUTCDate();
    dt.setUTCDate(1);
    dt.setUTCMonth(dt.getUTCMonth() + months);
    const maxDay = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
    dt.setUTCDate(Math.min(origDay, maxDay));
    return dt.toISOString().slice(0, 10);
  }

  function calcXirr(cashflows) {
    if (!cashflows || cashflows.length < 2) return null;
    const t0 = new Date(cashflows[0].date).getTime();
    const flows = cashflows.map((f) => ({
      t: (new Date(f.date).getTime() - t0) / (365.25 * 86400000),
      cf: f.amount,
    }));
    const hasNeg = flows.some((f) => f.cf < 0);
    const hasPos = flows.some((f) => f.cf > 0);
    if (!hasNeg || !hasPos) return null;
    const npv = (r) => flows.reduce((acc, f) => acc + f.cf / Math.pow(1 + r, f.t), 0);

    let lo = -0.95;
    let hi = 5.0;
    const fLo = npv(lo);
    const fHi = npv(hi);
    if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) return null;
    let curLo = fLo;
    for (let it = 0; it < 70; it++) {
      const mid = (lo + hi) / 2;
      const fMid = npv(mid);
      if (Math.abs(fMid) < 1e-6) return mid * 100;
      if (curLo * fMid <= 0) {
        hi = mid;
      } else {
        lo = mid;
        curLo = fMid;
      }
    }
    return ((lo + hi) / 2) * 100;
  }

  function calcMaxDrawdown(eqSeries) {
    let peak = -Infinity;
    let maxDD = 0;
    let peakDate = '';
    let troughDate = '';
    let curPeakDate = '';
    for (const pt of eqSeries) {
      if (pt.value > peak) {
        peak = pt.value;
        curPeakDate = pt.time;
      }
      if (peak > 0) {
        const dd = ((pt.value - peak) / peak) * 100;
        if (dd < maxDD) {
          maxDD = dd;
          peakDate = curPeakDate;
          troughDate = pt.time;
        }
      }
    }
    return { maxDD, peakDate, troughDate };
  }

  function calcSharpe(eqSeries) {
    if (!eqSeries || eqSeries.length < 3) return null;
    const rets = [];
    for (let i = 1; i < eqSeries.length; i++) {
      if (eqSeries[i - 1].value > 0) {
        rets.push(eqSeries[i].value / eqSeries[i - 1].value - 1);
      }
    }
    if (rets.length < 2) return null;
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
    const sd = Math.sqrt(variance);
    if (sd === 0) return 0;
    const rfDaily = 0.015 / 252;
    return ((mean - rfDaily) / sd) * Math.sqrt(252);
  }

  // ---------------- 資料整理與費率猜測 ----------------
  function guessFeePreset(sym) {
    const s = String(sym || '').toUpperCase();
    if (/^(TWII|TPEX|DJI|GSPC|IXIC|SOX|\^)/.test(s)) return 'zero';
    if (/^00\d{2,4}[A-Z]?(\.TW|\.TWO)?$/.test(s)) return 'tw_etf';
    if (/^\d{4,6}[A-Z]?(\.TW|\.TWO)?$/.test(s)) return 'tw_stock';
    if (/^(2330|0050)$/.test(s)) return s === '0050' ? 'tw_etf' : 'tw_stock';
    return 'us';
  }

  function prepareBars(rawRows, useAdj) {
    return (rawRows || [])
      .filter((r) => r && r.date && isNum(r.c) && r.c > 0)
      .map((r) => {
        const ratio = useAdj && isNum(r.adj) && r.adj > 0 && r.c > 0 ? r.adj / r.c : 1;
        return {
          date: r.date,
          o: (isNum(r.o) && r.o > 0 ? r.o : r.c) * ratio,
          h: (isNum(r.h) && r.h > 0 ? r.h : r.c) * ratio,
          l: (isNum(r.l) && r.l > 0 ? r.l : r.c) * ratio,
          c: r.c * ratio,
        };
      });
  }

  function resolveWindowBounds(bars, startDate, endDate) {
    if (!bars.length) return { startIdx: 0, endIdx: -1 };
    let startIdx = 0;
    if (startDate) {
      const idx = bars.findIndex((b) => b.date >= startDate);
      startIdx = idx >= 0 ? idx : bars.length;
    }
    let endIdx = bars.length - 1;
    if (endDate) {
      for (let i = bars.length - 1; i >= 0; i--) {
        if (bars[i].date <= endDate) {
          endIdx = i;
          break;
        }
        if (i === 0) endIdx = -1;
      }
    }
    return { startIdx, endIdx };
  }

  function defaultDatesForRange(bars, range) {
    if (!bars.length) return { startDate: '', endDate: '' };
    const endDate = bars[bars.length - 1].date;
    const endDt = new Date(endDate + 'T00:00:00Z');
    const months = { '6m': 6, '1y': 12, '2y': 24, '3y': 36, '5y': 60 }[range] || 24;
    const startDt = new Date(endDt);
    startDt.setUTCMonth(startDt.getUTCMonth() - months);
    const minDate = bars[0].date;
    const targetStart = startDt.toISOString().slice(0, 10);
    return {
      startDate: targetStart > minDate ? targetStart : minDate,
      endDate,
    };
  }

  // ---------------- 回測模擬核心 ----------------
  function simulateBacktest(bars, cfg) {
    const {
      strategy,
      startDate,
      endDate,
      capital,
      feeBuyPct,
      feeSellPct,
      execMode,
      params,
    } = cfg;

    const { startIdx, endIdx } = resolveWindowBounds(bars, startDate, endDate);
    if (endIdx - startIdx < 5) {
      throw new Error('所選日期區間內交易日不足（至少需 5 個交易日）');
    }

    const closes = bars.map((b) => b.c);
    const highs = bars.map((b) => b.h);
    const buyRate = Math.max(0, Number(feeBuyPct) || 0) / 100;
    const sellRate = Math.max(0, Number(feeSellPct) || 0) / 100;
    const nextOpen = execMode !== 'close';

    // 計算指標（在完整序列上先計算，避免區間前段暖機損失）
    const overlays = [];
    const ind = {};
    if (strategy === 'bb_pctb' || strategy === 'bb_breakout') {
      const bPeriod = Math.max(5, Math.min(120, Math.round(params.bbPeriod || 20)));
      const bStd = Math.max(0.5, Math.min(4, Number(params.bbStd) || 2));
      const bb = bollinger(closes, bPeriod, bStd);
      ind.bb = bb;
      ind.bPeriod = bPeriod;
      ind.bStd = bStd;
      if (strategy === 'bb_breakout') {
        const rank = new Array(closes.length).fill(null);
        for (let i = 0; i < closes.length; i++) {
          const cur = bb.bbw[i];
          if (cur == null) continue;
          const win = bb.bbw.slice(Math.max(0, i - 119), i + 1).filter((v) => v != null);
          if (win.length) {
            rank[i] = (win.filter((v) => v <= cur).length / win.length) * 100;
          }
        }
        ind.bbwRank120 = rank;
      }
      overlays.push(
        { label: `布林上軌`, color: '#5ab0f0', arr: bb.ub },
        { label: `${bPeriod}MA中軌`, color: '#f2b544', arr: bb.mb },
        { label: `布林下軌`, color: '#22d3ee', arr: bb.lb }
      );
    } else if (strategy === 'ma_cross') {
      const sLen = Math.max(2, Math.min(240, Math.round(params.shortMa || 5)));
      const lLen = Math.max(sLen + 1, Math.min(360, Math.round(params.longMa || 20)));
      ind.shortMa = sma(closes, sLen);
      ind.longMa = sma(closes, lLen);
      ind.sLen = sLen;
      ind.lLen = lLen;
      overlays.push(
        { label: `短均 ${sLen}MA`, color: '#f1f5f9', arr: ind.shortMa },
        { label: `長均 ${lLen}MA`, color: '#f2b544', arr: ind.longMa }
      );
    } else if (strategy === 'ma_single') {
      const pLen = Math.max(2, Math.min(360, Math.round(params.singleMa || 20)));
      ind.ma = sma(closes, pLen);
      ind.pLen = pLen;
      overlays.push({ label: `${pLen}MA`, color: '#22d3ee', arr: ind.ma });
    } else if (strategy === 'rsi_reversion') {
      const rLen = Math.max(2, Math.min(60, Math.round(params.rsiPeriod || 14)));
      ind.rsi = rsi(closes, rLen);
      ind.rLen = rLen;
      overlays.push({ label: '20MA參考', color: '#f2b544', arr: sma(closes, 20) });
    } else if (strategy === 'breakout_stop') {
      const bLen = Math.max(3, Math.min(250, Math.round(params.breakoutDays || 20)));
      ind.prevHigh = rollingPrevHigh(highs, bLen);
      ind.bLen = bLen;
      overlays.push({ label: `${Math.min(bLen, 20)}MA`, color: '#f2b544', arr: sma(closes, Math.min(bLen, 20)) });
    } else if (strategy === 'dca') {
      overlays.push({ label: '20MA', color: '#f2b544', arr: sma(closes, 20) });
    }

    if (strategy === 'dca') {
      return simulateDca(bars, startIdx, endIdx, buyRate, sellRate, nextOpen, params, overlays);
    }

    if (strategy === 'bb_pctb' && params.bbSignalMode === 'every_signal') {
      return simulateBbEverySignal(bars, startIdx, endIdx, buyRate, sellRate, nextOpen, params, ind, overlays);
    }

    const initCap = Math.max(1000, Number(capital) || 1000000);
    const stopLossPct = Number(params.stopLossPct) || 0;
    const takeProfitPct = Number(params.takeProfitPct) || 0;
    const trailStopPct = strategy === 'breakout_stop' ? Math.max(1, Number(params.trailStopPct) || 10) : 0;

    // 基準：單筆買進持有
    const bhExecPrice = nextOpen ? bars[startIdx].o : bars[startIdx].c;
    const bhGross = initCap / (1 + buyRate);
    const bhShares = bhExecPrice > 0 ? bhGross / bhExecPrice : 0;
    const bhSeries = [];

    let cash = initCap;
    let shares = 0;
    let entry = null;
    let totalFees = 0;
    const trades = [];
    const markers = [];
    const equitySeries = [];
    let pendingOrder = null;

    const checkBbEntry = (pb, entryTh) => {
      if (pb == null) return false;
      return entryTh === 0 ? pb < 0 : pb <= entryTh;
    };

    const getBbExitMeta = (entryDate) => {
      const exitMode = params.bbExitMode || 'hold_months';
      if (exitMode === 'hold_months') {
        const m = Math.max(1, Math.min(36, Math.round(params.bbHoldMonths || 3)));
        return { exitMode, targetDate: addCalendarMonths(entryDate, m), holdMonths: m };
      }
      if (exitMode === 'hold_days') {
        const d = Math.max(1, Math.min(500, Math.round(params.bbHoldDays || 60)));
        return { exitMode, holdDaysLimit: d };
      }
      return { exitMode: 'bb_target', exitTh: Number(params.bbExitTarget ?? 1.0) };
    };

    for (let i = startIdx; i <= endIdx; i++) {
      const bar = bars[i];

      // 1) 執行昨日掛單 (T+1 開盤成交)
      if (nextOpen && pendingOrder) {
        const px = bar.o;
        if (pendingOrder.action === 'BUY' && shares === 0 && px > 0 && cash > 0) {
          const gross = cash / (1 + buyRate);
          const fee = cash - gross;
          shares = gross / px;
          totalFees += fee;
          entry = {
            date: bar.date,
            idx: i,
            price: px,
            shares,
            totalOut: cash,
            buyFee: fee,
            peakClose: bar.c,
            buyReason: pendingOrder.reason,
            bbExit: strategy === 'bb_pctb' ? getBbExitMeta(bar.date) : null,
          };
          cash = 0;
          markers.push({ time: bar.date, kind: 'buy', text: '買', reason: pendingOrder.reason, price: px });
        } else if (pendingOrder.action === 'SELL' && shares > 0 && px > 0) {
          const gross = shares * px;
          const fee = gross * sellRate;
          const net = gross - fee;
          totalFees += fee;
          const pnl = net - entry.totalOut;
          const retPct = (pnl / entry.totalOut) * 100;
          trades.push({
            no: trades.length + 1,
            buyDate: entry.date,
            buyPrice: entry.price,
            shares: entry.shares,
            sellDate: bar.date,
            sellPrice: px,
            holdDays: Math.max(1, i - entry.idx),
            fees: entry.buyFee + fee,
            pnl,
            retPct,
            buyReason: entry.buyReason,
            sellReason: pendingOrder.reason,
            open: false,
          });
          markers.push({ time: bar.date, kind: 'sell', text: '賣', reason: pendingOrder.reason, price: px });
          cash = net;
          shares = 0;
          entry = null;
        }
        pendingOrder = null;
      }

      if (entry && bar.c > entry.peakClose) {
        entry.peakClose = bar.c;
      }

      // 2) BB 持有到期檢查（若採 T+1 掛單：於滿期當日開盤或收盤，日曆月到期直接於 bar.date >= targetDate 當根賣出更貼合「三個月後賣掉」）
      let immediateSell = null;
      if (strategy === 'bb_pctb' && shares > 0 && entry?.bbExit) {
        const ex = entry.bbExit;
        if (ex.exitMode === 'hold_months' && bar.date >= ex.targetDate) {
          immediateSell = { reason: `持有滿 ${ex.holdMonths} 個月 (${ex.targetDate})` };
        } else if (ex.exitMode === 'hold_days' && (i - entry.idx) >= ex.holdDaysLimit) {
          immediateSell = { reason: `持有滿 ${ex.holdDaysLimit} 交易日` };
        }
      }

      if (immediateSell && shares > 0) {
        const px = nextOpen ? bar.o : bar.c;
        if (px > 0) {
          const gross = shares * px;
          const fee = gross * sellRate;
          const net = gross - fee;
          totalFees += fee;
          const pnl = net - entry.totalOut;
          const retPct = (pnl / entry.totalOut) * 100;
          trades.push({
            no: trades.length + 1,
            buyDate: entry.date,
            buyPrice: entry.price,
            shares: entry.shares,
            sellDate: bar.date,
            sellPrice: px,
            holdDays: Math.max(1, i - entry.idx),
            fees: entry.buyFee + fee,
            pnl,
            retPct,
            buyReason: entry.buyReason,
            sellReason: immediateSell.reason,
            open: false,
          });
          markers.push({ time: bar.date, kind: 'sell', text: '賣', reason: immediateSell.reason, price: px });
          cash = net;
          shares = 0;
          entry = null;
        }
      }

      // 3) 判斷當日收盤訊號
      let signal = null;
      if (shares === 0) {
        if (strategy === 'bb_pctb') {
          const pb = ind.bb.pctB[i];
          const entryTh = Number(params.bbEntry ?? 0);
          if (checkBbEntry(pb, entryTh)) {
            signal = { action: 'BUY', reason: `BB %b=${pb.toFixed(2)} ${entryTh === 0 ? '< 0 (跌破下軌)' : `≤ ${entryTh}`}` };
          }
        } else if (strategy === 'bb_breakout') {
          if (i >= 2) {
            const pb = ind.bb.pctB[i];
            const bbw0 = ind.bb.bbw[i], bbw1 = ind.bb.bbw[i - 1], bbw2 = ind.bb.bbw[i - 2];
            const u0 = ind.bb.ub[i], u1 = ind.bb.ub[i - 1], l0 = ind.bb.lb[i], l1 = ind.bb.lb[i - 1];
            const squeezeTh = Math.max(5, Math.min(95, Number(params.bbSqueezePct ?? 35)));
            const entryPb = Number(params.bbEntryPctB ?? 0.85);
            let hadSqueeze = false;
            for (let j = Math.max(0, i - 15); j <= i; j++) {
              if (ind.bbwRank120[j] != null && ind.bbwRank120[j] <= squeezeTh) {
                hadSqueeze = true;
                break;
              }
            }
            const flare = u0 != null && u1 != null && l0 != null && l1 != null && u0 > u1 && l0 < l1;
            const bbwTurning = bbw0 != null && bbw1 != null && bbw0 > bbw1 && (bbw2 == null || bbw0 > bbw2);
            if (hadSqueeze && pb != null && pb >= entryPb && bbwTurning && (flare || bbw0 >= bbw1 * 1.02)) {
              signal = { action: 'BUY', reason: `Squeeze後 %b=${pb.toFixed(2)}×BBW擴張真突破` };
            }
          }
        } else if (strategy === 'ma_cross') {
          if (i >= 1) {
            const f0 = ind.shortMa[i], s0 = ind.longMa[i];
            const f1 = ind.shortMa[i - 1], s1 = ind.longMa[i - 1];
            if (f0 != null && s0 != null && f1 != null && s1 != null && f0 > s0 && f1 <= s1) {
              signal = { action: 'BUY', reason: `${ind.sLen}MA 上穿 ${ind.lLen}MA 黃金交叉` };
            }
          }
        } else if (strategy === 'ma_single') {
          const cDays = Math.max(1, Math.min(5, Math.round(params.confirmDays || 1)));
          if (i >= cDays) {
            let allAbove = true;
            for (let k = 0; k < cDays; k++) {
              const m = ind.ma[i - k];
              if (m == null || closes[i - k] <= m) { allAbove = false; break; }
            }
            const prevM = ind.ma[i - cDays];
            if (allAbove && prevM != null && closes[i - cDays] <= prevM) {
              signal = { action: 'BUY', reason: `站上 ${ind.pLen}MA` };
            }
          }
        } else if (strategy === 'rsi_reversion') {
          const r0 = ind.rsi[i];
          const buyTh = Number(params.rsiBuy) || 30;
          if (r0 != null && r0 <= buyTh) {
            signal = { action: 'BUY', reason: `RSI(${ind.rLen})=${r0.toFixed(1)} ≤ ${buyTh} 超賣` };
          }
        } else if (strategy === 'breakout_stop') {
          const ph = ind.prevHigh[i];
          if (ph != null && bar.c > ph) {
            signal = { action: 'BUY', reason: `突破近 ${ind.bLen} 日高點` };
          }
        }
      } else if (shares > 0 && entry) {
        if (stopLossPct > 0 && bar.c <= entry.price * (1 - stopLossPct / 100)) {
          signal = { action: 'SELL', reason: `觸及停損 (-${stopLossPct}%)` };
        } else if (takeProfitPct > 0 && bar.c >= entry.price * (1 + takeProfitPct / 100)) {
          signal = { action: 'SELL', reason: `觸及停利 (+${takeProfitPct}%)` };
        } else if (trailStopPct > 0 && bar.c <= entry.peakClose * (1 - trailStopPct / 100)) {
          signal = { action: 'SELL', reason: `高點回落移動停利 (-${trailStopPct}%)` };
        } else if (strategy === 'bb_pctb' && (params.bbExitMode || 'hold_months') === 'bb_target') {
          const pb = ind.bb.pctB[i];
          const exitTh = Number(params.bbExitTarget ?? 1.0);
          if (pb != null && pb >= exitTh) {
            signal = { action: 'SELL', reason: `BB %b=${pb.toFixed(2)} ≥ ${exitTh}` };
          }
        } else if (strategy === 'bb_breakout') {
          const pb = ind.bb.pctB[i];
          const bbw0 = ind.bb.bbw[i], bbw1 = ind.bb.bbw[i - 1];
          const holdConfirm = params.bbHoldConfirm !== false && params.bbHoldConfirm !== 'false';
          const exitPb = Number(params.bbExitPctB ?? 0.5);
          const barsHeld = i - entry.idx;
          if (holdConfirm && barsHeld >= (nextOpen ? 0 : 1) && barsHeld <= 3 && pb != null && pb < 0.8 && (bbw0 == null || bbw1 == null || bbw0 <= bbw1)) {
            signal = { action: 'SELL', reason: `假突破停損（突破後 %b=${pb.toFixed(2)} < 0.8 且 BBW 走平）` };
          } else if (pb != null && pb < exitPb) {
            signal = { action: 'SELL', reason: `BB %b=${pb.toFixed(2)} < ${exitPb}（跌破趨勢出場）` };
          }
        } else if (strategy === 'ma_cross') {
          if (i >= 1) {
            const f0 = ind.shortMa[i], s0 = ind.longMa[i];
            const f1 = ind.shortMa[i - 1], s1 = ind.longMa[i - 1];
            if (f0 != null && s0 != null && f1 != null && s1 != null && f0 < s0 && f1 >= s1) {
              signal = { action: 'SELL', reason: `${ind.sLen}MA 下穿 ${ind.lLen}MA 死亡交叉` };
            }
          }
        } else if (strategy === 'ma_single') {
          const cDays = Math.max(1, Math.min(5, Math.round(params.confirmDays || 1)));
          if (i >= cDays - 1) {
            let allBelow = true;
            for (let k = 0; k < cDays; k++) {
              const m = ind.ma[i - k];
              if (m == null || closes[i - k] >= m) { allBelow = false; break; }
            }
            if (allBelow) {
              signal = { action: 'SELL', reason: `跌破 ${ind.pLen}MA` };
            }
          }
        } else if (strategy === 'rsi_reversion') {
          const r0 = ind.rsi[i];
          const sellTh = Number(params.rsiSell) || 70;
          if (r0 != null && r0 >= sellTh) {
            signal = { action: 'SELL', reason: `RSI(${ind.rLen})=${r0.toFixed(1)} ≥ ${sellTh} 超買` };
          }
        }
      }

      if (signal) {
        if (nextOpen) {
          if (i < endIdx) pendingOrder = signal;
        } else {
          const px = bar.c;
          if (signal.action === 'BUY' && shares === 0 && cash > 0) {
            const gross = cash / (1 + buyRate);
            const fee = cash - gross;
            shares = gross / px;
            totalFees += fee;
            entry = {
              date: bar.date,
              idx: i,
              price: px,
              shares,
              totalOut: cash,
              buyFee: fee,
              peakClose: bar.c,
              buyReason: signal.reason,
              bbExit: strategy === 'bb_pctb' ? getBbExitMeta(bar.date) : null,
            };
            cash = 0;
            markers.push({ time: bar.date, kind: 'buy', text: '買', reason: signal.reason, price: px });
          } else if (signal.action === 'SELL' && shares > 0) {
            const gross = shares * px;
            const fee = gross * sellRate;
            const net = gross - fee;
            totalFees += fee;
            const pnl = net - entry.totalOut;
            const retPct = (pnl / entry.totalOut) * 100;
            trades.push({
              no: trades.length + 1,
              buyDate: entry.date,
              buyPrice: entry.price,
              shares: entry.shares,
              sellDate: bar.date,
              sellPrice: px,
              holdDays: Math.max(1, i - entry.idx),
              fees: entry.buyFee + fee,
              pnl,
              retPct,
              buyReason: entry.buyReason,
              sellReason: signal.reason,
              open: false,
            });
            markers.push({ time: bar.date, kind: 'sell', text: '賣', reason: signal.reason, price: px });
            cash = net;
            shares = 0;
            entry = null;
          }
        }
      }

      const equity = cash + shares * bar.c;
      equitySeries.push({ time: bar.date, value: equity });
      bhSeries.push({ time: bar.date, value: bhShares * bar.c });
    }

    if (entry && shares > 0) {
      const lastBar = bars[endIdx];
      const estNet = shares * lastBar.c * (1 - sellRate);
      const pnl = estNet - entry.totalOut;
      trades.push({
        no: trades.length + 1,
        buyDate: entry.date,
        buyPrice: entry.price,
        shares: entry.shares,
        sellDate: `${lastBar.date}（持倉中）`,
        sellPrice: lastBar.c,
        holdDays: Math.max(1, endIdx - entry.idx),
        fees: entry.buyFee,
        pnl,
        retPct: (pnl / entry.totalOut) * 100,
        buyReason: entry.buyReason,
        sellReason: entry.bbExit?.targetDate ? `未滿期（預計 ${entry.bbExit.targetDate} 出場）` : '期末尚未平倉（依收盤價估算）',
        open: true,
      });
    }

    const finalEquity = equitySeries[equitySeries.length - 1].value;
    const bhFinal = bhSeries[bhSeries.length - 1].value;
    const stratRetPct = ((finalEquity - initCap) / initCap) * 100;
    const bhRetPct = ((bhFinal - initCap) / initCap) * 100;

    const calDays = Math.max(1, (new Date(bars[endIdx].date) - new Date(bars[startIdx].date)) / 86400000);
    const years = calDays / 365.25;
    const stratCagr = years >= 0.1 && finalEquity > 0 ? (Math.pow(finalEquity / initCap, 1 / years) - 1) * 100 : null;
    const bhCagr = years >= 0.1 && bhFinal > 0 ? (Math.pow(bhFinal / initCap, 1 / years) - 1) * 100 : null;

    const { maxDD, peakDate, troughDate } = calcMaxDrawdown(equitySeries);
    const { maxDD: bhMaxDD } = calcMaxDrawdown(bhSeries);
    const sharpe = calcSharpe(equitySeries);

    const closed = trades.filter((t) => !t.open);
    const wins = closed.filter((t) => t.pnl > 0);
    const losses = closed.filter((t) => t.pnl <= 0);
    const winRate = closed.length ? (wins.length / closed.length) * 100 : null;
    const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
    const profitFactor = closed.length === 0 ? null : grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
    const avgHoldDays = closed.length ? closed.reduce((a, t) => a + t.holdDays, 0) / closed.length : null;
    const avgTradeRetPct = closed.length ? closed.reduce((a, t) => a + t.retPct, 0) / closed.length : null;

    const candles = [];
    for (let i = startIdx; i <= endIdx; i++) {
      candles.push({ time: bars[i].date, open: bars[i].o, high: bars[i].h, low: bars[i].l, close: bars[i].c });
    }
    const overlayLines = overlays.map((ov) => ({
      label: ov.label,
      color: ov.color,
      data: ov.arr
        .slice(startIdx, endIdx + 1)
        .map((v, idx) => (v != null ? { time: bars[startIdx + idx].date, value: v } : null))
        .filter(Boolean),
    }));

    return {
      isDca: false,
      isEverySignal: false,
      startDate: bars[startIdx].date,
      endDate: bars[endIdx].date,
      tradingDays: endIdx - startIdx + 1,
      initCap,
      finalEquity,
      netProfit: finalEquity - initCap,
      stratRetPct,
      bhFinal,
      bhRetPct,
      alphaPct: stratRetPct - bhRetPct,
      stratCagr,
      bhCagr,
      maxDD,
      peakDate,
      troughDate,
      bhMaxDD,
      sharpe,
      totalTrades: trades.length,
      closedCount: closed.length,
      winCount: wins.length,
      winRate,
      profitFactor,
      avgHoldDays,
      avgTradeRetPct,
      totalFees,
      equitySeries,
      bhSeries,
      candles,
      overlayLines,
      markers,
      trades,
    };
  }

  // BB %b「每次訊號獨立買一筆、各自滿期賣出」試算
  function simulateBbEverySignal(bars, startIdx, endIdx, buyRate, sellRate, nextOpen, params, ind, overlays) {
    const lotAmount = Math.max(1000, Number(params.bbLotAmount) || 100000);
    const entryTh = Number(params.bbEntry ?? 0);
    const exitMode = params.bbExitMode || 'hold_months';
    const holdMonths = Math.max(1, Math.min(36, Math.round(params.bbHoldMonths || 3)));
    const holdDaysLimit = Math.max(1, Math.min(500, Math.round(params.bbHoldDays || 60)));
    const exitTh = Number(params.bbExitTarget ?? 1.0);
    const stopLossPct = Number(params.stopLossPct) || 0;

    const activeLots = [];
    const trades = [];
    const markers = [];
    const cumPnlSeries = [];
    let pendingOrder = null;
    let realizedPnl = 0;
    let maxConcurrent = 0;
    let totalFees = 0;

    const checkEntry = (pb) => pb != null && (entryTh === 0 ? pb < 0 : pb <= entryTh);

    for (let i = startIdx; i <= endIdx; i++) {
      const bar = bars[i];

      // 執行昨日進場掛單 (T+1 開盤)
      if (nextOpen && pendingOrder) {
        const px = bar.o;
        if (px > 0) {
          const gross = lotAmount / (1 + buyRate);
          const fee = lotAmount - gross;
          const shares = gross / px;
          totalFees += fee;
          activeLots.push({
            no: trades.length + activeLots.length + 1,
            buyDate: bar.date,
            buyIdx: i,
            buyPrice: px,
            shares,
            totalOut: lotAmount,
            buyFee: fee,
            targetDate: exitMode === 'hold_months' ? addCalendarMonths(bar.date, holdMonths) : null,
            buyReason: pendingOrder.reason,
          });
          markers.push({ time: bar.date, kind: 'buy', text: '買', reason: pendingOrder.reason, price: px });
        }
        pendingOrder = null;
      }

      // 檢查各筆獨立部位是否到期 / 觸發出場
      for (let idx = activeLots.length - 1; idx >= 0; idx--) {
        const lot = activeLots[idx];
        let exitReason = null;
        if (stopLossPct > 0 && bar.c <= lot.buyPrice * (1 - stopLossPct / 100)) {
          exitReason = `觸及停損 (-${stopLossPct}%)`;
        } else if (exitMode === 'hold_months' && bar.date >= lot.targetDate) {
          exitReason = `滿 ${holdMonths} 個月 (${lot.targetDate})`;
        } else if (exitMode === 'hold_days' && (i - lot.buyIdx) >= holdDaysLimit) {
          exitReason = `滿 ${holdDaysLimit} 交易日`;
        } else if (exitMode === 'bb_target' && ind.bb.pctB[i] != null && ind.bb.pctB[i] >= exitTh && i > lot.buyIdx) {
          exitReason = `BB %b=${ind.bb.pctB[i].toFixed(2)} ≥ ${exitTh}`;
        }

        if (exitReason) {
          const sellPx = nextOpen ? bar.o : bar.c;
          if (sellPx > 0) {
            const gross = lot.shares * sellPx;
            const fee = gross * sellRate;
            const net = gross - fee;
            totalFees += fee;
            const pnl = net - lot.totalOut;
            realizedPnl += pnl;
            trades.push({
              no: lot.no,
              buyDate: lot.buyDate,
              buyPrice: lot.buyPrice,
              shares: lot.shares,
              sellDate: bar.date,
              sellPrice: sellPx,
              holdDays: Math.max(1, i - lot.buyIdx),
              fees: lot.buyFee + fee,
              pnl,
              retPct: (pnl / lot.totalOut) * 100,
              buyReason: lot.buyReason,
              sellReason: exitReason,
              open: false,
            });
            markers.push({ time: bar.date, kind: 'sell', text: '賣', reason: exitReason, price: sellPx });
            activeLots.splice(idx, 1);
          }
        }
      }

      // 檢查今日收盤新進場訊號
      const pb = ind.bb.pctB[i];
      if (checkEntry(pb)) {
        const reason = `BB %b=${pb.toFixed(2)} ${entryTh === 0 ? '< 0' : `≤ ${entryTh}`}`;
        if (nextOpen) {
          if (i < endIdx) pendingOrder = { reason };
        } else {
          const px = bar.c;
          if (px > 0) {
            const gross = lotAmount / (1 + buyRate);
            const fee = lotAmount - gross;
            const shares = gross / px;
            totalFees += fee;
            activeLots.push({
              no: trades.length + activeLots.length + 1,
              buyDate: bar.date,
              buyIdx: i,
              buyPrice: px,
              shares,
              totalOut: lotAmount,
              buyFee: fee,
              targetDate: exitMode === 'hold_months' ? addCalendarMonths(bar.date, holdMonths) : null,
              buyReason: reason,
            });
            markers.push({ time: bar.date, kind: 'buy', text: '買', reason, price: px });
          }
        }
      }

      if (activeLots.length > maxConcurrent) maxConcurrent = activeLots.length;
      const openVal = activeLots.reduce((acc, l) => acc + l.shares * bar.c, 0);
      const openCost = activeLots.reduce((acc, l) => acc + l.totalOut, 0);
      const cumPnl = realizedPnl + (openVal - openCost);
      cumPnlSeries.push({ time: bar.date, pnl: cumPnl });
    }

    const lastBar = bars[endIdx];
    for (const lot of activeLots) {
      const estNet = lot.shares * lastBar.c * (1 - sellRate);
      const pnl = estNet - lot.totalOut;
      trades.push({
        no: lot.no,
        buyDate: lot.buyDate,
        buyPrice: lot.buyPrice,
        shares: lot.shares,
        sellDate: `${lastBar.date}（持倉中）`,
        sellPrice: lastBar.c,
        holdDays: Math.max(1, endIdx - lot.buyIdx),
        fees: lot.buyFee,
        pnl,
        retPct: (pnl / lot.totalOut) * 100,
        buyReason: lot.buyReason,
        sellReason: lot.targetDate ? `未滿期（預計 ${lot.targetDate} 出場）` : '期末尚未平倉',
        open: true,
      });
    }
    trades.sort((a, b) => a.no - b.no);

    const closed = trades.filter((t) => !t.open);
    const wins = closed.filter((t) => t.pnl > 0);
    const losses = closed.filter((t) => t.pnl <= 0);
    const winRate = closed.length ? (wins.length / closed.length) * 100 : null;
    const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
    const profitFactor = closed.length === 0 ? null : grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
    const avgHoldDays = closed.length ? closed.reduce((a, t) => a + t.holdDays, 0) / closed.length : null;
    const avgTradeRetPct = closed.length ? closed.reduce((a, t) => a + t.retPct, 0) / closed.length : null;
    const totalClosedPnl = closed.reduce((a, t) => a + t.pnl, 0);
    const totalAllPnl = trades.reduce((a, t) => a + t.pnl, 0);
    const peakCapital = Math.max(lotAmount, maxConcurrent * lotAmount);

    // 基準：以同一最高資金池做期初買進持有
    const bhExecPrice = nextOpen ? bars[startIdx].o : bars[startIdx].c;
    const bhShares = bhExecPrice > 0 ? (peakCapital / (1 + buyRate)) / bhExecPrice : 0;
    const bhSeries = [];
    for (let i = startIdx; i <= endIdx; i++) {
      bhSeries.push({ time: bars[i].date, value: bhShares * bars[i].c });
    }
    const bhFinal = bhSeries[bhSeries.length - 1]?.value ?? peakCapital;
    const bhRetPct = ((bhFinal - peakCapital) / peakCapital) * 100;

    // 權益曲線以確定之最高動用資金池為起點加上真實累計損益，避免同時段持倉增加造成曲線假跳升
    const adjEquitySeries = cumPnlSeries.map((pt) => ({
      time: pt.time,
      value: peakCapital + pt.pnl,
    }));
    const finalEquity = peakCapital + totalAllPnl;
    const stratRetPct = peakCapital > 0 ? (totalAllPnl / peakCapital) * 100 : 0;

    const { maxDD, peakDate, troughDate } = calcMaxDrawdown(adjEquitySeries);
    const { maxDD: bhMaxDD } = calcMaxDrawdown(bhSeries);
    const sharpe = calcSharpe(adjEquitySeries);

    const calDays = Math.max(1, (new Date(lastBar.date) - new Date(bars[startIdx].date)) / 86400000);
    const years = calDays / 365.25;
    const bhCagr = years >= 0.1 && bhFinal > 0 ? (Math.pow(bhFinal / peakCapital, 1 / years) - 1) * 100 : null;

    const candles = [];
    for (let i = startIdx; i <= endIdx; i++) {
      candles.push({ time: bars[i].date, open: bars[i].o, high: bars[i].h, low: bars[i].l, close: bars[i].c });
    }
    const overlayLines = overlays.map((ov) => ({
      label: ov.label,
      color: ov.color,
      data: ov.arr
        .slice(startIdx, endIdx + 1)
        .map((v, idx) => (v != null ? { time: bars[startIdx + idx].date, value: v } : null))
        .filter(Boolean),
    }));

    return {
      isDca: false,
      isEverySignal: true,
      lotAmount,
      maxConcurrent,
      peakCapital,
      totalClosedPnl,
      startDate: bars[startIdx].date,
      endDate: lastBar.date,
      tradingDays: endIdx - startIdx + 1,
      initCap: peakCapital,
      finalEquity,
      netProfit: totalAllPnl,
      stratRetPct,
      bhFinal,
      bhRetPct,
      alphaPct: stratRetPct - bhRetPct,
      stratCagr: avgTradeRetPct, // 單筆平均報酬
      bhCagr,
      maxDD,
      peakDate,
      troughDate,
      bhMaxDD,
      sharpe,
      totalTrades: trades.length,
      closedCount: closed.length,
      winCount: wins.length,
      winRate,
      profitFactor,
      avgHoldDays,
      avgTradeRetPct,
      totalFees,
      equitySeries: adjEquitySeries,
      bhSeries,
      candles,
      overlayLines,
      markers,
      trades,
    };
  }

  function simulateDca(bars, startIdx, endIdx, buyRate, sellRate, nextOpen, params, overlays) {
    const amount = Math.max(1000, Number(params.dcaAmount) || 20000);
    const freq = params.dcaFreq || 'monthly';
    let shares = 0;
    let totalInvested = 0;
    let totalFees = 0;
    const cashflows = [];
    const trades = [];
    const markers = [];
    const equitySeries = [];
    const investedSeries = [];

    let lastMonth = '';
    for (let i = startIdx; i <= endIdx; i++) {
      const bar = bars[i];
      const offset = i - startIdx;
      let shouldBuy = false;
      const ym = bar.date.slice(0, 7);
      if (freq === 'weekly') {
        shouldBuy = offset % 5 === 0;
      } else if (freq === 'biweekly') {
        shouldBuy = offset % 10 === 0;
      } else if (ym !== lastMonth) {
        shouldBuy = true;
        lastMonth = ym;
      }

      if (shouldBuy) {
        const px = nextOpen ? bar.o : bar.c;
        if (px > 0) {
          const gross = amount / (1 + buyRate);
          const fee = amount - gross;
          const qty = gross / px;
          shares += qty;
          totalInvested += amount;
          totalFees += fee;
          cashflows.push({ date: bar.date, amount: -amount });
          markers.push({ time: bar.date, kind: 'buy', text: '扣', reason: '定期定額扣款', price: px });
          trades.push({
            no: trades.length + 1,
            buyDate: bar.date,
            buyPrice: px,
            shares: qty,
            sellDate: `${bars[endIdx].date}（累計持有）`,
            sellPrice: bars[endIdx].c,
            holdDays: Math.max(1, endIdx - i),
            fees: fee,
            pnl: qty * bars[endIdx].c * (1 - sellRate) - amount,
            retPct: ((qty * bars[endIdx].c * (1 - sellRate) - amount) / amount) * 100,
            buyReason: `定期定額 (${freq === 'weekly' ? '每週' : freq === 'biweekly' ? '雙週' : '每月'})`,
            sellReason: '期末市值評價',
            open: true,
          });
        }
      }
      equitySeries.push({ time: bar.date, value: shares * bar.c });
      investedSeries.push({ time: bar.date, value: totalInvested });
    }

    const lastBar = bars[endIdx];
    const finalValue = shares * lastBar.c;
    const netProfit = finalValue - totalInvested;
    const stratRetPct = totalInvested > 0 ? (netProfit / totalInvested) * 100 : 0;

    const bhExecPrice = nextOpen ? bars[startIdx].o : bars[startIdx].c;
    const bhShares = bhExecPrice > 0 ? (totalInvested / (1 + buyRate)) / bhExecPrice : 0;
    const bhSeries = [];
    for (let i = startIdx; i <= endIdx; i++) {
      bhSeries.push({ time: bars[i].date, value: bhShares * bars[i].c });
    }
    const bhFinal = bhSeries[bhSeries.length - 1]?.value ?? totalInvested;
    const bhRetPct = totalInvested > 0 ? ((bhFinal - totalInvested) / totalInvested) * 100 : 0;

    cashflows.push({ date: lastBar.date, amount: finalValue });
    const xirr = calcXirr(cashflows);

    const calDays = Math.max(1, (new Date(lastBar.date) - new Date(bars[startIdx].date)) / 86400000);
    const years = calDays / 365.25;
    const bhCagr = years >= 0.1 && totalInvested > 0 && bhFinal > 0 ? (Math.pow(bhFinal / totalInvested, 1 / years) - 1) * 100 : null;

    const { maxDD, peakDate, troughDate } = calcMaxDrawdown(equitySeries);
    const { maxDD: bhMaxDD } = calcMaxDrawdown(bhSeries);
    const avgCost = shares > 0 ? totalInvested / shares : null;

    const candles = [];
    for (let i = startIdx; i <= endIdx; i++) {
      candles.push({ time: bars[i].date, open: bars[i].o, high: bars[i].h, low: bars[i].l, close: bars[i].c });
    }
    const overlayLines = overlays.map((ov) => ({
      label: ov.label,
      color: ov.color,
      data: ov.arr
        .slice(startIdx, endIdx + 1)
        .map((v, idx) => (v != null ? { time: bars[startIdx + idx].date, value: v } : null))
        .filter(Boolean),
    }));

    return {
      isDca: true,
      isEverySignal: false,
      startDate: bars[startIdx].date,
      endDate: lastBar.date,
      tradingDays: endIdx - startIdx + 1,
      initCap: totalInvested,
      totalInvested,
      avgCost,
      lastPrice: lastBar.c,
      finalEquity: finalValue,
      netProfit,
      stratRetPct,
      bhFinal,
      bhRetPct,
      alphaPct: stratRetPct - bhRetPct,
      stratCagr: xirr,
      bhCagr,
      maxDD,
      peakDate,
      troughDate,
      bhMaxDD,
      sharpe: calcSharpe(bhSeries),
      totalTrades: trades.length,
      closedCount: trades.length,
      winCount: trades.filter((t) => t.pnl > 0).length,
      winRate: trades.length ? (trades.filter((t) => t.pnl > 0).length / trades.length) * 100 : null,
      profitFactor: null,
      avgHoldDays: null,
      avgTradeRetPct: null,
      totalFees,
      equitySeries,
      investedSeries,
      bhSeries,
      candles,
      overlayLines,
      markers,
      trades,
    };
  }

  function runSweep(bars, baseCfg) {
    const s = baseCfg.strategy;
    let presets = [];
    if (s === 'bb_pctb') {
      presets = [
        { label: '%b < 0 買・1個月後賣', patch: { bbEntry: 0, bbExitMode: 'hold_months', bbHoldMonths: 1 } },
        { label: '%b < 0 買・2個月後賣', patch: { bbEntry: 0, bbExitMode: 'hold_months', bbHoldMonths: 2 } },
        { label: '%b < 0 買・3個月後賣', patch: { bbEntry: 0, bbExitMode: 'hold_months', bbHoldMonths: 3 } },
        { label: '%b < 0 買・6個月後賣', patch: { bbEntry: 0, bbExitMode: 'hold_months', bbHoldMonths: 6 } },
        { label: '%b < 0 買・觸上軌(%b≥1)賣', patch: { bbEntry: 0, bbExitMode: 'bb_target', bbExitTarget: 1.0 } },
      ];
    } else if (s === 'bb_breakout') {
      presets = [
        { label: '嚴格真突破 (%b≥1.0・30%壓縮)', patch: { bbSqueezePct: 30, bbEntryPctB: 1.0, bbHoldConfirm: true, bbExitPctB: 0.5 } },
        { label: '標準順勢 (%b≥0.85・35%壓縮)', patch: { bbSqueezePct: 35, bbEntryPctB: 0.85, bbHoldConfirm: true, bbExitPctB: 0.5 } },
        { label: '寬鬆突破 (%b≥0.8・50%壓縮)', patch: { bbSqueezePct: 50, bbEntryPctB: 0.8, bbHoldConfirm: true, bbExitPctB: 0.5 } },
        { label: '波段持有至跌破中軌 (無假突破停損)', patch: { bbSqueezePct: 35, bbEntryPctB: 0.85, bbHoldConfirm: false, bbExitPctB: 0.5 } },
      ];
    } else if (s === 'ma_cross') {
      presets = [
        { label: '5MA × 10MA（極短）', patch: { shortMa: 5, longMa: 10 } },
        { label: '5MA × 20MA（週月）', patch: { shortMa: 5, longMa: 20 } },
        { label: '10MA × 20MA（波段）', patch: { shortMa: 10, longMa: 20 } },
        { label: '10MA × 60MA（波季）', patch: { shortMa: 10, longMa: 60 } },
        { label: '20MA × 60MA（月季）', patch: { shortMa: 20, longMa: 60 } },
      ];
    } else if (s === 'ma_single') {
      presets = [
        { label: '5MA（週線）', patch: { singleMa: 5 } },
        { label: '10MA（雙週線）', patch: { singleMa: 10 } },
        { label: '20MA（月線）', patch: { singleMa: 20 } },
        { label: '60MA（季線）', patch: { singleMa: 60 } },
        { label: '120MA（半年線）', patch: { singleMa: 120 } },
      ];
    } else if (s === 'rsi_reversion') {
      presets = [
        { label: 'RSI(14) 30 / 70', patch: { rsiPeriod: 14, rsiBuy: 30, rsiSell: 70 } },
        { label: 'RSI(14) 25 / 75', patch: { rsiPeriod: 14, rsiBuy: 25, rsiSell: 75 } },
        { label: 'RSI(14) 35 / 65', patch: { rsiPeriod: 14, rsiBuy: 35, rsiSell: 65 } },
        { label: 'RSI(9) 30 / 70', patch: { rsiPeriod: 9, rsiBuy: 30, rsiSell: 70 } },
      ];
    } else if (s === 'breakout_stop') {
      presets = [
        { label: '10日突破 (-8%停損/-10%停利)', patch: { breakoutDays: 10, stopLossPct: 8, trailStopPct: 10 } },
        { label: '20日突破 (-8%停損/-10%停利)', patch: { breakoutDays: 20, stopLossPct: 8, trailStopPct: 10 } },
        { label: '20日突破 (-10%停損/-15%停利)', patch: { breakoutDays: 20, stopLossPct: 10, trailStopPct: 15 } },
        { label: '60日突破 (-10%停損/-15%停利)', patch: { breakoutDays: 60, stopLossPct: 10, trailStopPct: 15 } },
      ];
    } else if (s === 'dca') {
      presets = [
        { label: '每月定期定額', patch: { dcaFreq: 'monthly' } },
        { label: '雙週定期定額', patch: { dcaFreq: 'biweekly' } },
        { label: '每週定期定額', patch: { dcaFreq: 'weekly' } },
      ];
    }

    const out = [];
    for (const p of presets) {
      try {
        const res = simulateBacktest(bars, {
          ...baseCfg,
          params: { ...baseCfg.params, ...p.patch },
        });
        const active = Object.entries(p.patch).every(([k, v]) => Number(baseCfg.params[k]) === Number(v) || baseCfg.params[k] === v);
        out.push({ ...p, res, active });
      } catch {}
    }
    return out;
  }

  // ---------------- 格式化與配色 ----------------
  const fmtMoney = (v) => (isNum(v) ? Math.round(v).toLocaleString('en-US') : '—');
  const fmtPx = (v) => (isNum(v) ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—');
  const fmtSignedPct = (v) => (isNum(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%` : '—');
  const clsSign = (v) => (isNum(v) ? (v > 0 ? 'up' : v < 0 ? 'down' : '') : '');

  function schemeColors() {
    const isUs = Boolean(document.body?.classList?.contains?.('scheme-us'));
    return {
      up: isUs ? '#2cbd75' : '#ed424e',
      down: isUs ? '#ed424e' : '#2cbd75',
    };
  }

  // ---------------- UI 渲染 ----------------
  function renderScenarioPills() {
    const wrap = $('#bt-scenarios');
    if (!wrap) return;
    wrap.innerHTML = QUICK_SCENARIOS.map((sc) => `
      <button type="button" class="bt-scen-btn ${btState.activeScenario === sc.id ? 'active' : ''}" data-bt-scen="${esc(sc.id)}">${esc(sc.label)}</button>
    `).join('');
  }

  function renderTargetPills() {
    const wrap = $('#bt-target-pills');
    if (!wrap) return;
    wrap.innerHTML = TARGET_PRESETS.map((t) => {
      const active = btState.target === t.key && !btState.customInput;
      return `<button type="button" class="g-pill ${active ? 'active' : ''}" data-bt-target="${esc(t.key)}">${esc(t.label)}</button>`;
    }).join('');
  }

  function renderStrategySelect() {
    const sel = $('#bt-strategy');
    if (sel) sel.value = btState.strategy;
  }

  function renderStrategyDesc() {
    const el = $('#bt-strategy-desc');
    if (!el) return;
    el.textContent = STRATEGIES[btState.strategy]?.desc || '';
  }

  function renderParamControls() {
    const wrap = $('#bt-params-row');
    if (!wrap) return;
    const s = btState.strategy;
    const p = btState.params;
    const stopLossHtml = s !== 'dca' ? `
      <label class="bt-field">
        <span>停損 %（0＝關閉）</span>
        <input type="number" class="g-input bt-num" data-bt-param="stopLossPct" min="0" max="50" step="1" value="${p.stopLossPct}" />
      </label>
    ` : '';

    let fields = '';
    if (s === 'bb_pctb') {
      const exitField = p.bbExitMode === 'hold_months'
        ? `<label class="bt-field">
            <span>持有月數（月後賣出）</span>
            <input type="number" class="g-input bt-num" data-bt-param="bbHoldMonths" min="1" max="36" value="${p.bbHoldMonths}" />
          </label>`
        : p.bbExitMode === 'hold_days'
          ? `<label class="bt-field">
              <span>持有交易日數</span>
              <input type="number" class="g-input bt-num" data-bt-param="bbHoldDays" min="1" max="500" value="${p.bbHoldDays}" />
            </label>`
          : `<label class="bt-field">
              <span>出場 %b 門檻（≥）</span>
              <input type="number" class="g-input bt-num" data-bt-param="bbExitTarget" min="0.2" max="2" step="0.1" value="${p.bbExitTarget}" />
            </label>`;
      const lotField = p.bbSignalMode === 'every_signal'
        ? `<label class="bt-field">
            <span>每次訊號投入金額</span>
            <input type="number" class="g-input bt-num" data-bt-param="bbLotAmount" min="1000" step="10000" value="${p.bbLotAmount}" />
          </label>`
        : '';

      fields = `
        <label class="bt-field">
          <span>布林週期 / 倍數 k</span>
          <div class="bt-inline-pair">
            <input type="number" class="g-input bt-num" data-bt-param="bbPeriod" min="5" max="120" value="${p.bbPeriod}" title="MA 週期" />
            <input type="number" class="g-input bt-num" data-bt-param="bbStd" min="0.5" max="4" step="0.5" value="${p.bbStd}" title="標準差倍數" />
          </div>
        </label>
        <label class="bt-field">
          <span>進場 %b（0＝負數下軌外）</span>
          <input type="number" class="g-input bt-num" data-bt-param="bbEntry" min="-1" max="1" step="0.05" value="${p.bbEntry}" />
        </label>
        <label class="bt-field">
          <span>賣出條件</span>
          <select class="g-input bt-select" data-bt-param="bbExitMode">
            <option value="hold_months" ${p.bbExitMode === 'hold_months' ? 'selected' : ''}>持有 N 個月後賣出</option>
            <option value="hold_days" ${p.bbExitMode === 'hold_days' ? 'selected' : ''}>持有 N 交易日後賣出</option>
            <option value="bb_target" ${p.bbExitMode === 'bb_target' ? 'selected' : ''}>%b 反彈達目標賣出</option>
          </select>
        </label>
        ${exitField}
        <label class="bt-field">
          <span>重複訊號資金模式</span>
          <select class="g-input bt-select" data-bt-param="bbSignalMode">
            <option value="single_pos" ${p.bbSignalMode === 'single_pos' ? 'selected' : ''}>單一資金輪動複利</option>
            <option value="every_signal" ${p.bbSignalMode === 'every_signal' ? 'selected' : ''}>每次訊號獨立買一筆</option>
          </select>
        </label>
        ${lotField}
        ${stopLossHtml}
      `;
    } else if (s === 'bb_breakout') {
      const holdOn = p.bbHoldConfirm !== false && p.bbHoldConfirm !== 'false';
      fields = `
        <label class="bt-field">
          <span>布林週期 / 倍數 k</span>
          <div class="bt-inline-pair">
            <input type="number" class="g-input bt-num" data-bt-param="bbPeriod" min="5" max="120" value="${p.bbPeriod}" title="MA 週期" />
            <input type="number" class="g-input bt-num" data-bt-param="bbStd" min="0.5" max="4" step="0.5" value="${p.bbStd}" title="標準差倍數" />
          </div>
        </label>
        <label class="bt-field">
          <span>步驟1：BBW 壓縮低點分位 ≤ %</span>
          <input type="number" class="g-input bt-num" data-bt-param="bbSqueezePct" min="5" max="95" step="5" value="${p.bbSqueezePct}" title="近期曾低於120日BBW第幾百分位" />
        </label>
        <label class="bt-field">
          <span>步驟2：真突破 %b 進場線 ≥</span>
          <input type="number" class="g-input bt-num" data-bt-param="bbEntryPctB" min="0.5" max="1.5" step="0.05" value="${p.bbEntryPctB}" />
        </label>
        <label class="bt-field">
          <span>步驟3：假突破 3 日內跌回 0.8 停損</span>
          <select class="g-input bt-select" data-bt-param="bbHoldConfirm">
            <option value="true" ${holdOn ? 'selected' : ''}>開啟（%b&lt;0.8 且 BBW 走平停損）</option>
            <option value="false" ${!holdOn ? 'selected' : ''}>關閉（僅依跌破出場線賣出）</option>
          </select>
        </label>
        <label class="bt-field">
          <span>趨勢轉弱出場 %b &lt;</span>
          <input type="number" class="g-input bt-num" data-bt-param="bbExitPctB" min="-0.5" max="1.0" step="0.1" value="${p.bbExitPctB}" />
        </label>
        ${stopLossHtml}
      `;
    } else if (s === 'ma_cross') {
      fields = `
        <label class="bt-field">
          <span>短天期均線 (MA)</span>
          <input type="number" class="g-input bt-num" data-bt-param="shortMa" min="2" max="120" value="${p.shortMa}" />
        </label>
        <label class="bt-field">
          <span>長天期均線 (MA)</span>
          <input type="number" class="g-input bt-num" data-bt-param="longMa" min="5" max="360" value="${p.longMa}" />
        </label>
        ${stopLossHtml}
      `;
    } else if (s === 'ma_single') {
      fields = `
        <label class="bt-field">
          <span>防守均線週期 (MA)</span>
          <input type="number" class="g-input bt-num" data-bt-param="singleMa" min="2" max="360" value="${p.singleMa}" />
        </label>
        <label class="bt-field">
          <span>連續確認天數</span>
          <input type="number" class="g-input bt-num" data-bt-param="confirmDays" min="1" max="5" value="${p.confirmDays}" />
        </label>
        ${stopLossHtml}
      `;
    } else if (s === 'rsi_reversion') {
      fields = `
        <label class="bt-field">
          <span>RSI 週期</span>
          <input type="number" class="g-input bt-num" data-bt-param="rsiPeriod" min="2" max="60" value="${p.rsiPeriod}" />
        </label>
        <label class="bt-field">
          <span>超賣買進線（≤）</span>
          <input type="number" class="g-input bt-num" data-bt-param="rsiBuy" min="5" max="49" value="${p.rsiBuy}" />
        </label>
        <label class="bt-field">
          <span>超買賣出線（≥）</span>
          <input type="number" class="g-input bt-num" data-bt-param="rsiSell" min="51" max="95" value="${p.rsiSell}" />
        </label>
        ${stopLossHtml}
      `;
    } else if (s === 'breakout_stop') {
      fields = `
        <label class="bt-field">
          <span>突破創高天數</span>
          <input type="number" class="g-input bt-num" data-bt-param="breakoutDays" min="3" max="250" value="${p.breakoutDays}" />
        </label>
        <label class="bt-field">
          <span>固定停損 %</span>
          <input type="number" class="g-input bt-num" data-bt-param="stopLossPct" min="0" max="50" value="${p.stopLossPct || 8}" />
        </label>
        <label class="bt-field">
          <span>移動停利回落 %</span>
          <input type="number" class="g-input bt-num" data-bt-param="trailStopPct" min="1" max="60" value="${p.trailStopPct}" />
        </label>
      `;
    } else if (s === 'dca') {
      fields = `
        <label class="bt-field">
          <span>每次扣款金額</span>
          <input type="number" class="g-input bt-num" data-bt-param="dcaAmount" min="1000" step="1000" value="${p.dcaAmount}" />
        </label>
        <label class="bt-field">
          <span>扣款頻率</span>
          <select class="g-input bt-select" data-bt-param="dcaFreq">
            <option value="monthly" ${p.dcaFreq === 'monthly' ? 'selected' : ''}>每月第一個交易日</option>
            <option value="biweekly" ${p.dcaFreq === 'biweekly' ? 'selected' : ''}>每雙週（10 交易日）</option>
            <option value="weekly" ${p.dcaFreq === 'weekly' ? 'selected' : ''}>每週（5 交易日）</option>
          </select>
        </label>
      `;
    }
    wrap.innerHTML = fields;
  }

  function renderFeeInputs() {
    const buyEl = $('#bt-fee-buy');
    const sellEl = $('#bt-fee-sell');
    const presetEl = $('#bt-fee-preset');
    if (presetEl) presetEl.value = btState.feePreset;
    if (buyEl) buyEl.value = btState.feeBuyPct;
    if (sellEl) sellEl.value = btState.feeSellPct;
  }

  function destroyCharts() {
    if (btState.charts.eq) {
      btState.charts.eq.remove();
      btState.charts.eq = null;
    }
    if (btState.charts.sig) {
      btState.charts.sig.remove();
      btState.charts.sig = null;
    }
  }

  function renderCharts(res) {
    const LWC = window.LightweightCharts;
    const eqEl = $('#bt-chart-equity');
    const sigEl = $('#bt-chart-signals');
    if (!eqEl || !sigEl) return;
    destroyCharts();

    if (!LWC) {
      eqEl.innerHTML = '<div class="empty-chart">圖表元件載入中…</div>';
      sigEl.innerHTML = '<div class="empty-chart">圖表元件載入中…</div>';
      return;
    }

    eqEl.innerHTML = '';
    sigEl.innerHTML = '';

    const c = schemeColors();
    const baseOpts = {
      autoSize: true,
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#8b93a1', fontFamily: 'Inter, sans-serif', fontSize: 11 },
      grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(255,255,255,0.05)' } },
      rightPriceScale: { borderVisible: false, minimumWidth: 78 },
      timeScale: { borderVisible: false, timeVisible: false },
      crosshair: { mode: 0 },
      handleScroll: { vertTouchDrag: false },
    };

    const eqChart = LWC.createChart(eqEl, baseOpts);
    const stratColor = res.netProfit >= 0 ? c.up : c.down;
    const eqSeries = eqChart.addAreaSeries({
      lineColor: stratColor,
      topColor: stratColor + '44',
      bottomColor: stratColor + '00',
      lineWidth: 2,
      priceLineVisible: false,
    });
    eqSeries.setData(res.equitySeries);

    const eqLeg = $('#bt-eq-legend');
    if (res.isDca) {
      const invSeries = eqChart.addLineSeries({ color: '#94a3b8', lineWidth: 1.5, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
      invSeries.setData(res.investedSeries);
      const bhSeries = eqChart.addLineSeries({ color: '#5ab0f0', lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });
      bhSeries.setData(res.bhSeries);
      if (eqLeg) {
        eqLeg.innerHTML =
          `<span><i style="background:${stratColor}"></i>定期定額期末市值</span>` +
          `<span><i style="background:#94a3b8"></i>累積投入本金</span>` +
          `<span><i style="background:#5ab0f0"></i>期初單筆買進持有（同總額）</span>`;
      }
    } else {
      const bhSeries = eqChart.addLineSeries({ color: '#5ab0f0', lineWidth: 1.5, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
      bhSeries.setData(res.bhSeries);
      if (eqLeg) {
        eqLeg.innerHTML =
          `<span><i style="background:${stratColor}"></i>${res.isEverySignal ? '獨立筆累計損益曲線（含最高動用本金）' : '策略淨值曲線'}</span>` +
          `<span><i style="background:#5ab0f0"></i>買進持有基準</span>`;
      }
    }
    eqChart.timeScale().fitContent();

    const sigChart = LWC.createChart(sigEl, baseOpts);
    const candleSeries = sigChart.addCandlestickSeries({
      upColor: c.up,
      downColor: c.down,
      borderUpColor: c.up,
      borderDownColor: c.down,
      wickUpColor: c.up,
      wickDownColor: c.down,
      priceLineVisible: false,
    });
    candleSeries.setData(res.candles);

    const legParts = [];
    for (const ov of res.overlayLines) {
      if (!ov.data.length) continue;
      const ls = sigChart.addLineSeries({ color: ov.color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      ls.setData(ov.data);
      legParts.push(`<span><i style="background:${ov.color}"></i>${esc(ov.label)}</span>`);
    }

    const lwcMarkers = res.markers.map((m) => ({
      time: m.time,
      position: m.kind === 'buy' ? 'belowBar' : 'aboveBar',
      color: m.kind === 'buy' ? c.up : c.down,
      shape: m.kind === 'buy' ? 'arrowUp' : 'arrowDown',
      text: m.text,
    }));
    candleSeries.setMarkers(lwcMarkers);
    sigChart.timeScale().fitContent();

    eqChart.timeScale().subscribeVisibleLogicalRangeChange((r) => r && sigChart.timeScale().setVisibleLogicalRange(r));
    sigChart.timeScale().subscribeVisibleLogicalRangeChange((r) => r && eqChart.timeScale().setVisibleLogicalRange(r));

    const sigLeg = $('#bt-sig-legend');
    if (sigLeg) {
      sigLeg.innerHTML =
        legParts.join('') +
        `<span><b style="color:${c.up}">▲ 買進</b></span>` +
        `<span><b style="color:${c.down}">▼ 賣出</b></span>` +
        `<span>日 K 訊號</span>`;
    }

    btState.charts = { eq: eqChart, sig: sigChart };
  }

  function renderKpis(res) {
    const wrap = $('#bt-kpis');
    if (!wrap) return;
    const isDca = res.isDca;
    const pfText = res.profitFactor == null ? '—' : res.profitFactor === Infinity ? '∞' : res.profitFactor.toFixed(2);
    let items;
    if (res.isEverySignal) {
      const lotTxt = fmtMoney(res.lotAmount);
      items = [
        {
          label: `每筆投入 ${lotTxt} 平均報酬`,
          val: res.avgTradeRetPct != null ? fmtSignedPct(res.avgTradeRetPct) : '—',
          cls: clsSign(res.avgTradeRetPct),
          sub: `已滿期 ${res.closedCount} 筆・合計損益 ${res.totalClosedPnl >= 0 ? '+' : '−'}${fmtMoney(Math.abs(res.totalClosedPnl))}`,
          primary: true,
        },
        {
          label: '所有進場累計總賺賠',
          val: `${res.netProfit >= 0 ? '+' : '−'}${fmtMoney(Math.abs(res.netProfit))}`,
          cls: clsSign(res.netProfit),
          sub: `含持倉未平倉・共觸發 ${res.totalTrades} 筆`,
        },
        {
          label: '最高同時動用資金 / 報酬',
          val: `${fmtMoney(res.peakCapital)} (${fmtSignedPct(res.stratRetPct)})`,
          cls: clsSign(res.stratRetPct),
          sub: `同時最多 ${res.maxConcurrent} 筆 · 基準 ${fmtSignedPct(res.bhRetPct)}`,
        },
        {
          label: '單筆勝率 / 賺賠比',
          val: res.winRate != null ? `${res.winRate.toFixed(1)}% / ${pfText}` : '—',
          cls: '',
          sub: `已滿期 ${res.closedCount} 筆（勝 ${res.winCount}）`,
        },
        {
          label: '最大回撤 (Max DD)',
          val: `${res.maxDD.toFixed(2)}%`,
          cls: res.maxDD < -15 ? 'down' : '',
          sub: `買進持有回撤 ${res.bhMaxDD.toFixed(2)}%`,
        },
        {
          label: '平均持有日 / 交易成本',
          val: `${res.avgHoldDays != null ? res.avgHoldDays.toFixed(1) : '—'} 日`,
          cls: '',
          sub: `累計手續費與稅 ${fmtMoney(res.totalFees)}`,
        },
      ];
    } else {
      items = [
        {
          label: isDca ? '定期定額總報酬' : '策略總報酬率',
          val: fmtSignedPct(res.stratRetPct),
          cls: clsSign(res.stratRetPct),
          sub: `買進持有 ${fmtSignedPct(res.bhRetPct)} · 超額 ${fmtSignedPct(res.alphaPct)}`,
          primary: true,
        },
        {
          label: isDca ? '年化內部報酬率 (XIRR)' : '年化報酬率 (CAGR)',
          val: res.stratCagr != null ? fmtSignedPct(res.stratCagr) : '—',
          cls: clsSign(res.stratCagr),
          sub: `基準年化 ${res.bhCagr != null ? fmtSignedPct(res.bhCagr) : '—'}`,
        },
        {
          label: '最大回撤 (Max DD)',
          val: `${res.maxDD.toFixed(2)}%`,
          cls: res.maxDD < -15 ? 'down' : '',
          sub: `買進持有回撤 ${res.bhMaxDD.toFixed(2)}%`,
        },
        {
          label: isDca ? '均價 vs 最新價' : '勝率 / 賺賠比',
          val: isDca ? `${fmtPx(res.avgCost)} / ${fmtPx(res.lastPrice)}` : (res.winRate != null ? `${res.winRate.toFixed(1)}% / ${pfText}` : '—'),
          cls: '',
          sub: isDca ? `累積投入本金 ${fmtMoney(res.totalInvested)}` : `已平倉 ${res.closedCount} 筆（勝 ${res.winCount}${res.avgTradeRetPct != null ? `・均 ${fmtSignedPct(res.avgTradeRetPct)}` : ''}）`,
        },
        {
          label: isDca ? '期末總市值' : '期末總權益',
          val: fmtMoney(res.finalEquity),
          cls: clsSign(res.netProfit),
          sub: `淨損益 ${res.netProfit >= 0 ? '+' : '−'}${fmtMoney(Math.abs(res.netProfit))}`,
        },
        {
          label: isDca ? '扣款次數 / 交易成本' : '交易次數 / 夏普比率',
          val: isDca ? `${res.totalTrades} 次` : `${res.totalTrades} 次 · ${res.sharpe != null ? res.sharpe.toFixed(2) : '—'}`,
          cls: '',
          sub: isDca
            ? `累計手續費 ${fmtMoney(res.totalFees)}`
            : `均持有 ${res.avgHoldDays != null ? res.avgHoldDays.toFixed(1) : '—'} 日 · 費用 ${fmtMoney(res.totalFees)}`,
        },
      ];
    }

    wrap.innerHTML = items.map((k) => `
      <div class="bt-kpi ${k.primary ? 'is-primary' : ''}">
        <div class="bt-kpi-label">${esc(k.label)}</div>
        <div class="bt-kpi-val num ${k.cls}">${esc(k.val)}</div>
        <div class="bt-kpi-sub num">${esc(k.sub)}</div>
      </div>
    `).join('');
  }

  function renderSweep(sweepRows) {
    const wrap = $('#bt-sweep-wrap');
    if (!wrap) return;
    if (!sweepRows.length) {
      wrap.innerHTML = '';
      return;
    }
    const rowsHtml = sweepRows.map((row, idx) => {
      const r = row.res;
      return `
        <tr class="${row.active ? 'is-selected' : ''}" data-bt-sweep="${idx}">
          <td>${esc(row.label)}</td>
          <td class="${clsSign(r.stratRetPct)}">${fmtSignedPct(r.stratRetPct)}</td>
          <td class="${clsSign(r.stratCagr)}">${r.stratCagr != null ? fmtSignedPct(r.stratCagr) : '—'}</td>
          <td class="down">${r.maxDD.toFixed(2)}%</td>
          <td>${r.winRate != null ? r.winRate.toFixed(1) + '%' : '—'}</td>
          <td>${r.totalTrades}</td>
        </tr>
      `;
    }).join('');

    wrap.innerHTML = `
      <div class="chip-sec-bar">
        <div class="chip-sec-title">同區間參數表現對照 <small>點擊任一列即可套用參數</small></div>
      </div>
      <div class="chip-table-wrap">
        <table class="chip-table chip-table-hist" id="bt-sweep-table">
          <thead>
            <tr>
              <th>參數組合</th>
              <th>${btState.result?.isEverySignal ? '累計資金報酬' : '策略報酬'}</th>
              <th>${btState.result?.isEverySignal ? '已平倉均報酬' : '年化報酬'}</th>
              <th>最大回撤</th>
              <th>勝率</th>
              <th>交易次數</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    `;
    wrap._sweep = sweepRows;
  }

  function renderTrades(trades) {
    const wrap = $('#bt-trades-wrap');
    const cntEl = $('#bt-trade-count');
    if (cntEl) cntEl.textContent = `共 ${trades.length} 筆明細（時間 ${btState.execMode === 'close' ? 'T 日收盤執行' : 'T+1 日開盤執行'}）`;
    if (!wrap) return;
    if (!trades.length) {
      wrap.innerHTML = '<div class="chip-empty">所選回測區間內未觸發進場條件，請嘗試調整策略參數或拉長回測區間。</div>';
      return;
    }

    const fmtShares = (s) => (s >= 100 ? Math.round(s).toLocaleString('en-US') : s.toFixed(2));
    const rowsHtml = [...trades].reverse().map((t) => `
      <tr class="${t.open ? 'is-highlight' : ''}">
        <td>#${t.no}</td>
        <td>${esc(t.buyDate)}</td>
        <td>${fmtPx(t.buyPrice)}</td>
        <td>${fmtShares(t.shares)}</td>
        <td>${esc(t.sellDate)}</td>
        <td>${fmtPx(t.sellPrice)}</td>
        <td>${t.holdDays}</td>
        <td class="${clsSign(t.pnl)}">${t.pnl >= 0 ? '+' : '−'}${fmtMoney(Math.abs(t.pnl))}</td>
        <td class="${clsSign(t.retPct)}">${fmtSignedPct(t.retPct)}</td>
        <td class="bt-reason-cell">${esc(t.buyReason)} → ${esc(t.sellReason)}</td>
      </tr>
    `).join('');

    wrap.innerHTML = `
      <div class="chip-table-wrap bt-trades-scroll">
        <table class="chip-table bt-trades-table">
          <thead>
            <tr>
              <th>序</th>
              <th>買進日期</th>
              <th>買進價</th>
              <th>股數／單位</th>
              <th>賣出／評價日</th>
              <th>賣出／最新價</th>
              <th>持有日</th>
              <th>淨損益</th>
              <th>報酬率</th>
              <th>訊號與出場原因</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    `;
  }

  function renderStatusBadge() {
    const badge = $('#bt-data-badge');
    if (!badge) return;
    if (btState.loading) {
      badge.textContent = '載入歷史日 K 中…';
      badge.className = 'badge stale';
    } else if (btState.error) {
      badge.textContent = btState.error;
      badge.className = 'badge z-efear';
    } else if (btState.dataObj) {
      const d = btState.dataObj;
      const bars = d.rows;
      badge.textContent = `${d.name} (${d.symbol}) · ${bars.length} 交易日 (${bars[0].date} ~ ${bars[bars.length - 1].date}) · ${d.source}`;
      badge.className = 'badge live';
    } else {
      badge.textContent = '待載入標的';
      badge.className = 'badge';
    }
  }

  function executeAndRender() {
    const errBox = $('#bt-error');
    if (!btState.dataObj || !btState.dataObj.rows?.length) return;
    try {
      const bars = prepareBars(btState.dataObj.rows, btState.useAdj && btState.dataObj.hasAdj);
      const res = simulateBacktest(bars, {
        strategy: btState.strategy,
        startDate: btState.startDate,
        endDate: btState.endDate,
        capital: btState.capital,
        feeBuyPct: btState.feeBuyPct,
        feeSellPct: btState.feeSellPct,
        execMode: btState.execMode,
        params: btState.params,
      });
      btState.result = res;
      if (errBox) errBox.hidden = true;
      renderKpis(res);
      renderSweep(runSweep(bars, {
        strategy: btState.strategy,
        startDate: btState.startDate,
        endDate: btState.endDate,
        capital: btState.capital,
        feeBuyPct: btState.feeBuyPct,
        feeSellPct: btState.feeSellPct,
        execMode: btState.execMode,
        params: btState.params,
      }));
      renderCharts(res);
      renderTrades(res.trades);
    } catch (err) {
      btState.result = null;
      destroyCharts();
      if (errBox) {
        errBox.hidden = false;
        errBox.textContent = `回測計算提示：${err.message}`;
      }
    }
  }

  async function loadTargetAndRun(symInput, keepDates = false) {
    const query = String(symInput || btState.customInput || btState.target || '0050').trim();
    btState.loading = true;
    btState.error = null;
    renderStatusBadge();
    const errBox = $('#bt-error');
    if (errBox) errBox.hidden = true;

    try {
      const fetcher = window.__STOCKDASH_FETCH_DAILY__;
      if (typeof fetcher !== 'function') throw new Error('歷史資料載入器尚未初始化');
      const d = await fetcher(query, btState.range);
      btState.dataObj = d;

      const feePreset = guessFeePreset(d.key || d.symbol);
      btState.feePreset = feePreset;
      btState.feeBuyPct = FEE_PRESETS[feePreset].buy;
      btState.feeSellPct = FEE_PRESETS[feePreset].sell;
      renderFeeInputs();

      const adjEl = $('#bt-adj');
      if (adjEl) {
        adjEl.disabled = !d.hasAdj;
        adjEl.checked = btState.useAdj && d.hasAdj;
      }

      const bars = prepareBars(d.rows, false);
      const { startDate, endDate } = defaultDatesForRange(bars, btState.range);
      if (!keepDates || !btState.startDate || btState.startDate < bars[0].date) {
        btState.startDate = startDate;
      }
      if (!keepDates || !btState.endDate || btState.endDate > bars[bars.length - 1].date) {
        btState.endDate = endDate;
      }
      const sEl = $('#bt-start');
      const eEl = $('#bt-end');
      if (sEl) {
        sEl.min = bars[0].date;
        sEl.max = bars[bars.length - 1].date;
        sEl.value = btState.startDate;
      }
      if (eEl) {
        eEl.min = bars[0].date;
        eEl.max = bars[bars.length - 1].date;
        eEl.value = btState.endDate;
      }

      btState.loading = false;
      renderStatusBadge();
      executeAndRender();
    } catch (err) {
      btState.loading = false;
      btState.error = err.message;
      renderStatusBadge();
      if (errBox) {
        errBox.hidden = false;
        errBox.textContent = err.message;
      }
    }
  }

  function applyScenario(id) {
    const sc = QUICK_SCENARIOS.find((x) => x.id === id);
    if (!sc) return;
    btState.activeScenario = sc.id;
    btState.target = sc.target;
    btState.customInput = '';
    btState.strategy = sc.strategy;
    Object.assign(btState.params, sc.params);
    const inp = $('#bt-symbol-input');
    if (inp) inp.value = '';
    renderScenarioPills();
    renderTargetPills();
    renderStrategySelect();
    renderStrategyDesc();
    renderParamControls();
    loadTargetAndRun(btState.target, false);
  }

  function bindBacktestEvents() {
    renderScenarioPills();
    renderTargetPills();
    renderStrategySelect();
    renderStrategyDesc();
    renderParamControls();
    renderFeeInputs();

    $('#bt-scenarios')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-bt-scen]');
      if (btn) applyScenario(btn.dataset.btScen);
    });

    $('#bt-target-pills')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-bt-target]');
      if (!btn) return;
      btState.activeScenario = '';
      btState.target = btn.dataset.btTarget;
      btState.customInput = '';
      const inp = $('#bt-symbol-input');
      if (inp) inp.value = '';
      renderScenarioPills();
      renderTargetPills();
      loadTargetAndRun(btState.target, false);
    });

    const triggerCustom = () => {
      const inp = $('#bt-symbol-input');
      const val = (inp?.value || '').trim();
      if (!val) return;
      btState.activeScenario = '';
      btState.customInput = val.toUpperCase();
      btState.target = btState.customInput;
      renderScenarioPills();
      renderTargetPills();
      loadTargetAndRun(btState.customInput, false);
    };
    $('#bt-symbol-load')?.addEventListener('click', triggerCustom);
    $('#bt-symbol-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        triggerCustom();
      }
    });

    $('#bt-range-pills')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-bt-range]');
      if (!btn) return;
      btState.range = btn.dataset.btRange;
      document.querySelectorAll('#bt-range-pills .g-pill').forEach((p) => {
        p.classList.toggle('active', p.dataset.btRange === btState.range);
      });
      await loadTargetAndRun(btState.customInput || btState.target, false);
    });

    $('#bt-start')?.addEventListener('change', (e) => {
      btState.startDate = e.target.value;
      executeAndRender();
    });
    $('#bt-end')?.addEventListener('change', (e) => {
      btState.endDate = e.target.value;
      executeAndRender();
    });

    $('#bt-strategy')?.addEventListener('change', (e) => {
      btState.activeScenario = '';
      btState.strategy = e.target.value;
      if (btState.strategy === 'breakout_stop' && btState.params.stopLossPct === 0) {
        btState.params.stopLossPct = 8;
      }
      renderScenarioPills();
      renderStrategyDesc();
      renderParamControls();
      executeAndRender();
    });

    $('#bt-params-row')?.addEventListener('change', (e) => {
      const el = e.target.closest('[data-bt-param]');
      if (!el) return;
      btState.activeScenario = '';
      const key = el.dataset.btParam;
      btState.params[key] = el.type === 'number' ? Number(el.value) : el.value;
      if (key === 'bbExitMode' || key === 'bbSignalMode') {
        renderParamControls();
      }
      renderScenarioPills();
      executeAndRender();
    });

    $('#bt-capital')?.addEventListener('change', (e) => {
      btState.capital = Math.max(1000, Number(e.target.value) || 1000000);
      executeAndRender();
    });

    $('#bt-fee-preset')?.addEventListener('change', (e) => {
      const p = e.target.value;
      btState.feePreset = p;
      if (FEE_PRESETS[p] && p !== 'custom') {
        btState.feeBuyPct = FEE_PRESETS[p].buy;
        btState.feeSellPct = FEE_PRESETS[p].sell;
        renderFeeInputs();
      }
      executeAndRender();
    });

    const onCustomFee = () => {
      btState.feePreset = 'custom';
      btState.feeBuyPct = Math.max(0, Number($('#bt-fee-buy')?.value) || 0);
      btState.feeSellPct = Math.max(0, Number($('#bt-fee-sell')?.value) || 0);
      const pr = $('#bt-fee-preset');
      if (pr) pr.value = 'custom';
      executeAndRender();
    };
    $('#bt-fee-buy')?.addEventListener('change', onCustomFee);
    $('#bt-fee-sell')?.addEventListener('change', onCustomFee);

    $('#bt-exec-mode')?.addEventListener('change', (e) => {
      btState.execMode = e.target.value === 'close' ? 'close' : 'next_open';
      executeAndRender();
    });

    $('#bt-adj')?.addEventListener('change', (e) => {
      btState.useAdj = e.target.checked;
      executeAndRender();
    });

    $('#bt-run-btn')?.addEventListener('click', () => executeAndRender());

    $('#bt-sweep-wrap')?.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-bt-sweep]');
      if (!tr) return;
      const list = $('#bt-sweep-wrap')?._sweep;
      const chosen = list?.[Number(tr.dataset.btSweep)];
      if (!chosen) return;
      Object.assign(btState.params, chosen.patch);
      renderParamControls();
      executeAndRender();
    });

    window.addEventListener('stockdash:view', (e) => {
      if (e.detail?.view === 'backtest') {
        if (!btState.dataObj && !btState.loading) {
          loadTargetAndRun(btState.target, false);
        } else if (btState.result) {
          requestAnimationFrame(() => renderCharts(btState.result));
        }
      }
    });

    window.addEventListener('stockdash:quotes', () => {
      if (!$('#view-backtest')?.hidden && !btState.dataObj && !btState.loading) {
        loadTargetAndRun(btState.target, false);
      }
    });

    window.addEventListener('stockdash:scheme', () => {
      if (btState.result && !$('#view-backtest')?.hidden) {
        renderCharts(btState.result);
      }
    });

    window.__STOCKDASH_OPEN_BACKTEST__ = (key) => {
      const upper = String(key || '0050').toUpperCase();
      const presetHit = TARGET_PRESETS.find((t) => t.key.toUpperCase() === upper);
      btState.activeScenario = '';
      if (presetHit) {
        btState.target = presetHit.key;
        btState.customInput = '';
        const inp = $('#bt-symbol-input');
        if (inp) inp.value = '';
      } else {
        btState.target = upper;
        btState.customInput = upper;
        const inp = $('#bt-symbol-input');
        if (inp) inp.value = upper;
      }
      renderScenarioPills();
      renderTargetPills();
      window.__STOCKDASH_SET_VIEW__?.('backtest');
      loadTargetAndRun(presetHit ? presetHit.key : upper, false);
    };

    window.__STOCKDASH_BACKTEST_ENGINE__ = {
      simulateBacktest,
      prepareBars,
      bollinger,
      addCalendarMonths,
      calcMaxDrawdown,
      calcSharpe,
      calcXirr,
      runSweep,
    };
  }

  bindBacktestEvents();
})();
