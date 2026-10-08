# dealwatch

監控 Best Buy（open-box / refurbished）與 Walmart（最新上架）的筆電、整機、高階 CPU、顯卡、記憶體，
有上新或降價就提醒，並用你自己已登入的瀏覽器一鍵加入購物車、跳到結帳頁。

零依賴，只需要 Node.js 20 以上。

## 快速開始

```bash
node dealwatch.mjs scan
```

掃一次兩家店並列表。第一次執行只會建立基準；之後每次執行會在表格下方列出「上新」與「降價」。

```bash
node dealwatch.mjs watch
```

持續監控。出現提醒時會響鈴並印出編號，直接在終端機輸入編號 + Enter 就會加入購物車並開結帳頁。
Windows 也可以直接雙擊 `watch.bat`。

```bash
node dealwatch.mjs ui
```

跟 `watch` 一樣持續監控，另外開一個本機網頁（<http://localhost:8787>）：可以依店家 / 分類 / 只看撿漏 / 折扣篩選、
點欄位排序、搜尋、看最近提醒與執行紀錄、暫停 / 恢復某一家店、送測試推播。每一列的「加入購物車」
會在你看這個頁面的瀏覽器開新分頁，所以用的是那個瀏覽器已登入的帳號。Windows 可以直接雙擊 `ui.bat`。
`watch` 和 `ui` 擇一執行即可，不要同時開。

要放到 Synology NAS 上 24 小時跑、從別台電腦看，見 [synology/README.md](synology/README.md)。

## 指令

| 指令 | 作用 |
| --- | --- |
| `scan` | 掃一次，列出所有符合條件的商品 |
| `watch` | 持續監控；輸入提醒編號開購物車，`l` 列出目前全部，`q` 離開 |
| `ui` | 持續監控 + 本機網頁介面 |
| `browser` | 打開 Walmart 專用的瀏覽器視窗（通過人機驗證或登入用） |
| `q <關鍵字>` | 立刻用任意關鍵字查兩家店，不套分類過濾（Best Buy 約 1 秒） |
| `cart <編號>` | 把上一次 `scan` / `q` 表格的第 N 筆加入購物車並開結帳頁 |
| `cart bb <sku> [excellent\|good\|fair]` | 直接用 Best Buy SKU；加成色就是 open-box |
| `cart wm <itemId>` | 直接用 Walmart item id |
| `urls` / `ingest <檔案.html>` | Walmart 擋掉腳本時的替代路徑，見下方 |

常用選項：`--store bb|wm`、`--cat laptop,gpu`、`--steals`、`--min-off 15`、`--top 30`、`--json`、
`--auto-cart`（watch 時撿漏自動開購物車）、`--dry`（cart 只印連結）。

## 設定

全部在 [config.mjs](config.mjs)：

- `zip`：填你的郵遞區號。Best Buy 的 open-box 多半只能門市取貨，填了才會以你附近的庫存為準。
- `categories`：每個分類的搜尋關鍵字與過濾條件。預設是
  筆電（RTX 4050 以上）、整機（RTX 4060 以上）、CPU（9800X3D 等清單）、顯卡（RTX 5070 Ti 以上）、
  記憶體（DDR5、單條 16GB 以上）。
- `intervalSec`：watch 的輪詢間隔。
- `steals`：撿漏標準，決定哪些會標 ★ 和推播。參考價（MSRP）另外放在 [msrp.mjs](msrp.mjs)。
- `cart.auto`：`--auto-cart` 時哪些撿漏要自動開購物車，預設全部。
- `notify`：LINE / Discord / Telegram / ntfy 推播，本機和雲端都會用到。

## LINE 推播

LINE Notify 已在 2025/3/31 停止服務，現在要用 LINE 官方帳號的 Messaging API：

