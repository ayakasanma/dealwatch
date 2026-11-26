# 在 Synology DSM 7 上執行

用 Docker 跑兩個容器：

| 容器 | 映像檔 | 作用 |
| --- | --- | --- |
| `dealwatch` | `node:22-alpine` | 監控程式本體 + 網頁介面。程式沒有 npm 依賴，直接把這個資料夾唯讀掛進去跑，不需要 build |
| `dealwatch-browser` | `lscr.io/linuxserver/chromium` | 共用 Chromium（Walmart、Newegg 備援、eBay、Micro Center 與 Best Buy 3P 驗庫存）。有畫面，可以從別台電腦用瀏覽器連進來操作 |

`dealwatch` 透過容器內部的除錯埠遙控那個 Chromium，這個埠不對外。對外只有兩個埠：

- `8787`：dealwatch 網頁介面（看結果、篩選、加入購物車、暫停 / 重掃、看執行紀錄）
- `3001`：遠端瀏覽器畫面（Walmart 跳人機驗證或你想登入帳號時用）

已在 x86-64 的 Synology（DSM 7.3、Container Manager）上實際跑過。部署前可以先照
[部署前診斷](../docs/preflight.md) 在 NAS 上確認連得到兩家店、解析得出商品。

## 需求

- DSM 7.2 以上用 **Container Manager**；DSM 7.0 / 7.1 用 **Docker** 套件（要走 SSH，見下方）。
- x86-64 或 ARM64 的機種。Chromium 容器閒置約吃 0.5–1 GB 記憶體，總記憶體 4 GB 以上比較穩。
  記憶體不夠就用精簡版（最下面）。

## 1. 把檔案放上 NAS

用 File Station 在 `docker` 共用資料夾底下建一個 `dealwatch` 資料夾，把整個專案傳上去
（不需要 `data/`、`.git/`）。完成後路徑是 `/volume1/docker/dealwatch/docker-compose.yml`。

再建好 `data/browser/` 資料夾。Synology 在掛載來源資料夾不存在時會拒絕啟動容器。
程式目錄在容器裡是唯讀的，狀態和瀏覽器設定檔都寫在 `data/`。

## 2. 建立 .env

把 `.env.example` 複製成 `.env`（File Station 裡看不到點開頭的檔案時，到「設定」開啟顯示隱藏檔，
或直接在電腦上改好再上傳），填入：

- `UI_PASSWORD`：**一定要設**，沒設 compose 會拒絕啟動。網頁介面和遠端瀏覽器畫面都用這個密碼。
  密碼裡有 `$` 或 `#` 的話，用單引號包住整個值
- `HOST_BIND_IP`：預設 `127.0.0.1` 只有 NAS 自己連得到。改成 NAS 的區網 IP，或 VPN（ZeroTier、Tailscale）給 NAS 的 IP
- `PUID` / `PGID`：SSH 執行 `id 你的帳號` 查。第一個管理員通常是 `1026` / `100`
- `TZ`：你的時區（IANA 名稱，例如 `America/New_York`），執行紀錄的時間以它為準
- 推播：`LINE_CHANNEL_ID` 等，見主 README 的「LINE 推播」與「其他推播管道」。可以等取價正常後再填
- 不想改 `config.mjs` 的話，取貨 ZIP 和輪詢間隔也可以在這裡用 `ZIP_CODE`、`BESTBUY_INTERVAL_SEC`、`WALMART_INTERVAL_SEC` 蓋過。
  NAS 上建議放慢一點，例如 Best Buy 180 秒、Walmart 600 秒

想在 File Station 裡直接改設定、又不想開顯示隱藏檔，可以把設定放在 `settings.env`，再用 SSH 建一個符號連結：
`ln -s settings.env .env`。之後只改 `settings.env`。

## 3. 啟動

**DSM 7.2+（Container Manager）**

1. Container Manager → 專案 → 新增
2. 專案名稱 `dealwatch`，路徑選 `/docker/dealwatch`，來源選「使用現有的 docker-compose.yml」
3. 下一步到底，建置並啟動。第一次要下載映像檔，Chromium 那個比較大

**DSM 7.0 / 7.1（Docker 套件）**

```bash
cd /volume1/docker/dealwatch && sudo docker-compose up -d
```

