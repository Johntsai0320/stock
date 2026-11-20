/* 股癌選股邏輯、大盤位階判讀與全集數索引（EP1–EP711） */
(() => {
  'use strict';

  const CHECK_KEY = 'stockdash:gooaye-check:v1';
  const REGIME_KEY = 'stockdash:gooaye-regime:v1';
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
    check: loadJson(CHECK_KEY, { ticker: '', checked: {} }),
    regimeFlags: loadJson(REGIME_KEY, { marginHigh: false, zeusLost: false }),
    chipSheet: null,
    chipDate: null,
    instUnit: 'yi',
  };

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) return { ...fallback, ...JSON.parse(raw) };
    } catch {}
    return fallback;
  }

  function saveJson(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch {}
  }

  function epUrl(n) {
    return `https://whatmkreallysaid.com/episodes_static/ep${n}`;
  }

  // ---------------- 大盤位階技術計算 ----------------
  const INDEX_TZ = {
    TWII: 'Asia/Taipei',
    TPEX: 'Asia/Taipei',
    GSPC: 'America/New_York',
    IXIC: 'America/New_York',
    SOX: 'America/New_York',
  };

  function dateInTz(ms, tz) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  }

  function calcIndexMetrics(q, key) {
    if (!q || !Array.isArray(q.daily) || q.daily.length < 5) return null;
    const tz = q.tz || INDEX_TZ[key || q.key] || 'UTC';
    const byDate = new Map();
    for (const b of q.daily) {
      if (!Array.isArray(b) || b.length < 5) continue;
      const c = Number(b[4]);
      if (!Number.isFinite(c) || !Number.isFinite(b[0])) continue;
      const date = dateInTz(b[0], tz);
      byDate.set(date, {
        date,
        h: Number.isFinite(Number(b[2])) ? Number(b[2]) : c,
        l: Number.isFinite(Number(b[3])) ? Number(b[3]) : c,
        c,
      });
    }
    const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    if (!rows.length) return null;

    const price = typeof q.price === 'number' && Number.isFinite(q.price) ? q.price : rows[rows.length - 1].c;
    if (typeof q.price === 'number' && Number.isFinite(q.price) && q.time) {
      const today = dateInTz(q.time, tz);
      const last = rows[rows.length - 1];
      const hi = typeof q.high === 'number' && Number.isFinite(q.high) ? q.high : price;
      const lo = typeof q.low === 'number' && Number.isFinite(q.low) ? q.low : price;
      if (last.date === today) {
        last.c = price;
        last.h = Math.max(last.h, price, hi);
        last.l = Math.min(last.l, price, lo);
      } else if (today > last.date) {
        rows.push({ date: today, h: Math.max(price, hi), l: Math.min(price, lo), c: price });
      }
    }

    const closes = rows.map((r) => r.c);

    const avg = (n) => {
      if (closes.length < n) return null;
      let sum = 0;
      for (let i = closes.length - n; i < closes.length; i++) sum += closes[i];
      return sum / n;
    };

    const ma5 = avg(5);
    const ma10 = avg(10);
    const ma20 = avg(20);
    const ma60 = avg(60);
    const ma120 = avg(120);
    const ma240 = avg(240);

    const win52 = rows.slice(-252);
    let hi52 = price;
    let lo52 = price;
    for (const r of win52) {
      if (r.h > hi52) hi52 = r.h;
      if (r.l < lo52) lo52 = r.l;
    }
    const pct52 = hi52 > lo52 ? Math.max(0, Math.min(100, ((price - lo52) / (hi52 - lo52)) * 100)) : 50;

    const bias = (ma) => (ma ? ((price - ma) / ma) * 100 : null);
    const b5 = bias(ma5);
    const b10 = bias(ma10);
    const b20 = bias(ma20);
    const b60 = bias(ma60);
    const b120 = bias(ma120);
    const b240 = bias(ma240);

    let stage = '盤整觀察';
    let stageCls = 'neutral';
    if (b20 !== null && b60 !== null && b240 !== null) {
      if (b20 > 0 && b60 > 0 && b240 > 0 && pct52 >= 85) {
        stage = b60 >= 10 ? '高檔過熱區' : '多頭創高區';
        stageCls = b60 >= 10 ? 'warn' : 'bull';
      } else if (b20 > 0 && b60 > 0 && b240 > 0) {
        stage = '多頭排列';
        stageCls = 'bull';
      } else if (b60 > 0 && b20 <= 0) {
        stage = '月線下回檔';
        stageCls = 'neutral';
      } else if (b60 <= 0 && b240 > 0) {
        stage = '季線下修正';
        stageCls = 'warn';
      } else if (b240 <= 0) {
        stage = '年線下空頭防禦';
        stageCls = 'bear';
      }
    }

    return { price, pct52, hi52, lo52, ma5, ma10, ma20, ma60, ma120, ma240, b5, b10, b20, b60, b120, b240, stage, stageCls };
  }

  function fmtBias(v) {
    if (v === null || !Number.isFinite(v)) return '—';
    return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
  }

  function biasCls(v) {
    return typeof v === 'number' && Number.isFinite(v) ? (v >= 0 ? 'up' : 'down') : '';
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
    } else if (isG) {
      renderRegimeSection(window.__STOCKDASH_QUOTES__ || {});
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

  function fmtYi(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)} 億`;
  }

  function fmtContracts(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    const sign = v > 0 ? '+' : v < 0 ? '−' : '';
    return `${sign}${Math.abs(Math.round(v)).toLocaleString('en-US')} 口`;
  }

  function fmtDateTW(d) {
    if (!d || d.length !== 8) return '';
    return `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6, 8)}`;
  }

  function fmtRocDateTW(d) {
    if (!d || !/^\d{8}$/.test(d)) return '';
    const rocY = Number(d.slice(0, 4)) - 1911;
    return `${rocY}年${d.slice(4, 6)}月${d.slice(6, 8)}日`;
  }

  function clsSign(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '';
    if (v > 0) return 'up';
    if (v < 0) return 'down';
    return '';
  }

  function fmtInt(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    return Math.round(v).toLocaleString('en-US');
  }

  function fmtSignedInt(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    const n = Math.round(v);
    if (n === 0) return '0';
    return `${n > 0 ? '+' : '−'}${Math.abs(n).toLocaleString('en-US')}`;
  }

  function fmtYiPlain(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    return Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtYiSignedNum(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    if (Math.abs(v) < 0.005) return '0.00';
    return `${v > 0 ? '+' : '−'}${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  const CHIP_META = {
    INST: {
      title: '三大法人買賣金額統計表',
      extLabel: '證交所原頁 ↗',
      extUrl: 'https://www.twse.com.tw/zh/trading/foreign/bfi82u.html',
    },
    FUT_OI: {
      title: '台指期貨三大法人未平倉多空淨額',
      extLabel: '期交所原頁 ↗',
      extUrl: 'https://www.taifex.com.tw/cht/3/futContractsDate',
    },
  };

  function analyzeChips(quotes, tw) {
    const margin = quotes.MARGIN;
    const inst = quotes.INST;
    const futOi = quotes.FUT_OI;
    const twiiQ = quotes.TWII;
    const twDayDown = twiiQ && typeof twiiQ.price === 'number' && typeof twiiQ.prevClose === 'number'
      ? twiiQ.price < twiiQ.prevClose
      : false;
    const twBelowMa60 = tw && tw.b60 !== null && tw.b60 < 0;

    let marginSignal = { label: '尚無融資資料', cls: 'neutral', hint: '', autoSticky: false, cleanFlush: false };
    if (margin && typeof margin.price === 'number') {
      const chg = typeof margin.chg === 'number' ? margin.chg : (margin.price - (margin.prevClose ?? margin.price));
      if ((twDayDown || twBelowMa60) && chg >= -5) {
        marginSignal = {
          label: '融資未減警戒',
          cls: 'warn',
          hint: `台股融資餘額 <b>${margin.price.toLocaleString('en-US', { minimumFractionDigits: 2 })} 億</b>（單日 <b>${fmtYi(chg)}</b>）：大盤走弱但融資未明顯減肥，籌碼尚未洗淨，反彈易遇壓（EP473、EP710）。`,
          autoSticky: true,
          cleanFlush: false,
        };
      } else if (chg <= -30 || (margin.chgPct != null && margin.chgPct <= -1)) {
        marginSignal = {
          label: '融資大減清洗',
          cls: 'bull',
          hint: `台股融資餘額 <b>${margin.price.toLocaleString('en-US', { minimumFractionDigits: 2 })} 億</b>（單日 <b>${fmtYi(chg)}</b>）：出現明顯去槓桿清洗，留意斷頭尾聲與分批試單機會（EP255、EP476）。`,
          autoSticky: false,
          cleanFlush: true,
        };
      } else if (chg >= 25) {
        marginSignal = {
          label: '融資快速升溫',
          cls: 'warn',
          hint: `台股融資餘額 <b>${margin.price.toLocaleString('en-US', { minimumFractionDigits: 2 })} 億</b>（單日 <b>${fmtYi(chg)}</b>）：散戶槓桿快速墊高，高檔須提防籌碼擁擠與急殺風險（EP473）。`,
          autoSticky: false,
          cleanFlush: false,
        };
      } else {
        marginSignal = {
          label: '融資變動溫和',
          cls: 'neutral',
          hint: `台股融資餘額 <b>${margin.price.toLocaleString('en-US', { minimumFractionDigits: 2 })} 億</b>（單日 <b>${fmtYi(chg)}</b>）：信用槓桿變動尚屬平穩。`,
          autoSticky: false,
          cleanFlush: false,
        };
      }
    }

    let instSignal = { label: '尚無法人資料', cls: 'neutral', hint: '' };
    if (inst && typeof inst.foreignYi === 'number') {
      const f = inst.foreignYi;
      const mChg = margin && typeof margin.chg === 'number' ? margin.chg : null;
      if (f >= 150) {
        const combo = mChg !== null && mChg < 0 ? '，且融資同步減肥，屬<b>籌碼良性換手</b>（散戶流向法人）' : '，權值與電子多頭動能有撐';
        instSignal = {
          label: '外資大舉買超',
          cls: 'bull',
          hint: `外資買賣超 <b>${fmtYi(f)}</b>（三大法人合計 <b>${fmtYi(inst.totalYi)}</b>）${combo}（EP1、EP57）。`,
        };
      } else if (f <= -150) {
        const combo = mChg !== null && mChg > 10 ? '，但融資卻逆勢大增，留意<b>法人倒貨、散戶接刀</b>風險' : '，權值股短線承壓，須同步觀察匯率貶值與止穩訊號';
        instSignal = {
          label: '外資大幅賣超',
          cls: 'bear',
          hint: `外資買賣超 <b>${fmtYi(f)}</b>（三大法人合計 <b>${fmtYi(inst.totalYi)}</b>）${combo}（EP1、EP476）。`,
        };
      } else {
        instSignal = {
          label: f >= 0 ? '外資小幅買超' : '外資小幅賣超',
          cls: 'neutral',
          hint: `外資買賣超 <b>${fmtYi(f)}</b>（投信 <b>${fmtYi(inst.trustYi)}</b> · 自營 <b>${fmtYi(inst.dealerYi)}</b> · 合計 <b>${fmtYi(inst.totalYi)}</b>）。`,
        };
      }
    }

    let futOiSignal = { label: '尚無期貨未平倉', cls: 'neutral', hint: '' };
    if (futOi && typeof futOi.price === 'number') {
      const net = futOi.price;
      const chg = typeof futOi.chg === 'number' ? futOi.chg : (net - (futOi.prevClose ?? net));
      if (net >= 5000) {
        futOiSignal = { label: '淨多單偏多', cls: 'bull', hint: `外資台指期淨口數 <b>${fmtContracts(net)}</b>（單日 <b>${fmtContracts(chg)}</b>）。` };
      } else if (net <= -35000) {
        futOiSignal = { label: '高空單避險', cls: 'bear', hint: `外資台指期淨口數 <b>${fmtContracts(net)}</b>（單日 <b>${fmtContracts(chg)}</b>）。` };
      } else if (net < 0) {
        futOiSignal = { label: '淨空單', cls: 'warn', hint: `外資台指期淨口數 <b>${fmtContracts(net)}</b>（單日 <b>${fmtContracts(chg)}</b>）。` };
      } else {
        futOiSignal = { label: '淨多單', cls: 'neutral', hint: `外資台指期淨口數 <b>${fmtContracts(net)}</b>（單日 <b>${fmtContracts(chg)}</b>）。` };
      }
    }

    return { marginSignal, instSignal, futOiSignal };
  }

  function renderChipCards(selector, quotes) {
    const wrap = $(selector);
    if (!wrap) return;
    const margin = quotes.MARGIN;
    const inst = quotes.INST;
    const futOi = quotes.FUT_OI;
    const tw = calcIndexMetrics(quotes.TWII);
    const { marginSignal, instSignal, futOiSignal } = analyzeChips(quotes, tw);

    const mHtml = margin && typeof margin.price === 'number' ? (() => {
      const chg = typeof margin.chg === 'number' ? margin.chg : (margin.price - (margin.prevClose ?? margin.price));
      const chgCls = chg > 0 ? 'up' : chg < 0 ? 'down' : '';
      const shortTxt = margin.shortShares != null
        ? `融券 ${margin.shortShares.toLocaleString('en-US')} 張（${margin.shortChg >= 0 ? '+' : '−'}${Math.abs(margin.shortChg || 0).toLocaleString('en-US')}）`
        : '—';
      return `
        <article class="g-chip-card">
          <div class="g-reg-top">
            <strong>台股融資餘額 <small class="muted">${esc(fmtDateTW(margin.date))}</small></strong>
            <span class="g-reg-badge st-${marginSignal.cls}">${esc(marginSignal.label)}</span>
          </div>
          <div class="g-chip-main">
            <span class="g-reg-price num">${margin.price.toLocaleString('en-US', { minimumFractionDigits: 2 })} <small>億</small></span>
            <span class="g-chip-chg num ${chgCls}">${fmtYi(chg)}（${margin.chgPct >= 0 ? '+' : ''}${(margin.chgPct ?? 0).toFixed(2)}%）</span>
          </div>
          <div class="g-chip-sub">${shortTxt} · ${esc(margin.source || '證交所')}${margin.stale ? '（盤中沿用前日）' : ''}</div>
        </article>
      `;
    })() : `
      <article class="g-chip-card">
        <div class="g-reg-top"><strong>台股融資餘額</strong><span class="badge">待盤後更新</span></div>
        <div class="g-reg-price">—</div>
      </article>
    `;

    const iHtml = inst && typeof inst.foreignYi === 'number' ? (() => {
      const fCls = inst.foreignYi > 0 ? 'up' : inst.foreignYi < 0 ? 'down' : '';
      return `
        <article class="g-chip-card g-chip-clickable" role="button" tabindex="0" data-chip-sheet="INST" aria-label="檢視三大法人買賣金額統計表">
          <div class="g-reg-top">
            <strong>外資買賣超 <small class="muted">${esc(fmtDateTW(inst.date))}</small></strong>
            <span class="g-reg-badge st-${instSignal.cls}">${esc(instSignal.label)}</span>
          </div>
          <div class="g-chip-main">
            <span class="g-reg-price num ${fCls}">${fmtYi(inst.foreignYi)}</span>
            <span class="g-chip-chg num">三大合計 ${fmtYi(inst.totalYi)}</span>
          </div>
          <div class="g-chip-sub g-chip-sub-row">
            <span>投信 ${fmtYi(inst.trustYi)} · 自營 ${fmtYi(inst.dealerYi)} · ${esc(inst.source || '證交所')}${inst.stale ? '（盤中沿用前日）' : ''}</span>
            <span class="g-chip-hint">統計表 ▸</span>
          </div>
        </article>
      `;
    })() : `
      <article class="g-chip-card g-chip-clickable" role="button" tabindex="0" data-chip-sheet="INST" aria-label="檢視三大法人買賣金額統計表">
        <div class="g-reg-top"><strong>外資買賣超</strong><span class="badge">待盤後更新</span></div>
        <div class="g-reg-price">—</div>
        <div class="g-chip-sub g-chip-sub-row"><span>點擊檢視三大法人統計表</span><span class="g-chip-hint">統計表 ▸</span></div>
      </article>
    `;

    const fHtml = futOi && typeof futOi.price === 'number' ? (() => {
      const net = futOi.price;
      const chg = typeof futOi.chg === 'number' ? futOi.chg : (net - (futOi.prevClose ?? net));
      const netCls = net > 0 ? 'up' : net < 0 ? 'down' : '';
      const chgCls = chg > 0 ? 'up' : chg < 0 ? 'down' : '';
      const longStr = futOi.longOI != null ? futOi.longOI.toLocaleString('en-US') : '—';
      const shortStr = futOi.shortOI != null ? futOi.shortOI.toLocaleString('en-US') : '—';
      const trustTxt = typeof futOi.trustNetOI === 'number' ? ` · 投信 ${fmtContracts(futOi.trustNetOI)}` : '';
      return `
        <article class="g-chip-card g-chip-clickable" role="button" tabindex="0" data-chip-sheet="FUT_OI" aria-label="檢視台指期貨三大法人未平倉多空淨額">
          <div class="g-reg-top">
            <strong>外資期貨多空口數淨額 <small class="muted">${esc(fmtDateTW(futOi.date))}</small></strong>
            <span class="g-reg-badge st-${futOiSignal.cls}">${esc(futOiSignal.label)}</span>
          </div>
          <div class="g-chip-main">
            <span class="g-reg-price num ${netCls}">${fmtContracts(net)}</span>
            <span class="g-chip-chg num ${chgCls}">單日 ${fmtContracts(chg)}</span>
          </div>
          <div class="g-chip-sub g-chip-sub-row">
            <span>多單 ${longStr} · 空單 ${shortStr} 口${trustTxt} · ${esc(futOi.source || '期交所')}${futOi.stale ? '（盤中沿用前日）' : ''}</span>
            <span class="g-chip-hint">未平倉表 ▸</span>
          </div>
        </article>
      `;
    })() : `
      <article class="g-chip-card g-chip-clickable" role="button" tabindex="0" data-chip-sheet="FUT_OI" aria-label="檢視台指期貨三大法人未平倉多空淨額">
        <div class="g-reg-top"><strong>外資期貨多空口數淨額</strong><span class="badge">待盤後更新</span></div>
        <div class="g-reg-price">—</div>
        <div class="g-chip-sub g-chip-sub-row"><span>點擊檢視台指期未平倉表</span><span class="g-chip-hint">未平倉表 ▸</span></div>
      </article>
    `;

    wrap.innerHTML = mHtml + iHtml + fHtml;
  }

  function renderChipHighlight(quotes) {
    const mValEl = $('#hl-margin-value');
    const mDetEl = $('#hl-margin-detail');
    const iValEl = $('#hl-inst-value');
    const iDetEl = $('#hl-inst-detail');
    const fValEl = $('#hl-futoi-value');
    const fDetEl = $('#hl-futoi-detail');
    const margin = quotes.MARGIN;
    const inst = quotes.INST;
    const futOi = quotes.FUT_OI;

    if (mValEl && mDetEl) {
      if (margin && typeof margin.price === 'number') {
        const chg = typeof margin.chg === 'number' ? margin.chg : (margin.price - (margin.prevClose ?? margin.price));
        const pctStr = margin.chgPct != null ? `（${margin.chgPct >= 0 ? '+' : ''}${margin.chgPct.toFixed(2)}%）` : '';
        mValEl.textContent = fmtYi(chg);
        mValEl.className = `hl-value num ${chg > 0 ? 'up' : chg < 0 ? 'down' : ''}`;
        mDetEl.textContent = `餘額 ${margin.price.toLocaleString('en-US', { minimumFractionDigits: 2 })} 億${pctStr}${margin.date ? ' · ' + fmtDateTW(margin.date).slice(5) : ''}`;
      } else {
        mValEl.textContent = '—';
        mValEl.className = 'hl-value';
        mDetEl.textContent = '待盤後公布';
      }
    }

    if (iValEl && iDetEl) {
      if (inst && typeof inst.foreignYi === 'number') {
        const f = inst.foreignYi;
        iValEl.textContent = fmtYi(f);
        iValEl.className = `hl-value num ${f > 0 ? 'up' : f < 0 ? 'down' : ''}`;
        iDetEl.textContent = `合計 ${fmtYi(inst.totalYi)} · 投信 ${fmtYi(inst.trustYi)}${inst.date ? ' · ' + fmtDateTW(inst.date).slice(5) : ''}`;
      } else {
        iValEl.textContent = '—';
        iValEl.className = 'hl-value';
        iDetEl.textContent = '待盤後公布';
      }
    }

    if (fValEl && fDetEl) {
      if (futOi && typeof futOi.price === 'number') {
        const net = futOi.price;
        const chg = typeof futOi.chg === 'number' ? futOi.chg : (net - (futOi.prevClose ?? net));
        const netCls = net > 0 ? 'up' : net < 0 ? 'down' : '';
        const chgCls = chg > 0 ? 'up' : chg < 0 ? 'down' : '';
        fValEl.className = 'hl-value hl-value-split num';
        fValEl.innerHTML = `<span class="${netCls}">${fmtContracts(net)}</span><span class="hl-sub-chg ${chgCls}">單日 ${fmtContracts(chg)}</span>`;
        const longStr = futOi.longOI != null ? futOi.longOI.toLocaleString('en-US') : '—';
        const shortStr = futOi.shortOI != null ? futOi.shortOI.toLocaleString('en-US') : '—';
        fDetEl.textContent = `多 ${longStr} · 空 ${shortStr}${futOi.date ? ' · ' + fmtDateTW(futOi.date).slice(5) : ''}`;
      } else {
        fValEl.textContent = '—';
        fValEl.className = 'hl-value';
        fDetEl.textContent = '待盤後公布';
      }
    }
  }

  // ---------------- 台股籌碼詳細統計表 Bottom Sheet ----------------
  function renderBarChartSvg(items, { title, activeDate, formatVal }) {
    const valid = items.filter((it) => it && it.date && typeof it.val === 'number' && Number.isFinite(it.val));
    if (valid.length < 2) return '';
    const W = 600;
    const H = 120;
    const padY = 12;
    const usableH = H - padY * 2;
    const vals = valid.map((it) => it.val);
    const maxPos = Math.max(0, ...vals);
    const minNeg = Math.min(0, ...vals);
    const span = maxPos - minNeg || 1;
    const zeroY = padY + (maxPos / span) * usableH;
    const step = W / valid.length;
    const bw = Math.max(4, Math.min(20, step * 0.72));

    const selItem = valid.find((it) => it.date === activeDate) || valid[valid.length - 1];
    const rects = valid.map((it, i) => {
      const x = i * step + (step - bw) / 2;
      const barH = Math.max(2, (Math.abs(it.val) / span) * usableH);
      const y = it.val >= 0 ? zeroY - barH : zeroY;
      const fill = it.val > 0 ? 'var(--up)' : it.val < 0 ? 'var(--down)' : 'var(--flat)';
      const isSel = it.date === selItem.date;
      const op = isSel ? '1' : '0.68';
      const stroke = isSel ? 'var(--accent)' : 'none';
      const sw = isSel ? '1.6' : '0';
      return `<rect class="bar-rect" data-chip-date="${esc(it.date)}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${barH.toFixed(1)}" rx="2" fill="${fill}" opacity="${op}" stroke="${stroke}" stroke-width="${sw}"><title>${esc(fmtDateTW(it.date))}：${esc(formatVal(it.val))}</title></rect>`;
    }).join('');

    return `
      <div class="chip-chart-box">
        <div class="chip-chart-head">
          <span>${esc(title)}</span>
          <span class="num">${esc(fmtDateTW(selItem.date))} <b class="${clsSign(selItem.val)}">${esc(formatVal(selItem.val))}</b></span>
        </div>
        <svg class="chip-bar-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(title)}">
          <line x1="0" y1="${zeroY.toFixed(1)}" x2="${W}" y2="${zeroY.toFixed(1)}" stroke="rgba(255,255,255,0.22)" stroke-dasharray="3 3" stroke-width="1" />
          ${rects}
        </svg>
        <div class="chip-bar-axis num">
          <span>${esc(fmtDateTW(valid[0].date))}</span>
          <span>點擊柱狀或下方日期檢視當日明細</span>
          <span>${esc(fmtDateTW(valid[valid.length - 1].date))}</span>
        </div>
      </div>
    `;
  }

  function renderInstSheet(inst) {
    const subEl = $('#chip-sheet-sub');
    if (!inst || typeof inst.foreignYi !== 'number') {
      if (subEl) subEl.textContent = '臺灣證券交易所 BFI82U · 待盤後更新';
      return '<div class="chip-empty">三大法人買賣金額資料尚待盤後公布，您亦可點擊右上角「證交所原頁 ↗」直接查閱。</div>';
    }

    const history = Array.isArray(inst.history) ? inst.history : [];
    const fallbackActive = {
      date: inst.date || '',
      foreignYi: inst.foreignYi,
      trustYi: inst.trustYi,
      dealerSelfYi: inst.dealerSelfYi,
      dealerHedgeYi: inst.dealerHedgeYi,
      dealerYi: inst.dealerYi,
      totalYi: inst.totalYi,
      rows: Array.isArray(inst.rows) ? inst.rows : [],
    };
    let active = gState.chipDate
      ? history.find((h) => h.date === gState.chipDate)
      : history.find((h) => h.date === inst.date) || fallbackActive;
    if (!active) active = fallbackActive;
    if (active.date === inst.date && Array.isArray(inst.rows) && inst.rows.length) {
      active = { ...active, rows: inst.rows };
    }

    const isLatest = !active.date || active.date === inst.date;
    const rocStr = fmtRocDateTW(active.date) || fmtDateTW(active.date);
    if (subEl) {
      subEl.textContent = `${rocStr} · ${inst.source || '證交所三大法人'}${inst.stale && isLatest ? '（盤中沿用前日）' : ''}${!isLatest ? '（歷史日明細）' : ''}`;
    }

    const isNtd = gState.instUnit === 'ntd';
    const unitTag = isNtd ? '元' : '億';
    const rows = Array.isArray(active.rows) && active.rows.length
      ? active.rows
      : [
          ...(typeof active.dealerSelfYi === 'number' ? [{ name: '自營商(自行買賣)', buy: null, sell: null, diff: Math.round(active.dealerSelfYi * 1e8) }] : []),
          ...(typeof active.dealerHedgeYi === 'number' ? [{ name: '自營商(避險)', buy: null, sell: null, diff: Math.round(active.dealerHedgeYi * 1e8) }] : []),
          ...(typeof active.dealerSelfYi !== 'number' && typeof active.dealerYi === 'number' ? [{ name: '自營商合計', buy: null, sell: null, diff: Math.round(active.dealerYi * 1e8) }] : []),
          { name: '投信', buy: null, sell: null, diff: Math.round((active.trustYi || 0) * 1e8) },
          { name: '外資及陸資(不含外資自營商)', buy: null, sell: null, diff: Math.round((active.foreignYi || 0) * 1e8) },
          { name: '合計', buy: null, sell: null, diff: Math.round((active.totalYi || 0) * 1e8) },
        ];

    const dealerSub = typeof active.dealerSelfYi === 'number' && typeof active.dealerHedgeYi === 'number'
      ? `自行 ${fmtYiSignedNum(active.dealerSelfYi)} · 避險 ${fmtYiSignedNum(active.dealerHedgeYi)}`
      : '自行＋避險';

    const kpiHtml = `
      <div class="chip-kpi-grid">
        <div class="chip-kpi is-primary">
          <div class="chip-kpi-label">外資及陸資</div>
          <div class="chip-kpi-val num ${clsSign(active.foreignYi)}">${fmtYi(active.foreignYi)}</div>
          <div class="chip-kpi-sub">不含外資自營商</div>
        </div>
        <div class="chip-kpi">
          <div class="chip-kpi-label">投信</div>
          <div class="chip-kpi-val num ${clsSign(active.trustYi)}">${fmtYi(active.trustYi)}</div>
          <div class="chip-kpi-sub">買賣差額</div>
        </div>
        <div class="chip-kpi">
          <div class="chip-kpi-label">自營商合計</div>
          <div class="chip-kpi-val num ${clsSign(active.dealerYi)}">${fmtYi(active.dealerYi)}</div>
          <div class="chip-kpi-sub num">${esc(dealerSub)}</div>
        </div>
        <div class="chip-kpi">
          <div class="chip-kpi-label">三大法人合計</div>
          <div class="chip-kpi-val num ${clsSign(active.totalYi)}">${fmtYi(active.totalYi)}</div>
          <div class="chip-kpi-sub num">${esc(fmtDateTW(active.date))}</div>
        </div>
      </div>
    `;

    const tableRowsHtml = rows.map((r) => {
      const rCls = r.name === '合計'
        ? 'is-total'
        : r.name.startsWith('外資及陸資')
          ? 'is-highlight'
          : r.name === '外資自營商'
            ? 'is-subrow'
            : '';
      const buyTxt = typeof r.buy === 'number' ? (isNtd ? fmtInt(r.buy) : fmtYiPlain(r.buy / 1e8)) : '—';
      const sellTxt = typeof r.sell === 'number' ? (isNtd ? fmtInt(r.sell) : fmtYiPlain(r.sell / 1e8)) : '—';
      const diffTxt = typeof r.diff === 'number' ? (isNtd ? fmtSignedInt(r.diff) : fmtYiSignedNum(r.diff / 1e8)) : '—';
      return `
        <tr class="${rCls}">
          <td>${esc(r.name)}</td>
          <td>${buyTxt}</td>
          <td>${sellTxt}</td>
          <td class="${clsSign(r.diff)}">${diffTxt}</td>
        </tr>
      `;
    }).join('');

    const mainTableHtml = `
      <div class="chip-sec-bar">
        <div class="chip-sec-title">三大法人買賣金額統計表 <small>${esc(rocStr)}</small></div>
        <div class="chip-sec-controls">
          ${!isLatest ? '<button type="button" class="chip-back-btn" data-chip-latest="1">回到最新</button>' : ''}
          <div class="chip-unit-switch" role="group" aria-label="金額單位切換">
            <button type="button" class="chip-unit-btn ${!isNtd ? 'active' : ''}" data-inst-unit="yi" aria-pressed="${!isNtd}">億元</button>
            <button type="button" class="chip-unit-btn ${isNtd ? 'active' : ''}" data-inst-unit="ntd" aria-pressed="${isNtd}">新台幣元</button>
          </div>
        </div>
      </div>
      <div class="chip-table-wrap">
        <table class="chip-table">
          <thead>
            <tr>
              <th>單位名稱</th>
              <th>買進金額（${unitTag}）</th>
              <th>賣出金額（${unitTag}）</th>
              <th>買賣差額（${unitTag}）</th>
            </tr>
          </thead>
          <tbody>${tableRowsHtml}</tbody>
        </table>
      </div>
      <p class="chip-note">註：依臺灣證券交易所 BFI82U 統計口徑，「外資自營商」買賣金額已計入「自營商」內，三大法人合計＝自營商(自行＋避險)＋投信＋外資及陸資(不含外資自營商)。</p>
    `;

    const chartHtml = renderBarChartSvg(
      history.map((h) => ({ date: h.date, val: typeof h.foreignYi === 'number' ? h.foreignYi : h.v })),
      {
        title: `近 ${history.length} 交易日 外資買賣超（億）`,
        activeDate: active.date,
        formatVal: fmtYi,
      }
    );

    let histHtml = '';
    if (history.length) {
      const fVal = (h) => (typeof h.foreignYi === 'number' ? h.foreignYi : h.v);
      const sum5 = history.length >= 5
        ? history.slice(-5).reduce((a, h) => a + (fVal(h) || 0), 0)
        : null;
      const sum20 = history.length >= 20
        ? history.slice(-20).reduce((a, h) => a + (fVal(h) || 0), 0)
        : null;
      const sumPills = [
        sum5 !== null ? `<span class="chip-sum-pill num">外資近5日<b class="${clsSign(sum5)}">${fmtYi(sum5)}</b></span>` : '',
        sum20 !== null ? `<span class="chip-sum-pill num">近20日<b class="${clsSign(sum20)}">${fmtYi(sum20)}</b></span>` : '',
      ].filter(Boolean).join('');

      const histRows = [...history].reverse().map((h) => {
        const fv = fVal(h);
        const tv = h.trustYi;
        const dv = h.dealerYi;
        const tot = typeof h.totalYi === 'number' ? h.totalYi : h.total;
        return `
          <tr data-chip-date="${esc(h.date)}" class="${h.date === active.date ? 'is-selected' : ''}">
            <td>${esc(fmtDateTW(h.date))}</td>
            <td class="${clsSign(fv)}">${fmtYiSignedNum(fv)}</td>
            <td class="${clsSign(tv)}">${fmtYiSignedNum(tv)}</td>
            <td class="${clsSign(dv)}">${fmtYiSignedNum(dv)}</td>
            <td class="${clsSign(tot)}">${fmtYiSignedNum(tot)}</td>
          </tr>
        `;
      }).join('');

      histHtml = `
        <div class="chip-sec-bar">
          <div class="chip-sec-title">近 ${history.length} 交易日逐日統計 <small>單位：億元</small></div>
          ${sumPills ? `<div class="chip-sum-pills">${sumPills}</div>` : ''}
        </div>
        <div class="chip-table-wrap chip-table-hist-wrap">
          <table class="chip-table chip-table-hist">
            <thead>
              <tr>
                <th>日期</th>
                <th>外資</th>
                <th>投信</th>
                <th>自營商</th>
                <th>三大合計</th>
              </tr>
            </thead>
            <tbody>${histRows}</tbody>
          </table>
        </div>
      `;
    }

    return kpiHtml + mainTableHtml + chartHtml + histHtml;
  }

  function renderFutOiSheet(futOi) {
    const subEl = $('#chip-sheet-sub');
    if (!futOi || typeof futOi.price !== 'number') {
      if (subEl) subEl.textContent = '臺灣期貨交易所 TXF · 待盤後更新';
      return '<div class="chip-empty">台指期貨三大法人未平倉資料尚待盤後公布，您亦可點擊右上角「期交所原頁 ↗」直接查閱。</div>';
    }

    const history = Array.isArray(futOi.history) ? futOi.history : [];
    const fallbackActive = {
      date: futOi.date || '',
      foreign: futOi.price,
      foreignChg: futOi.chg,
      longOI: futOi.longOI,
      shortOI: futOi.shortOI,
      trust: futOi.trustNetOI,
      trustChg: futOi.trustChg,
      dealer: futOi.dealerNetOI,
      dealerChg: futOi.dealerChg,
      total: futOi.totalNetOI,
      totalChg: futOi.totalChg,
      rows: Array.isArray(futOi.rows) ? futOi.rows : [],
    };
    let active = gState.chipDate
      ? history.find((h) => h.date === gState.chipDate)
      : history.find((h) => h.date === futOi.date) || fallbackActive;
    if (!active) active = fallbackActive;
    if (active.date === futOi.date && Array.isArray(futOi.rows) && futOi.rows.length) {
      active = { ...active, rows: futOi.rows };
    }

    const isLatest = !active.date || active.date === futOi.date;
    const rocStr = fmtRocDateTW(active.date) || fmtDateTW(active.date);
    if (subEl) {
      subEl.textContent = `${rocStr} · 臺股期貨（TXF） · ${futOi.source || '期交所'}${futOi.stale && isLatest ? '（盤中沿用前日）' : ''}${!isLatest ? '（歷史日明細）' : ''}`;
    }

    const fNet = typeof active.foreign === 'number' ? active.foreign : active.net;
    const fChg = typeof active.foreignChg === 'number' ? active.foreignChg : active.chg;
    const tNet = active.trust;
    const tChg = active.trustChg;
    const dNet = active.dealer;
    const dChg = active.dealerChg;
    const totNet = active.total;
    const totChg = active.totalChg;

    const kpiHtml = `
      <div class="chip-kpi-grid">
        <div class="chip-kpi is-primary">
          <div class="chip-kpi-label">外資及陸資</div>
          <div class="chip-kpi-val num ${clsSign(fNet)}">${fmtContracts(fNet)}</div>
          <div class="chip-kpi-sub num ${clsSign(fChg)}">單日 ${fmtContracts(fChg)}</div>
        </div>
        <div class="chip-kpi">
          <div class="chip-kpi-label">投信</div>
          <div class="chip-kpi-val num ${clsSign(tNet)}">${fmtContracts(tNet)}</div>
          <div class="chip-kpi-sub num ${clsSign(tChg)}">單日 ${fmtContracts(tChg)}</div>
        </div>
        <div class="chip-kpi">
          <div class="chip-kpi-label">自營商</div>
          <div class="chip-kpi-val num ${clsSign(dNet)}">${fmtContracts(dNet)}</div>
          <div class="chip-kpi-sub num ${clsSign(dChg)}">單日 ${fmtContracts(dChg)}</div>
        </div>
        <div class="chip-kpi">
          <div class="chip-kpi-label">三大法人合計</div>
          <div class="chip-kpi-val num ${clsSign(totNet)}">${fmtContracts(totNet)}</div>
          <div class="chip-kpi-sub num ${clsSign(totChg)}">單日 ${fmtContracts(totChg)}</div>
        </div>
      </div>
    `;

    const rows = Array.isArray(active.rows) && active.rows.length
      ? active.rows
      : [
          ...(typeof dNet === 'number' ? [{ role: '自營商', longOI: null, shortOI: null, netOI: dNet, chg: dChg ?? null, netAmtYi: null, tradeNet: null }] : []),
          ...(typeof tNet === 'number' ? [{ role: '投信', longOI: null, shortOI: null, netOI: tNet, chg: tChg ?? null, netAmtYi: null, tradeNet: null }] : []),
          { role: '外資及陸資', longOI: active.longOI ?? null, shortOI: active.shortOI ?? null, netOI: fNet, chg: fChg ?? null, netAmtYi: active.foreignAmtYi ?? null, tradeNet: null },
          ...(typeof totNet === 'number' ? [{ role: '合計', longOI: null, shortOI: null, netOI: totNet, chg: totChg ?? null, netAmtYi: null, tradeNet: null }] : []),
        ];

    const tableRowsHtml = rows.map((r) => {
      const rCls = r.role === '合計'
        ? 'is-total'
        : r.role.includes('外資')
          ? 'is-highlight'
          : '';
      return `
        <tr class="${rCls}">
          <td>${esc(r.role)}</td>
          <td>${fmtInt(r.longOI)}</td>
          <td>${fmtInt(r.shortOI)}</td>
          <td class="${clsSign(r.netOI)}">${fmtSignedInt(r.netOI)}</td>
          <td class="${clsSign(r.chg)}">${fmtSignedInt(r.chg)}</td>
          <td class="${clsSign(r.netAmtYi)}">${typeof r.netAmtYi === 'number' ? fmtYiSignedNum(r.netAmtYi) : '—'}</td>
          <td class="${clsSign(r.tradeNet)}">${fmtSignedInt(r.tradeNet)}</td>
        </tr>
      `;
    }).join('');

    const mainTableHtml = `
      <div class="chip-sec-bar">
        <div class="chip-sec-title">臺股期貨（TXF）三大法人未平倉多空淨額 <small>${esc(rocStr)}</small></div>
        <div class="chip-sec-controls">
          ${!isLatest ? '<button type="button" class="chip-back-btn" data-chip-latest="1">回到最新</button>' : ''}
        </div>
      </div>
      <div class="chip-table-wrap">
        <table class="chip-table">
          <thead>
            <tr>
              <th>身份別</th>
              <th>多方未平倉</th>
              <th>空方未平倉</th>
              <th>多空淨額（口）</th>
              <th>單日增減</th>
              <th>淨額金額（億）</th>
              <th>當日交易淨額</th>
            </tr>
          </thead>
          <tbody>${tableRowsHtml}</tbody>
        </table>
      </div>
      <p class="chip-note">註：資料來源為臺灣期貨交易所「臺股期貨（TXF）三大法人區分各期貨契約」日表；單日增減為當日與前一交易日之未平倉多空淨額差，淨額契約金額由千元換算為億元。</p>
    `;

    const chartHtml = renderBarChartSvg(
      history.map((h) => ({ date: h.date, val: typeof h.foreign === 'number' ? h.foreign : h.net })),
      {
        title: `近 ${history.length} 交易日 外資台指期未平倉多空淨額（口）`,
        activeDate: active.date,
        formatVal: fmtContracts,
      }
    );

    let histHtml = '';
    if (history.length) {
      const fVal = (h) => (typeof h.foreign === 'number' ? h.foreign : h.net);
      const latestVal = fVal(history[history.length - 1]);
      const chg5 = history.length >= 6 && typeof latestVal === 'number' && typeof fVal(history[history.length - 6]) === 'number'
        ? latestVal - fVal(history[history.length - 6])
        : null;
      const chg20 = history.length >= 21 && typeof latestVal === 'number' && typeof fVal(history[history.length - 21]) === 'number'
        ? latestVal - fVal(history[history.length - 21])
        : null;
      const sumPills = [
        chg5 !== null ? `<span class="chip-sum-pill num">外資近5日<b class="${clsSign(chg5)}">${fmtContracts(chg5)}</b></span>` : '',
        chg20 !== null ? `<span class="chip-sum-pill num">近20日<b class="${clsSign(chg20)}">${fmtContracts(chg20)}</b></span>` : '',
      ].filter(Boolean).join('');

      const fmtCellWithChg = (val, chg) => {
        if (typeof val !== 'number') return '—';
        const chgHtml = typeof chg === 'number'
          ? `<span class="chip-cell-chg ${clsSign(chg)}">(${fmtSignedInt(chg)})</span>`
          : '';
        return `<span class="${clsSign(val)}">${fmtSignedInt(val)}</span>${chgHtml}`;
      };

      const histRows = [...history].reverse().map((h) => {
        const fv = fVal(h);
        const fc = typeof h.foreignChg === 'number' ? h.foreignChg : h.chg;
        return `
          <tr data-chip-date="${esc(h.date)}" class="${h.date === active.date ? 'is-selected' : ''}">
            <td>${esc(fmtDateTW(h.date))}</td>
            <td>${fmtCellWithChg(fv, fc)}</td>
            <td>${fmtCellWithChg(h.trust, h.trustChg)}</td>
            <td>${fmtCellWithChg(h.dealer, h.dealerChg)}</td>
            <td class="${clsSign(h.total)}">${fmtSignedInt(h.total)}</td>
          </tr>
        `;
      }).join('');

      histHtml = `
        <div class="chip-sec-bar">
          <div class="chip-sec-title">近 ${history.length} 交易日未平倉淨額變化 <small>單位：口（括號為單日增減）</small></div>
          ${sumPills ? `<div class="chip-sum-pills">${sumPills}</div>` : ''}
        </div>
        <div class="chip-table-wrap chip-table-hist-wrap">
          <table class="chip-table chip-table-hist">
            <thead>
              <tr>
                <th>日期</th>
                <th>外資淨額（日增減）</th>
                <th>投信淨額（日增減）</th>
                <th>自營商（日增減）</th>
                <th>三大合計</th>
              </tr>
            </thead>
            <tbody>${histRows}</tbody>
          </table>
        </div>
      `;
    }

    return kpiHtml + mainTableHtml + chartHtml + histHtml;
  }

  function renderChipSheet(quotes) {
    const kind = gState.chipSheet;
    if (!kind || !CHIP_META[kind]) return;
    const meta = CHIP_META[kind];
    const titleEl = $('#chip-sheet-title');
    const extEl = $('#chip-sheet-ext');
    const bodyEl = $('#chip-sheet-body');
    if (titleEl) titleEl.textContent = meta.title;
    if (extEl) {
      extEl.textContent = meta.extLabel;
      extEl.href = meta.extUrl;
    }
    if (!bodyEl) return;
    const q = quotes || window.__STOCKDASH_QUOTES__ || {};
    bodyEl.innerHTML = kind === 'INST'
      ? renderInstSheet(q.INST)
      : renderFutOiSheet(q.FUT_OI);
  }

  function openChipSheet(kind) {
    if (!CHIP_META[kind]) return;
    const sheet = $('#chip-sheet');
    const backdrop = $('#chip-sheet-backdrop');
    if (!sheet || !backdrop) return;
    gState.chipSheet = kind;
    gState.chipDate = null;
    renderChipSheet(window.__STOCKDASH_QUOTES__ || {});
    sheet.hidden = false;
    backdrop.hidden = false;
    sheet.scrollTop = 0;
    document.body.style.overflow = 'hidden';
  }

  function closeChipSheet() {
    gState.chipSheet = null;
    gState.chipDate = null;
    const sheet = $('#chip-sheet');
    const backdrop = $('#chip-sheet-backdrop');
    if (sheet) sheet.hidden = true;
    if (backdrop) backdrop.hidden = true;
    const stockSheet = $('#sheet');
    if (!stockSheet || stockSheet.hidden) {
      document.body.style.overflow = '';
    }
  }

  function renderRegimeSection(quotes) {
    renderRegimeGrid(quotes);
    renderChipCards('#gooaye-chip-grid', quotes);
    renderRegimeToggles();
    renderLiveBanner(quotes);
    renderRegimeRules();
  }

  function renderLiveBanner(quotes) {
    const el = $('#gooaye-live-signal');
    if (!el) return;

    const tw = calcIndexMetrics(quotes.TWII);
    const sp = calcIndexMetrics(quotes.GSPC);
    const sox = calcIndexMetrics(quotes.SOX);
    const fgi = quotes.FGI;
    const vix = quotes.VIX;
    const { marginSignal, instSignal } = analyzeChips(quotes, tw);

    // 綜合位階判定
    let regimeLabel = '中性震盪觀察';
    let tone = 'neutral';
    let actionAdvice = '維持核心配置，主動部位分批試單、不追高。';

    const marginSticky = gState.regimeFlags.marginHigh || marginSignal.autoSticky;
    const { zeusLost } = gState.regimeFlags;
    const fgiVal = fgi && typeof fgi.price === 'number' ? fgi.price : null;
    const vixVal = vix && typeof vix.price === 'number' ? vix.price : null;

    if (zeusLost || (tw && tw.b60 !== null && tw.b60 < 0 && marginSticky)) {
      regimeLabel = '防禦減碼區（籌碼未淨／喪失宙斯）';
      tone = 'warn';
      actionAdvice = '扣留現金、降低槓桿，反彈偏減碼不追價（EP474、EP710）。';
    } else if (tw && tw.b240 !== null && tw.b240 < 0) {
      regimeLabel = '空頭／長線年線下修正';
      tone = 'warn';
      actionAdvice = '嚴守吃筍停損與現金部位，等待斷頭清洗尾聲再分批左側試單（EP189、EP476）。';
    } else if ((fgiVal !== null && fgiVal <= 25 && vixVal !== null && vixVal >= 24) || marginSignal.cleanFlush) {
      regimeLabel = '恐慌／融資清洗區（潛在左側機會）';
      tone = 'opp';
      actionAdvice = '留意去槓桿與斷頭潮尾聲，分批承接核心標的，保留安全邊際（EP255、EP476）。';
    } else if (tw && tw.b20 > 0 && tw.b60 > 0 && tw.pct52 >= 80) {
      if ((fgiVal !== null && fgiVal >= 75) || tw.b60 >= 10 || marginSticky) {
        regimeLabel = '高檔多頭警戒區（偏擁擠）';
        tone = 'warn';
        actionAdvice = '大盤創高但留意人多的地方不要去（EP705）；執行「新高砍弱股」，勿開高槓桿追價（EP703）。';
      } else {
        regimeLabel = '健康多頭創高區';
        tone = 'opp';
        actionAdvice = '順勢持有領漲族群，汰除連月新高都過不去的弱勢股（EP703）。';
      }
    } else if (tw && tw.b60 !== null && tw.b60 < 0) {
      regimeLabel = '季線下中期修正';
      tone = 'warn';
      actionAdvice = '縮小主動部位規模，觀察融資是否有效減肥與領頭羊止跌訊號（EP473、EP474）。';
    }

    const hints = [];
    if (tw) {
      hints.push(`台股位階：52 週區間 <b>${tw.pct52.toFixed(0)}%</b>（${tw.stage}），距週線5MA <b>${fmtBias(tw.b5)}</b>、雙週線10MA <b>${fmtBias(tw.b10)}</b>、月線 <b>${fmtBias(tw.b20)}</b>、季線 <b>${fmtBias(tw.b60)}</b>、年線 <b>${fmtBias(tw.b240)}</b>。`);
    }
    if (marginSignal.hint) hints.push(marginSignal.hint);
    if (instSignal.hint) hints.push(instSignal.hint);
    if (sox && sp) {
      const diff = (sox.b60 ?? 0) - (sp.b60 ?? 0);
      hints.push(`領頭羊強弱：費半季線乖離 <b>${fmtBias(sox.b60)}</b> vs S&P 500 <b>${fmtBias(sp.b60)}</b>（半導體相對${diff >= 0 ? '偏強領漲' : '轉弱須留意'}）。`);
    }
    if (fgiVal !== null) {
      if (fgiVal >= 75) {
        hints.push(`CNN 恐慌貪婪 <b>${fgiVal.toFixed(1)}（極度貪婪）</b>：避開法人與交易室過度擁擠的熱門標的（EP705）。`);
      } else if (fgiVal <= 25) {
        hints.push(`CNN 恐慌貪婪 <b>${fgiVal.toFixed(1)}（極度恐慌）</b>：啟動損害控制與分批試單邏輯（EP169、EP256）。`);
      } else {
        hints.push(`CNN 恐慌貪婪 <b>${fgiVal.toFixed(1)}</b>${vixVal !== null ? ` · VIX <b>${vixVal.toFixed(2)}</b>` : ''}：情緒中性，回歸自由現金流與產業瓶頸選股（EP710）。`);
      }
    }
    if (gState.regimeFlags.marginHigh) hints.push('手動檢核：<b>資金卡正二／質押水位高</b> — 籌碼尚未清洗乾淨，反彈易遇壓（EP473、EP710）。');
    if (zeusLost) hints.push('手動檢核：<b>喪失宙斯法則</b> — 好財報不漲反跌，優先降槓桿扣現金（EP710）。');

    if (!hints.length) {
      hints.push('正在同步即時行情與日 K 歷史資料… 載入後將自動計算四大指數均線位階與股癌風控建議。');
    }

    el.className = `g-banner tone-${tone}`;
    el.innerHTML = `
      <div class="g-banner-head">
        <span class="g-banner-title">股癌大盤位階判定：${esc(regimeLabel)}</span>
        <span class="badge">${gState.data ? gState.data.meta.range : 'EP1–EP711'}</span>
      </div>
      <p class="g-banner-action">操作建議：${esc(actionAdvice)}</p>
      <ul class="g-banner-list">${hints.map((h) => `<li>${h}</li>`).join('')}</ul>
    `;
  }

  function renderRegimeGrid(quotes) {
    const wrap = $('#gooaye-regime-grid');
    if (!wrap) return;
    const targets = [
      { key: 'TWII', label: '台灣加權指數' },
      { key: 'GSPC', label: 'S&P 500' },
      { key: 'IXIC', label: '那斯達克' },
      { key: 'SOX', label: '費城半導體' },
    ];

    wrap.innerHTML = targets.map(({ key, label }) => {
      const m = calcIndexMetrics(quotes[key]);
      if (!m) {
        return `
          <article class="g-reg-card">
            <div class="g-reg-top"><strong>${esc(label)}</strong><span class="badge">載入中</span></div>
            <div class="g-reg-price">—</div>
          </article>
        `;
      }
      return `
        <article class="g-reg-card">
          <div class="g-reg-top">
            <strong>${esc(label)}</strong>
            <span class="g-reg-badge st-${m.stageCls}">${esc(m.stage)}</span>
          </div>
          <div class="g-reg-price num">${m.price.toLocaleString('en-US', { maximumFractionDigits: 1 })}</div>
          <div class="g-reg-bar-wrap">
            <div class="g-reg-bar-head"><span>52週位階</span><span class="num">${m.pct52.toFixed(0)}%</span></div>
            <div class="g-reg-bar"><span style="width:${m.pct52.toFixed(1)}%"></span></div>
          </div>
          <div class="g-reg-mas">
            <div><span>週線5</span><b class="${biasCls(m.b5)}">${fmtBias(m.b5)}</b></div>
            <div><span>雙週10</span><b class="${biasCls(m.b10)}">${fmtBias(m.b10)}</b></div>
            <div><span>月線20</span><b class="${biasCls(m.b20)}">${fmtBias(m.b20)}</b></div>
            <div><span>季線60</span><b class="${biasCls(m.b60)}">${fmtBias(m.b60)}</b></div>
            <div><span>半年120</span><b class="${biasCls(m.b120)}">${fmtBias(m.b120)}</b></div>
            <div><span>年線240</span><b class="${biasCls(m.b240)}">${fmtBias(m.b240)}</b></div>
          </div>
        </article>
      `;
    }).join('');
  }

  function renderRegimeToggles() {
    const wrap = $('#gooaye-regime-toggles');
    if (!wrap) return;
    const { marginHigh, zeusLost } = gState.regimeFlags;
    wrap.innerHTML = `
      <label class="g-toggle-pill ${marginHigh ? 'is-on' : ''}">
        <input type="checkbox" data-rflag="marginHigh" ${marginHigh ? 'checked' : ''} />
        <span>盤面融資未大減 / 資金卡正二（EP473, EP710）</span>
      </label>
      <label class="g-toggle-pill ${zeusLost ? 'is-on' : ''}">
        <input type="checkbox" data-rflag="zeusLost" ${zeusLost ? 'checked' : ''} />
        <span>好財報不漲反跌：喪失宙斯法則（EP710）</span>
      </label>
    `;
  }

  function renderRegimeRules() {
    const wrap = $('#gooaye-regime-rules');
    if (!wrap || !gState.data || !gState.data.regimeRules) return;
    wrap.innerHTML = gState.data.regimeRules.map((r) => `
      <div class="g-rule-item">
        <div class="g-rule-head">
          <strong>${esc(r.title)}</strong>
          <div class="g-ep-chips">${r.eps.map((n) => `<a class="g-ep-chip" href="${epUrl(n)}" target="_blank" rel="noopener noreferrer">EP${n}</a>`).join('')}</div>
        </div>
        <p>${esc(r.desc)}</p>
      </div>
    `).join('');
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
    renderRegimeSection(window.__STOCKDASH_QUOTES__ || {});
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
      const q = e.detail || {};
      renderChipHighlight(q);
      renderChipCards('#grid-twchip', q);
      if (gState.view === 'gooaye') {
        renderRegimeSection(q);
      }
      if (gState.chipSheet) {
        renderChipSheet(q);
      }
    });
    if (window.__STOCKDASH_QUOTES__) {
      renderChipHighlight(window.__STOCKDASH_QUOTES__);
      renderChipCards('#grid-twchip', window.__STOCKDASH_QUOTES__);
    }

    document.addEventListener('click', (e) => {
      const trigger = e.target?.closest?.('[data-chip-sheet]');
      if (!trigger || e.target?.closest?.('a')) return;
      const kind = trigger.dataset?.chipSheet || trigger.getAttribute?.('data-chip-sheet');
      if (kind) openChipSheet(kind);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && gState.chipSheet) {
        closeChipSheet();
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        const trigger = e.target?.closest?.('[data-chip-sheet]');
        if (trigger) {
          const kind = trigger.dataset?.chipSheet || trigger.getAttribute?.('data-chip-sheet');
          if (kind) {
            e.preventDefault();
            openChipSheet(kind);
          }
        }
      }
    });

    const chipBody = $('#chip-sheet-body');
    if (chipBody) {
      chipBody.addEventListener('click', (e) => {
        const unitBtn = e.target?.closest?.('[data-inst-unit]');
        if (unitBtn) {
          const nextUnit = (unitBtn.dataset?.instUnit || unitBtn.getAttribute?.('data-inst-unit')) === 'ntd' ? 'ntd' : 'yi';
          if (gState.instUnit !== nextUnit) {
            gState.instUnit = nextUnit;
            renderChipSheet();
          }
          return;
        }
        const latestBtn = e.target?.closest?.('[data-chip-latest]');
        if (latestBtn) {
          gState.chipDate = null;
          renderChipSheet();
          return;
        }
        const dateEl = e.target?.closest?.('[data-chip-date]');
        if (dateEl) {
          const d = dateEl.dataset?.chipDate || dateEl.getAttribute?.('data-chip-date');
          if (d) {
            gState.chipDate = d;
            renderChipSheet();
            if (dateEl.closest?.('.chip-table-hist')) {
              const sheet = $('#chip-sheet');
              if (sheet?.scrollTo) sheet.scrollTo({ top: 0, behavior: 'smooth' });
              else if (sheet) sheet.scrollTop = 0;
            }
          }
        }
      });
    }

    $('#chip-sheet-close')?.addEventListener('click', closeChipSheet);
    $('#chip-sheet-backdrop')?.addEventListener('click', closeChipSheet);
    (() => {
      const sheet = $('#chip-sheet');
      if (!sheet) return;
      let y0 = null;
      sheet.addEventListener('touchstart', (e) => {
        if (sheet.scrollTop <= 0 && !e.target?.closest?.('.chip-table-wrap,.chip-chart-box')) {
          y0 = e.touches[0].clientY;
        }
      }, { passive: true });
      sheet.addEventListener('touchend', (e) => {
        if (y0 != null && e.changedTouches[0].clientY - y0 > 90) closeChipSheet();
        y0 = null;
      }, { passive: true });
    })();

    const toggleWrap = $('#gooaye-regime-toggles');
    if (toggleWrap) {
      toggleWrap.addEventListener('change', (e) => {
        const cb = e.target;
        if (cb && cb.matches('input[type="checkbox"][data-rflag]')) {
          gState.regimeFlags[cb.dataset.rflag] = cb.checked;
          saveJson(REGIME_KEY, gState.regimeFlags);
          renderRegimeSection(window.__STOCKDASH_QUOTES__ || {});
        }
      });
    }

    const checkWrap = $('#gooaye-checklist');
    if (checkWrap) {
      checkWrap.addEventListener('change', (e) => {
        const cb = e.target;
        if (cb && cb.matches('input[type="checkbox"][data-cid]')) {
          gState.check.checked[cb.dataset.cid] = cb.checked;
          saveJson(CHECK_KEY, gState.check);
          renderChecklist();
        }
      });
    }

    const tickerEl = $('#gooaye-ticker');
    if (tickerEl) {
      tickerEl.addEventListener('input', () => {
        gState.check.ticker = tickerEl.value;
        saveJson(CHECK_KEY, gState.check);
      });
    }

    const resetBtn = $('#gooaye-check-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        gState.check = { ticker: '', checked: {} };
        saveJson(CHECK_KEY, gState.check);
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