1. 到 [LINE Official Account Manager](https://manager.line.biz/) 建一個官方帳號（免費），用手機 LINE 加它好友。
2. 在該帳號的「設定 → Messaging API」啟用 Messaging API，然後到
   [LINE Developers Console](https://developers.line.biz/console/) 找到同一個 channel。
3. 把「Basic settings」分頁的 Channel ID 和 Channel secret 寫進專案根目錄的 `.env`：
   `LINE_CHANNEL_ID=...`、`LINE_CHANNEL_SECRET=...`。腳本會自動換 15 分鐘有效的短期 token。
   （也可以改用「Messaging API」分頁最下方 **Issue** 出來的長期 token，設成 `LINE_TOKEN`。）
4. 只推給你自己：把「Basic settings」分頁最下方的 **Your user ID**（`U` 開頭 33 碼）填到 `.env` 的 `LINE_TO=`。
   留空則是廣播給所有好友。LINE 沒有「禁止別人加好友」的開關，但填了 `LINE_TO` 之後，
   別人就算加了這個帳號也收不到任何推播。
5. 測試：

```bash
node dealwatch.mjs notify-test
```

免費方案每月只能推 200 則，所以腳本把同一輪的提醒併成一則，用 `lineDailyMax`（預設一天 6 則）控制用量，
而且預設只推「撿漏」（見下一節）。上新 / 降價在終端機和 `data/alerts.jsonl` 仍然都有；
想全部都推就把 `notify.onlySteals` 改成 `false`。

## 撿漏標準

符合的品項在表格標 `★`、在 watch / ui 裡推播。每件只通知一次，之後要再便宜 3% 以上才會再通知。
`node dealwatch.mjs scan --steals` 可以只看撿漏，`node dealwatch.mjs market` 可以看每個零件實際採用的參考價。

參考價以 **MSRP** 為準，寫在 [msrp.mjs](msrp.mjs)，可以直接改。現在顯卡和記憶體的市價普遍被炒高，
跟市價比會把「大家都賣這麼貴」誤當成撿漏，所以：

- **市價明顯高於 MSRP 的零件**（目前的顯卡、記憶體）：售價回到 MSRP 以下才算。
  例如 5090 要 ≤ $1,999、5080 要 ≤ $999、DDR5 以每 GB $3.2 換算（128GB ≈ $410）。
- **市價本來就在 MSRP 附近或更低的零件**（多數 CPU）：要比其他賣家的最低價再便宜 10% 以上，
  而且只有新上架或剛降價的才算——一直都是最低價的那個賣家不算。
- **整機**：售價 ≤ CPU + 顯卡 + 記憶體 + SSD 的參考價，再加 `buildAllowance`（主機板、電源、機殼、散熱、
  Windows，預設 $700）。只看顯卡在 `desktopMinGpu`（預設 RTX 5070 Ti）以上的機器，
  低階主機的其餘零件沒那麼值錢，用同一個加總會太寬鬆。
- **筆電**：估不出零件價，用 `config.mjs` 裡的 `steals.rules`。預設兩條：Best Buy 的 5080 / 5090 筆電低於 $2000、
  ROG Zephyrus 5070 Ti 以上低於 $2000。
- 售價低於估值一半（`tooGood`）視為假貨或標題解析錯誤，不算撿漏。

記憶體和 SSD 沒有官方 MSRP，`msrp.mjs` 裡用的是 2025 年缺貨前的常見零售價。
MSRP 表裡沒有的型號會退回用市價：Best Buy 全新品目錄的最低價（每 6 小時重抓，存在 `data/market.json`）
與兩家店目前掃到的其他賣家取最低。表格的 `估值` 欄就是加總後的參考價。

## 表格怎麼看

- `狀態`：`OB Fair/Good/Excellent` 是 open-box 成色，`Refurb` 是整新品，`Restored` 是 Walmart 的整新品。
- `price`：`904.99->902.99` 是歷次看到的價格；open-box 後面括號是其他成色的價格（`G`=Good、`E`=Excellent）。
- `折`：相對 `原價` 欄的折扣。open-box 的原價是同一台全新品的現價。

## 運作方式

- **Best Buy**：呼叫官網前端使用的 GraphQL 端點，一個請求回 100 筆商品與每個成色的價格，
  預設 39 個查詢約 3 秒跑完。
- **Walmart**：抓搜尋頁（`sort=new` 最新上架）內嵌的 JSON。先直接請求；被擋就自動改開一個獨立的 Chrome 視窗
  （設定檔在 `data/chrome-profile`，跟你平常的 Chrome 分開）一頁一頁載入，11 個查詢約 35 秒。
  被擋過會記 6 小時，這段時間直接走瀏覽器。那個視窗可以縮小，但監控期間不要關。
- **購物車**：Best Buy 用 `api.bestbuy.com/click/-/<sku>/cart`（open-box 加 `seller_id=BBY_OB&listing_id=<成色>`），
  加完再開結帳頁。Walmart 用 `affil.walmart.com/cart/buynow?offers=<offerId>`，鎖定你在表格看到的那個賣家，
  加完直接往結帳走（沒登入時會停在購物車頁）。
  連結在你的預設瀏覽器開啟，所以會進到你已登入的帳號。**腳本只開到結帳頁，不會送出訂單。**
- 狀態存在 `data/state.json`，提醒紀錄在 `data/alerts.jsonl`。刪掉 `data/` 就會重新建立基準。

## 已知限制

- 兩家店用的都是非官方端點，改版時可能失效。
- **Walmart 請求太密集會跳人機驗證**，連瀏覽器視窗裡也可能出現。腳本不會代你通過驗證：
  它會把那個視窗帶到最前面，等你親手按完（按住按鈕那種），下一輪就恢復；網頁介面上可以按「立刻重掃」。
  也可以先跑 `node dealwatch.mjs browser` 把視窗開好、順便登入帳號。
  最後的備案是 `node dealwatch.mjs urls` 列出網址 → 自己在瀏覽器另存成 HTML → `node dealwatch.mjs ingest 檔案.html`。
- Best Buy 的 open-box 無法在加入購物車前確認是否可宅配，要到購物車頁才看得到取貨門市。
- Walmart 有大量第三方賣家，表格的 `賣家` 欄請自己把關；可用 `config.walmart.sellers` 只看信任的賣家。
- 規格欄是從標題解析的，標題沒寫的欄位會留空。

## 24 小時執行

- 家裡的 Synology NAS（Docker，含遠端瀏覽器畫面）：[synology/README.md](synology/README.md)
- Grok Bot / Muse 這類雲端 agent 平台：[cloud/README.md](cloud/README.md)