`dealwatch` 會等瀏覽器的除錯埠通過健康檢查才啟動，冷啟動時網頁介面可能要多等幾十秒。
SSH 裡找不到 `docker-compose` 時，完整路徑是 `/var/packages/ContainerManager/target/usr/bin/docker-compose`，
或用 `/usr/local/bin/docker compose`。只想檢查設定、不啟動的話用 `docker compose config --quiet`。

## 4. 開機後自動補啟動

兩個容器都設了 `restart: unless-stopped`，但 **NAS 整台重開機後 `dealwatch` 不會自己起來**：
關機時 Container Manager 會逐一停止容器，開機時再依「建立時間由新到舊」逐一啟動，失敗不重試。
`dealwatch` 共用瀏覽器容器的網路，又一定比它晚建立，所以總是先被啟動、因為瀏覽器還沒起來而失敗
（Container Manager 的紀錄裡是錯誤碼 1307）。

用 DSM 的任務排程補上，只要設一次：

1. 控制台 → 任務排程表 → 新增 → 觸發的任務 → 使用者定義的指令碼
2. 一般：任務名稱 `dealwatch 開機補啟動`，使用者選 `root`（最省事），或在 `docker` 群組裡的部署帳號；事件選「開機」
3. 任務設定 → 執行指令：`sh /volume1/docker/dealwatch/synology/start-after-boot.sh`；
   可以勾「通知設定 → 執行結果」或「儲存輸出結果」，之後看得到它做了什麼

腳本會等 docker 起來、再多等 90 秒讓 Container Manager 跑完自己那一輪，然後用 `docker compose up -d`
依相依順序把沒起來的容器補上；瀏覽器起得慢或網路介面還沒好而失敗時，每分鐘重試一次，最多 10 次。
設好後可以在任務排程表對它按「執行」，確認沒有錯誤（服務已在跑時它什麼都不會改）。

## 5. 使用

- 網頁介面：`http://<HOST_BIND_IP>:8787`。帳號欄隨便填，密碼是 `UI_PASSWORD`
- 「加入購物車」是在**你正在看這個頁面的那台電腦的瀏覽器**開新分頁，所以用的是那台電腦上已登入的
  Best Buy / Walmart 帳號，跟 NAS 無關
- 右上角「遠端瀏覽器」會開 `https://<HOST_BIND_IP>:3001`（自簽憑證，瀏覽器會警告，確認位址後選擇繼續）。
  帳號是 `VIEW_USER`（預設 `dealwatch`），密碼是 `UI_PASSWORD`
- 平常遠端瀏覽器裡是空白頁：每輪掃描完、閒置 30 秒後分頁會換成空白頁，省 CPU 和硬碟寫入。
  想登入 Walmart 帳號就直接在網址列輸入 walmart.com
- Walmart 需要人機驗證時，網頁介面最上面會出現提示與連結：連進遠端瀏覽器、親手按完驗證、
  回來按「立刻重掃」。驗證頁會一直保留到你處理完，程式不會代你通過驗證
- 每家店的狀態旁邊有「暫停 / 恢復」；頁面最下方有「執行紀錄」

## 瀏覽器設定檔放 SSD

Chromium 的設定檔和快取（約 0.5 GB）寫入頻繁。NAS 有 SSD 組成的儲存空間時，可以把它搬過去，
效率比較好，也少一個寫 HDD 的來源：

1. 在 SSD 的儲存空間建資料夾，例如 `/volume2/docker/dealwatch-browser`，擁有者設成 `PUID` / `PGID` 那個帳號
2. 停止整個專案，把 `data/browser/` 裡的東西整個複製過去（含點開頭的隱藏資料夾）
3. `.env` 加上 `BROWSER_CONFIG_DIR=/volume2/docker/dealwatch-browser`，再重新建立專案（`docker compose up -d`）
4. 確認正常後再刪舊的 `data/browser/`

監控狀態（`data/*.json`）很小，留在原處即可；放在有 RAID 和快照的儲存空間比較安全。

## 調整設定

監控條件在 `config.mjs`，撿漏用的 MSRP 在 `msrp.mjs`，直接用 File Station 的文字編輯器改，
改完到 Container Manager 把 `dealwatch` 容器重新啟動即可（不用重建專案）。
改 `.env`、映像或 compose 時要重新建立容器，新的環境變數才會生效。

