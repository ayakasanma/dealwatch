# 設計說明

目標是讓使用者在部署前就能分清楚是環境、商店回應還是程式解析的問題，並保留原本的價格監控。診斷成功表示當次 HTTP 抓取和資料解析成立；容器及長期服務的可靠度要在部署後確認。

## 程式結構

`dealwatch.mjs` 先分流指令。`doctor` 只載入 `src/doctor.mjs` 與兩家店的 HTTP／解析模組；原有 CLI 和監控入口移到 `src/monitor.mjs`，繼續由同一個 `node dealwatch.mjs` 指令啟動。路徑仍以程式根目錄為準，原有 `data/` 位置保持相同。

診斷不匯入使用者設定、通知或 State，因此 `.env`、推播憑證與既有監控基準不會影響結果。它也不使用 `scan` 指令，因為 `scan` 會建立狀態。SSH 輔助腳本只將 `doctor`、`http`、`bestbuy`、`walmart` 四個模組放進 NAS 記憶體。

共用 HTTP 層保留上游的商店標頭，新增結構化錯誤碼。商店模組先檢查 HTTP 狀態，再辨認驗證頁與解析結構。HTTP 200 的 HTML 驗證頁、缺少 GraphQL／`__NEXT_DATA__` 結構，都會回報失敗；有效的空商品清單才是 `empty` 警告。診斷每站一頁且不重試；監控原有的限流與退避仍保留。

## 瀏覽器

`Browser.ready()` 在建立設定檔或啟動程序前確認內建 WebSocket。Node.js 20 缺少這個能力時，回報明確的版本需求。CDP 指令和連線各有逾時，連線結束會拒絕未完成請求，避免監控永遠等待。Walmart 切換設定時會清除上一次被擋的記憶，確保 `http` 模式不意外沿用瀏覽器。

要用瀏覽器的店（Walmart、Newegg、eBay、Micro Center）各有一個分頁，同一個分頁上的載入排隊依序做；驗證頁和 `hold` 跟著分頁走，別家的載入或成功不會影響等人處理的頁面。排隊清空後閒置 `idleMs`（預設 30 秒）就把分頁換成 `about:blank`：Walmart 頁面上的人機驗證指紋腳本會一直執行，留著不管時 Chromium 在兩輪之間仍持續吃 CPU、記憶體越長越大，設定檔裡的 Local Storage 和快取也不停寫入。遇到人機驗證時設 `hold`，保留頁面讓使用者處理，這段期間 Best Buy 第三方賣家的庫存確認也不借用分頁；之後經瀏覽器成功載入一頁就解除。接到別處的瀏覽器（`cdpUrl`）時，`scan` 這類一次性指令結束前也把分頁換回空白頁；`browser` 指令設 `hold`，留著 Walmart 頁面給使用者登入或驗證。容器啟動時也直接開空白頁。

瀏覽器仍可能遇到驗證。程式保留原有手動驗證提示與退避；使用者可從 UI 暫停店家、完成驗證後恢復。不做自動通過驗證或自動下單。

## NAS 容器設定

完整 compose 保留 Node.js 22 與 Chromium 兩個容器，共用網路空間，以 loopback CDP 通訊。瀏覽器固定 hostname，並以 CDP 健康檢查控制應用啟動順序，避免持久化 profile 的舊容器主機鎖和冷啟動競爭。程式目錄改成唯讀掛載，`data/` 保留可寫；監控歷史在 `data/`，瀏覽器設定檔預設在 `data/browser/`，可用 `BROWSER_CONFIG_DIR` 指到 SSD。精簡版使用相同的程式與資料掛載規則。

共用網路空間的代價是開機順序。Synology Container Manager 關機時逐一停止容器、開機時依建立時間由新到舊逐一啟動且不重試；應用容器一定比瀏覽器晚建立，所以開機時總是先啟動、因瀏覽器的網路空間還不存在而失敗。改成兩個獨立網路需要讓 Chromium 的除錯埠對外（有頭模式的 Chromium 只聽 loopback，且會拒絕非 IP 的 Host 標頭），代價比較大，所以保留共用網路，改由 DSM 開機任務執行 `synology/start-after-boot.sh`，等 docker 就緒後以 `docker compose up -d` 依相依順序補上。

兩份 compose 都要求非空 `UI_PASSWORD`，預設綁定 `127.0.0.1`。部署時由使用者將 `HOST_BIND_IP` 改成 NAS 的區網或 VPN IPv4。應用本身也拒絕無密碼的非 loopback 監聽，因此繞過 compose 直接執行仍有相同檢查。瀏覽器除錯埠保持不對外映射。

Chromium 的 `seccomp:unconfined` 沿用上游，代表放寬該容器的系統呼叫限制；只用於這個獨立瀏覽器容器。`CHROMIUM_IMAGE` 可指定固定 tag／digest，更新時先驗證再替換。

## 資料與判斷的限制

Best Buy 自營的全新／整新品會查配送與取貨端點，確定售完的不列出，查到結果後標示庫存已知（`stockKnown`）；open-box 與第三方賣家查不到，UI 標示「庫存待確認」，第三方賣家只在通知撿漏前開商品頁確認。指定 SKU 查詢沿用 `config.zip`。取貨門市、配送和實際可購買狀態，以商品頁及購物車為準。Open-box 商品網址會以 URL API 更新成色參數，避免來源已含 `/openbox` 時再附加重複路徑。MSRP 和撿漏規則仍需由使用者更新。

`/healthz` 只證明網頁程序存活，不代表商店查詢成功。`lastSuccess` 只在一整輪無錯誤時更新；保留舊商品數的失敗輪也會顯示錯誤。部署驗收應核對這個時間與執行紀錄的連續成功摘要。診斷報告不包含憑證；HTTP Basic 密碼只在受信任的私人網路或經加密的入口使用。

來源（查詢日期 2026-10-08）：[Chromium 容器說明](https://docs.linuxserver.io/images/docker-chromium/)、[LinuxServer NAS 疑難排解](https://docs.linuxserver.io/selkies/user-guide/troubleshooting/)。
