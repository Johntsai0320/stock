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
    return `https://whatmkreallysaid.com/episode.html?file=EP${n}`;
  }

  // ---------------- 大盤位階技術計算 ----------------
  function calcIndexMetrics(q) {
    if (!q || !Array.isArray(q.daily) || q.daily.length < 20) return null;
    const closes = q.daily.map((b) => Number(b[4])).filter((v) => Number.isFinite(v));
    if (!closes.length) return null;

    const price = typeof q.price === 'number' && Number.isFinite(q.price) ? q.price : closes[closes.length - 1];
    closes[closes.length - 1] = price;

    const avg = (n) => {
      if (closes.length < n) return null;
      let sum = 0;
      for (let i = closes.length - n; i < closes.length; i++) sum += closes[i];
      return sum / n;
    };

    const ma20 = avg(20);
    const ma60 = avg(60);
    const ma240 = avg(240);

    const win52 = q.daily.slice(-252);
    let hi52 = price;
    let lo52 = price;
    for (const b of win52) {
      const h = Number(b[2]);
      const l = Number(b[3]);
      if (Number.isFinite(h) && h > hi52) hi52 = h;
      if (Number.isFinite(l) && l < lo52) lo52 = l;
    }
    const pct52 = hi52 > lo52 ? Math.max(0, Math.min(100, ((price - lo52) / (hi52 - lo52)) * 100)) : 50;

    const bias = (ma) => (ma ? ((price - ma) / ma) * 100 : null);
    const b20 = bias(ma20);
    const b60 = bias(ma60);
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

    return { price, pct52, hi52, lo52, ma20, ma60, ma240, b20, b60, b240, stage, stageCls };
  }

  function fmtBias(v) {
    if (v === null || !Number.isFinite(v)) return '—';
    return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
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

  function fmtDateTW(d) {
    if (!d || d.length !== 8) return '';
    return `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6, 8)}`;
  }

  function analyzeChips(quotes, tw) {
    const margin = quotes.MARGIN;
    const inst = quotes.INST;
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

    return { marginSignal, instSignal };
  }

  function renderChipCards(selector, quotes) {
    const wrap = $(selector);
    if (!wrap) return;
    const margin = quotes.MARGIN;
    const inst = quotes.INST;
    const tw = calcIndexMetrics(quotes.TWII);
    const { marginSignal, instSignal } = analyzeChips(quotes, tw);

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
        <article class="g-chip-card">
          <div class="g-reg-top">
            <strong>外資買賣超 <small class="muted">${esc(fmtDateTW(inst.date))}</small></strong>
            <span class="g-reg-badge st-${instSignal.cls}">${esc(instSignal.label)}</span>
          </div>
          <div class="g-chip-main">
            <span class="g-reg-price num ${fCls}">${fmtYi(inst.foreignYi)}</span>
            <span class="g-chip-chg num">三大合計 ${fmtYi(inst.totalYi)}</span>
          </div>
          <div class="g-chip-sub">投信 ${fmtYi(inst.trustYi)} · 自營 ${fmtYi(inst.dealerYi)} · ${esc(inst.source || '證交所')}${inst.stale ? '（盤中沿用前日）' : ''}</div>
        </article>
      `;
    })() : `
      <article class="g-chip-card">
        <div class="g-reg-top"><strong>外資買賣超</strong><span class="badge">待盤後更新</span></div>
        <div class="g-reg-price">—</div>
      </article>
    `;

    wrap.innerHTML = mHtml + iHtml;
  }

  function renderChipHighlight(quotes) {
    const mValEl = $('#hl-margin-value');
    const mDetEl = $('#hl-margin-detail');
    const iValEl = $('#hl-inst-value');
    const iDetEl = $('#hl-inst-detail');
    const margin = quotes.MARGIN;
    const inst = quotes.INST;

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
        iDetEl.textContent = `三大合計 ${fmtYi(inst.totalYi)} · 投信 ${fmtYi(inst.trustYi)}`;
      } else {
        iValEl.textContent = '—';
        iValEl.className = 'hl-value';
        iDetEl.textContent = '待盤後公布';
      }
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
      hints.push(`台股位階：52 週區間 <b>${tw.pct52.toFixed(0)}%</b>（${tw.stage}），距月線 <b>${fmtBias(tw.b20)}</b>、季線 <b>${fmtBias(tw.b60)}</b>、年線 <b>${fmtBias(tw.b240)}</b>。`);
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
            <div><span>MA20</span><b class="${m.b20 >= 0 ? 'up' : 'down'}">${fmtBias(m.b20)}</b></div>
            <div><span>季線60</span><b class="${m.b60 >= 0 ? 'up' : 'down'}">${fmtBias(m.b60)}</b></div>
            <div><span>年線240</span><b class="${m.b240 >= 0 ? 'up' : 'down'}">${fmtBias(m.b240)}</b></div>
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
    });
    if (window.__STOCKDASH_QUOTES__) {
      renderChipHighlight(window.__STOCKDASH_QUOTES__);
      renderChipCards('#grid-twchip', window.__STOCKDASH_QUOTES__);
    }

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