更新程式：先備份 `data/` 與自己的設定，把新檔案蓋上去，重新啟動 `dealwatch` 容器。`data/` 裡是狀態與瀏覽器設定檔，不要刪。

Chromium 映像：第一次跑正常後，可以把當時的 digest 填進 `CHROMIUM_IMAGE` 固定版本（`docker image ls --digests` 查），
之後要更新再換新的 digest、確認正常。`lscr.io` 下載很慢時，可改用同一發行者在 Docker Hub 的 `linuxserver/chromium`。

## 安全

- 這兩個埠只給區域網路或 VPN 用，**不要在路由器上對外轉發**。網頁介面是 http，密碼是明碼傳輸；
  遠端瀏覽器畫面等於一台登入了你帳號的電腦
- 人在外面要看：用 Synology 的 VPN Server、ZeroTier 或 Tailscale 連回家再開
- 想要 https：DSM 控制台 → 登入入口 → 進階 → 反向代理，把一個 https 網域指到 `localhost:8787`
- DSM 防火牆有開的話，放行 8787 和 3001 給區域網路或 VPN 的網段
- `dealwatch` 本身也會拒絕在沒有密碼的情況下聽 `127.0.0.1` 以外的位址

## 疑難排解

| 狀況 | 處理 |
| --- | --- |
| NAS 重開機後網頁介面打不開 | `dealwatch` 沒被啟動，見「開機後自動補啟動」。臨時處理：Container Manager 手動啟動 `dealwatch` |
| 網頁介面顯示「連不上瀏覽器 http://127.0.0.1:9222」 | Chromium 容器還沒起來，或沒吃到除錯埠參數。看 `dealwatch-browser` 的紀錄；確認 `CHROME_CLI` 那一行沒被改掉 |
| `dealwatch-browser` 一直重啟 | 多半是 NAS 核心太舊或記憶體不夠。改用精簡版 |
| Chromium 說設定檔被另一台電腦使用 | 舊版沒固定 hostname，重建容器後會這樣。停止兩個容器，只刪掉設定檔資料夾 `dealwatch-profile/` 裡的 `SingletonLock`、`SingletonSocket`、`SingletonCookie`，再啟動 |
| 查詢出現「DNS 解析失敗」 | 容器沿用 NAS 的 DNS 設定。先檢查 DSM 控制台的 DNS；只想讓這個專案改用別的 DNS，在同一個資料夾放 `docker-compose.override.yml`，只替 `browser` 加上 `dns:`（`dealwatch` 共用它的網路，另外設會起不來；精簡版則加在 `dealwatch`）。compose 會自動合併這個檔，加完用 `docker inspect dealwatch-browser --format '{{.HostConfig.Dns}}'` 確認 |
| `https://NAS:3001` 打不開 | 確認 DSM 防火牆；有其他套件占用 3001 就在 `.env` 改 `HOST_VIEW_PORT` |
| 8787 被占用 | 在 `.env` 改 `HOST_UI_PORT` |
| Walmart 一直要求驗證 | 連進遠端瀏覽器按一次，順便登入 Walmart 帳號；把 `config.mjs` 的 `intervalSec.wm` 調大 |
| 推播沒收到 | 網頁介面按「測試推播」，再看最下方的執行紀錄 |

`healthy` 只表示網頁程序還活著，不代表查詢成功；查詢有沒有問題看網頁介面上每家店的狀態和「最近完整成功」時間。

### 精簡版（沒有瀏覽器容器）

```bash
sudo docker-compose -f docker-compose.lite.yml up -d
```

只跑 `dealwatch`，預設已排除必須依賴瀏覽器的 eBay、Micro Center 與已停用公開 RSS 的 Reddit（`--store bb,wm,wt,ne,sd`）。Best Buy、Woot 與 Slickdeals 不受影響；Walmart／Newegg 只用直接請求，被擋時沒有瀏覽器可以接手，
會自動拉長間隔重試。這種情況也可以讓 NAS 專心跑 Best Buy（把 compose 裡的指令改成
`["node", "dealwatch.mjs", "ui", "--store", "bb"]`），其餘須瀏覽器的來源留在電腦上跑。
精簡版只有一個容器，重開機後會自己起來，不需要上面的開機任務。
