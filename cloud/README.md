# 在 Grok Bot / Muse 上 24 小時執行

這份腳本沒有任何 npm 依賴，任何有 Node.js 20+ 的 Linux 機器都能跑，
所以放到 Grok Bot、Muse 這類有常駐雲端電腦的 agent 平台只需要三步：把資料夾交給它、設好推播、叫它啟動。

雲端沒有你的瀏覽器，所以用 `--headless`：不開瀏覽器、不讀鍵盤，提醒改用推播送到你手機，
訊息裡附「加入購物車」連結，點下去就在你自己的瀏覽器加入購物車。

> 我沒有實機測過這兩個平台，下面的提示詞是照「有終端機、有檔案系統、能排程」的通用能力寫的，
> 介面上的名稱請以平台實際為準。

## 1. 準備推播

擇一即可，設成環境變數（或直接填進 `config.mjs` 的 `notify`）：

| 管道 | 環境變數 |
| --- | --- |
| LINE（設定步驟見主 README「LINE 推播」；免費每月 200 則） | `LINE_CHANNEL_ID` + `LINE_CHANNEL_SECRET`，或 `LINE_TOKEN`（+ 選填 `LINE_TO`） |
| ntfy（最簡單，手機裝 ntfy app 訂閱同一個 topic） | `NTFY_TOPIC` |
| Discord | `DISCORD_WEBHOOK` |
| Telegram | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` |

ntfy 的 topic 等於密碼，請取一個別人猜不到的名字。

## 2. 貼給 bot 的提示詞

把整個專案資料夾（不含 `data/`）上傳或放到它讀得到的 git repo，然後貼上：

```text
我上傳了一個叫 dealwatch 的 Node.js 專案。請幫我：

1. 確認機器上有 Node.js 20 以上（沒有就安裝）。專案沒有 npm 依賴，不需要 npm install。
2. 在專案根目錄建立 .env，內容是 LINE_CHANNEL_ID=<我的 Channel ID> 和 LINE_CHANNEL_SECRET=<我的 Channel secret> 兩行。
   設好後執行 node dealwatch.mjs notify-test，確認我的 LINE 有收到測試訊息。
3. 在專案資料夾執行：nohup bash cloud/start.sh >/dev/null 2>&1 &
   這會常駐執行 `node dealwatch.mjs watch --headless`，當掉會自動重啟，輸出在 data/watch.log。
4. 建立一個每 30 分鐘執行一次的排程，內容是：bash cloud/healthcheck.sh
   如果它輸出 RESTARTED 或 BLOCKED，把那一行和 data/watch.log 最後 20 行回報給我；輸出 OK 就不用通知我。
5. 完成後把 data/watch.log 的前 10 行貼給我確認。

注意：不要修改 src/ 裡的程式；要調整監控條件只改 config.mjs。
如果 log 出現「人機驗證」，代表 Walmart 擋了這台機器的 IP，不要嘗試繞過，照下面第 3 節的做法處理。
```

如果平台不允許常駐背景程序，改用排程模式：每 2～5 分鐘執行一次

```bash
node dealwatch.mjs watch --once --headless
```

狀態存在 `data/state.json`，所以每次執行都會接續上一次的結果。

## 3. Walmart 被擋時

資料中心的 IP 很容易被 Walmart 要求人機驗證，Best Buy 則通常不受影響。
如果雲端機器有桌面環境和 Chrome / Chromium，腳本被擋時會像本機一樣自動改用瀏覽器視窗載入；
但出現人機驗證時仍然需要有人去按，無人值守的機器上等於卡住。所以比較實際的是這兩個做法：

- **Walmart 留在家裡跑**：雲端只跑 Best Buy（`cloud/start.sh` 裡改成 `watch --headless --store bb`），
  家裡的電腦跑 `node dealwatch.mjs watch --store wm`。
- **讓 bot 用它自己的瀏覽器開頁面**，再交給腳本解析。貼給 bot：

```text
每 10 分鐘做一次：
1. 執行 node dealwatch.mjs urls 取得網址清單。
2. 用你的瀏覽器逐一開啟這些網址，每頁等載入完成後把完整 HTML 存成 data/wm/<序號>.html。
   如果頁面要求人機驗證就跳過那一頁，不要嘗試通過驗證。
3. 執行 node dealwatch.mjs ingest data/wm/*.html
   有上新或降價時腳本會自己推播，你不需要另外通知我。
```

## 檔案

- `start.sh`：常駐執行並自動重啟。
- `healthcheck.sh`：檢查程序是否還活著、最近是否被擋。
