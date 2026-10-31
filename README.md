# dealwatch

監控 Best Buy（open-box / refurbished）、Walmart（最新上架）、Woot（限時特賣）、Newegg、eBay（直購）、Micro Center，
以及 Slickdeals 和 Reddit r/buildapcsales 上網友回報的 deal，範圍是筆電、整機、高階 CPU、顯卡、記憶體，有上新或降價就提醒，並用你自己已登入的瀏覽器一鍵加入購物車、跳到結帳頁。

零 npm 依賴。完整功能使用 Node.js 22 以上；Node.js 20 可執行直接 HTTP 診斷與 `WALMART_VIA=http` 模式，瀏覽器功能需要內建 WebSocket。

## 快速開始

```bash
node dealwatch.mjs scan
```

掃一次 `config.stores` 裡的每一家店並列表（預設全部六個來源）。第一次執行只會建立基準；之後每次執行會在表格下方列出「上新」與「降價」。

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
部署前可以先跑 `npm test` 和 `node dealwatch.mjs doctor`，確認這台機器連得到兩家店、解析得出商品，
見 [部署前診斷](docs/preflight.md)；程式結構與設計取捨見 [設計說明](docs/design.md)。

## 指令

| 指令 | 作用 |
| --- | --- |
| `doctor` | 每站唯讀查詢一頁並解析；`--offline` 只查執行環境，`--json` 輸出報告。詳見部署前診斷 |
| `scan` | 掃一次，列出所有符合條件的商品 |
| `watch` | 持續監控；輸入提醒編號開購物車，`l` 列出目前全部，`q` 離開 |
| `ui` | 持續監控 + 本機網頁介面 |
| `browser` | 打開 dealwatch 專用的瀏覽器視窗（Walmart 人機驗證、登入 Walmart 用） |
| `q <關鍵字>` | 立刻用任意關鍵字查各家店，不套分類過濾（Best Buy 約 1 秒） |
| `cart <編號>` | 把上一次 `scan` / `q` 表格的第 N 筆加入購物車並開結帳頁 |
| `cart bb <sku> [excellent\|good\|fair]` | 直接用 Best Buy SKU；加成色就是 open-box |
| `cart wm <itemId>` | 直接用 Walmart item id |
| `urls` / `ingest <檔案.html>` | Walmart 擋掉腳本時的替代路徑，見下方 |

常用選項：`--store bb,wt`（bb Best Buy、wm Walmart、wt Woot、ne Newegg、eb eBay、mc Micro Center、sd Slickdeals、rd r/buildapcsales，可用逗號列多家）、`--cat laptop,gpu`、`--steals`、`--min-off 15`、`--top 30`、`--json`、
`--auto-cart`（watch 時撿漏自動開購物車）、`--dry`（cart 只印連結）。

## 設定

全部在 [config.mjs](config.mjs)：

- `stores`：要監控哪些來源，預設 `['bb', 'wm', 'wt', 'ne', 'sd', 'rd']`。
- `zip`：填你的郵遞區號。Best Buy 的 open-box 多半只能門市取貨，填了才會以你附近的庫存為準。
- `categories`：每個分類的搜尋關鍵字（`queries.bestbuy` / `walmart` / `woot` / `newegg` / `slickdeals` / `reddit`，各來源分開設）與過濾條件。預設是
  筆電（RTX 4050 以上）、整機（RTX 4060 以上）、CPU（9800X3D 等清單）、顯卡（RTX 5070 Ti 以上）、
  記憶體（DDR5、單條 16GB 以上）。
- `intervalSec`：watch 的輪詢間隔。
- `watchlist`：指定商品，不依賴搜尋排名，每輪直接查價格。Walmart 同時讀取商品頁的庫存欄位；Best Buy 自營的全新 / 整新品會查庫存，open-box 與第三方賣家的庫存見「已知限制」。
  每一項填商品網址（Best Buy、Walmart、Woot 的 `/offers/...`、Newegg 的 `.../p/<編號>`、eBay 的 `/itm/<編號>`、Micro Center 的 `/product/<編號>/...` 都可以），或 `{ store: 'bb', id: 'SKU' }`；
  加 `maxPrice` 的話到那個價一定通知。
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

## 其他推播管道

