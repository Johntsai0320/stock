# 台美股看盤儀表板

純前端（零後端伺服器）的手機／電腦雙介面看盤頁面，部署於 GitHub Pages：
**https://johntsai0320.github.io/stock/**

## 追蹤標的
| 分類 | 標的 |
|---|---|
| 台股現貨 | 加權指數 ^TWII、台積電 2330.TW、元大台灣50 0050.TW |
| 台灣期貨 | 台指期近月（日盤）、台指期近月（夜盤） |
| 美股指數 | 道瓊、S&P 500、那斯達克、費城半導體 |
| 美股 | 台積電 ADR (TSM)、VT、QQQM |
| 匯率 | USD/TWD（連動 ADR 折溢價） |

## 數據架構
```
GitHub Actions（每 5 分鐘）──► Yahoo Finance / 證交所 MIS / 期交所 MIS ──► site/data.json ──► GitHub Pages
瀏覽器 ──► data.json（同源，必定可用）
       └─► 公開 CORS 代理 ──► Yahoo spark API / 期交所 MIS（更即時，失敗自動退回快照）
```
- 昨收／昨結算／匯率全部取自 API；漲跌點數、百分比與正負號一律由 `現價 − 基準價` 重新計算（四捨五入後再判斷正負，不會出現 `-0.00` 或錯色）。
- 日 K 最後一根自動以最新報價校正，MA20 / MA60 / RSI(14) 皆含當日價格。
- localStorage 快取有版本號與時效，版本不符、過舊或缺基準價時自動淨化。
- ADR 折溢價 = TSM × USD/TWD ÷ 5 ÷ 2330 現價 − 1（1 ADR = 5 股）。

## 檔案
- `site/` 靜態網頁（index.html / styles.css / app.js）
- `scripts/fetch-data.mjs` 抓取真實行情並輸出 `site/data.json`
- `.github/workflows/deploy.yml` 排程抓資料並部署 Pages

## 本機預覽
```bash
node scripts/fetch-data.mjs
npx serve site
```

> 報價可能延遲，僅供參考，不構成投資建議。