可以和 LINE 並用，填了哪個就推哪個，一樣用 `node dealwatch.mjs notify-test`（或網頁介面的「測試推播」）測試。

- **Discord**：在自己的伺服器開一個頻道 → 編輯頻道 → 整合 → Webhook → 新 Webhook → 複製網址，
  填到 `.env` 的 `DISCORD_WEBHOOK=`。沒有則數上限，適合想連上新 / 降價都收的人。
- **Telegram**：跟 [@BotFather](https://t.me/BotFather) 說 `/newbot` 拿到 token，填 `TELEGRAM_BOT_TOKEN=`；
  先傳一句話給你的 bot，再開 `https://api.telegram.org/bot<token>/getUpdates`，把 `chat.id` 填到 `TELEGRAM_CHAT_ID=`。
- **ntfy**：裝 ntfy App 訂閱一個別人猜不到的主題名稱，填 `NTFY_TOPIC=`。

這幾個都是單向推播：dealwatch 送提醒給你，不會讀你在聊天室打的字。

## 撿漏標準

符合的品項在表格標 `★`、在 watch / ui 裡推播。每件只通知一次，之後要再便宜 3% 以上才會再通知。
`node dealwatch.mjs scan --steals` 可以只看撿漏，`node dealwatch.mjs market` 可以看每個零件實際採用的參考價。

參考價以 **MSRP** 為準，寫在 [msrp.mjs](msrp.mjs)，可以直接改。現在顯卡和記憶體的市價普遍被炒高，
跟市價比會把「大家都賣這麼貴」誤當成撿漏，所以：

- **市價明顯高於 MSRP 的零件**（目前的顯卡、記憶體）：售價 ≤ MSRP ×（1 + `msrpPremium`）就算，預設溢價 25%。
  這種行情下比 MSRP 貴一點仍然是便宜。例如 5080 是 $999 × 1.25 = $1,249、DDR5 32GB 是 $128。
  個別零件可以在 `steals.override` 直接指定撿漏價，目前 5090 設為 $2,500。
- **市價本來就在 MSRP 附近或更低的零件**（多數 CPU）：要比其他賣家的最低價再便宜 10% 以上，
  而且只有新上架或剛降價的才算——一直都是最低價的那個賣家不算。
- **整機**：售價 ≤ CPU + 顯卡 + 記憶體 + SSD 各自的撿漏價，再加 `buildAllowance`（主機板、電源、機殼、散熱、
  Windows，預設 $600）。只看顯卡在 `desktopMinGpu`（預設 RTX 5070 Ti）以上的機器，
  低階主機的其餘零件沒那麼值錢，用同一個加總會太寬鬆。
- **筆電**：估不出零件價，用 `config.mjs` 裡的 `steals.rules`，命中任一條就算。目前四條：
  ROG Zephyrus G14（Core Ultra 9 386H / 5070 Ti / 32GB）的 open-box 或整新品低於 $2200、
  任何 RTX 5070 Ti 筆電低於 $1450、
  Best Buy 的 5080 / 5090 筆電低於 $2000、ROG Zephyrus 5070 Ti 以上低於 $2000。
  規則可以用標題、cpu、gpu、記憶體、成色（open-box / 整新 / 全新）、店家、價格上限來組合。
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
  每輪載入完、閒置 30 秒後分頁會換成空白頁，免得網站的腳本在兩輪之間一直吃 CPU；遇到人機驗證時則保留頁面等你處理。
- **Woot**：呼叫官網前端用的 GraphQL 端點，依上架時間由新到舊查關鍵字。端點需要的公開金鑰每次從 Woot 首頁讀取，不寫在程式裡。
  Woot 每件商品是限時特賣，多半整新品，賣完就下架。
- **Newegg**：抓搜尋頁內嵌的 JSON，含售價、庫存、賣家、是否 open-box / 整新。
- **eBay**：直接請求一律被擋，只能用同一個 Chrome 另開分頁載入搜尋頁（最新上架、只看直購、限定 eBay 分類與美國境內出貨）。
  價格含運費；只留 `ebay.minFeedbackPct` / `minFeedbackCount` 以上的賣家（預設 98%、20 筆評價），預設不看二手。
  eBay 依連線的國家顯示當地幣別，頁面上沒有原始美金價；不是美金時用每日匯率換算（[Rates By Exchange Rate API](https://www.exchangerate-api.com)），通知和表格的價格是約略值，以商品頁為準。
  連續載入太快會回錯誤頁，所以每次載入至少隔 10 秒、10 分鐘一輪。
  eBay 的整機多半是賣家自己組的，零件估值不準，預設不算撿漏（只列在表格裡）；要算就在 `ebay.stealCats` 加回 `'desktop'`。
- **Micro Center**：同樣只能用瀏覽器載入搜尋頁，價格與庫存以 `microcenter.storeId` 那家門市為準（預設 165 Indianapolis）。
- **Slickdeals、r/buildapcsales**：讀網友回報 deal 的 RSS。每篇貼文當成一件商品，價格、規格、店名從標題解析，
  再套同一套撿漏標準；只看 `feeds.maxAgeHours`（預設 48 小時）內的貼文。表格的「賣家」欄是實際賣的那家店，
  「開商品頁」會開商品網址（Slickdeals 是討論串）。Reddit 不登入時限流很嚴，一輪只發一個請求。
  Slickdeals 的搜尋 RSS 被 Cloudflare 擋（例如從 NAS 連線）時，改讀它發布在 FeedBurner 的官方 feed
  （首頁精選、Hot Deals 討論區各最新 25 則），自己比對標題，6 小時後才再試一次搜尋。
- **購物車**：Best Buy 用 `api.bestbuy.com/click/-/<sku>/cart`（open-box 加 `seller_id=BBY_OB&listing_id=<成色>`），
  加完再開結帳頁。Walmart 用 `affil.walmart.com/cart/buynow?offers=<offerId>`，鎖定你在表格看到的那個賣家，
  加完直接往結帳走（沒登入時會停在購物車頁）。
  連結在你的預設瀏覽器開啟，所以會進到你已登入的帳號。**腳本只開到結帳頁，不會送出訂單。**
- 狀態存在 `data/state.json`，提醒紀錄在 `data/alerts.jsonl`。刪掉 `data/` 就會重新建立基準。

## 已知限制

- 每家店用的都是非官方端點，改版時可能失效。
- Woot、eBay、Micro Center 和社群回報的 deal 沒有加入購物車連結，按鈕是「開商品頁」。Woot 結帳要用 Amazon 帳號登入。
- 社群回報的 deal 是從標題解析的，標題沒寫清楚規格或價格就判斷不了；貼文也可能已經結束，下單前看一下討論串。
- Temu 試過但放棄了：搜尋要登入，而且自動搜尋兩次就跳人機驗證，上面也幾乎沒有高階顯卡和 CPU。
- **Walmart 請求太密集會跳人機驗證**，連瀏覽器視窗裡也可能出現。腳本不會代你通過驗證：
  它會把那個視窗帶到最前面，等你親手按完（按住按鈕那種），下一輪就恢復；網頁介面上可以按「立刻重掃」。
  也可以先跑 `node dealwatch.mjs browser` 把視窗開好、順便登入帳號。
  最後的備案是 `node dealwatch.mjs urls` 列出網址 → 自己在瀏覽器另存成 HTML → `node dealwatch.mjs ingest 檔案.html`。
- Best Buy 的庫存狀態分三種情況：
  - 自營的全新 / 整新品：腳本會查庫存，售完的不列出。
  - 第三方賣家（Marketplace）的商品：搜尋資料不帶庫存，所以清單裡可能有已售完的。
    只有在它被判成撿漏、要通知之前，腳本才會開商品頁確認，售完的不通知並標「已售完」。
    另外這類商品沒有加入購物車連結，按鈕是「開商品頁」，要自己到頁面上按。
  - open-box：多半限門市取貨，無法事先確認，要到購物車頁才看得到取貨門市。
- Walmart 有大量第三方賣家，表格的 `賣家` 欄請自己把關；可用 `config.walmart.sellers` 只看信任的賣家。
- 規格欄是從標題解析的，標題沒寫的欄位會留空。

## 24 小時執行

- 家裡的 Synology NAS（Docker，含遠端瀏覽器畫面）：[synology/README.md](synology/README.md)
- Grok Bot / Muse 這類雲端 agent 平台：[cloud/README.md](cloud/README.md)
