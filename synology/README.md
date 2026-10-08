# 在 Synology DSM 7 上執行

用 Docker 跑兩個容器：

| 容器 | 映像檔 | 作用 |
| --- | --- | --- |
| `dealwatch` | `node:22-alpine` | 監控程式本體 + 網頁介面。程式沒有 npm 依賴，直接把這個資料夾掛進去跑，不需要 build |
| `dealwatch-browser` | `lscr.io/linuxserver/chromium` | Walmart 用的 Chromium。有畫面，可以從別台電腦用瀏覽器連進來操作 |

`dealwatch` 透過容器內部的除錯埠遙控那個 Chromium，這個埠不對外。對外只有兩個埠：

- `8787`：dealwatch 網頁介面（看結果、篩選、加入購物車、暫停 / 重掃、看執行紀錄）
- `3001`：遠端瀏覽器畫面（Walmart 跳人機驗證或你想登入帳號時用）

> **這份設定沒有在實體 Synology 上測過。** 我在 Windows 上用同樣的連線方式（程式接到另一個已經開著的瀏覽器）
> 驗證過抓取、密碼、暫停、紀錄都正常，但 `linuxserver/chromium` 在你那台 NAS 的核心與 CPU 上能不能跑、
> 吃不吃 `CHROME_CLI` 裡的除錯埠參數，要實際啟動才知道。跑不起來時見最下面的「疑難排解」。

## 需求

- DSM 7.2 以上用 **Container Manager**；DSM 7.0 / 7.1 用 **Docker** 套件（要走 SSH，見下方）。
- x86-64 或 ARM64 的機種。Chromium 容器閒置約吃 0.5–1 GB 記憶體，總記憶體 4 GB 以上比較穩。
  記憶體不夠就用精簡版（最下面）。

## 1. 把檔案放上 NAS

用 File Station 在 `docker` 共用資料夾底下建一個 `dealwatch` 資料夾，把整個專案傳上去
（不需要 `data/`、`.git/`）。完成後路徑是 `/volume1/docker/dealwatch/docker-compose.yml`。

有裝 Git Server 套件的話也可以 SSH 進去 `git clone`。

## 2. 建立 .env

把 `.env.example` 複製成 `.env`（File Station 裡看不到點開頭的檔案時，到「設定」開啟顯示隱藏檔，
或直接在電腦上改好再上傳），填入：

- `LINE_CHANNEL_ID`、`LINE_CHANNEL_SECRET`、`LINE_TO`：跟你電腦上那份 `.env` 一樣
- `UI_PASSWORD`：**一定要設**。網頁介面和遠端瀏覽器畫面都用這個密碼
- `PUID` / `PGID`：SSH 執行 `id 你的帳號` 查。第一個管理員通常是 `1026` / `100`
- `TZ`：你的時區

## 3. 啟動

**DSM 7.2+（Container Manager）**

1. Container Manager → 專案 → 新增
2. 專案名稱 `dealwatch`，路徑選 `/docker/dealwatch`，來源選「使用現有的 docker-compose.yml」
3. 下一步到底，建置並啟動。第一次要下載映像檔，Chromium 那個比較大

**DSM 7.0 / 7.1（Docker 套件）**

```bash
cd /volume1/docker/dealwatch && sudo docker-compose up -d
```

兩種方式都設了 `restart: unless-stopped`，NAS 重開機後會自己起來。

## 4. 使用

- 網頁介面：`http://<NAS 的 IP>:8787`。帳號欄隨便填，密碼是 `UI_PASSWORD`
- 「加入購物車」是在**你正在看這個頁面的那台電腦的瀏覽器**開新分頁，所以用的是那台電腦上已登入的
  Best Buy / Walmart 帳號，跟 NAS 無關
- 右上角「遠端瀏覽器」會開 `https://<NAS 的 IP>:3001`（自簽憑證，瀏覽器會警告，選擇繼續）。
  帳號是 `VIEW_USER`（預設 `dealwatch`），密碼是 `UI_PASSWORD`
- Walmart 需要人機驗證時，網頁介面最上面會出現提示與連結：連進遠端瀏覽器、親手按完驗證、
  回來按「立刻重掃」。程式不會代你通過驗證
- 每家店的狀態旁邊有「暫停 / 恢復」；頁面最下方有「執行紀錄」

## 調整設定

監控條件在 `config.mjs`，撿漏用的 MSRP 在 `msrp.mjs`，直接用 File Station 的文字編輯器改，
改完到 Container Manager 把 `dealwatch` 容器重新啟動即可（不用重建專案）。

更新程式：把新檔案蓋上去，重新啟動 `dealwatch` 容器。`data/` 裡是狀態與瀏覽器設定檔，不要刪。

## 安全

- 這兩個埠只給區域網路用，**不要在路由器上對外轉發**。網頁介面是 http，密碼是明碼傳輸；
  遠端瀏覽器畫面等於一台登入了你帳號的電腦
- 人在外面要看：用 Synology 的 VPN Server 或 Tailscale 連回家再開
- 想要 https：DSM 控制台 → 登入入口 → 進階 → 反向代理，把一個 https 網域指到 `localhost:8787`
- DSM 防火牆有開的話，放行 8787 和 3001 給區域網路的網段

## 疑難排解

| 狀況 | 處理 |
| --- | --- |
| 網頁介面顯示「連不上瀏覽器 http://127.0.0.1:9222」 | Chromium 容器還沒起來，或沒吃到除錯埠參數。看 `dealwatch-browser` 的紀錄；確認 `CHROME_CLI` 那一行沒被改掉 |
| `dealwatch-browser` 一直重啟 | 多半是 NAS 核心太舊或記憶體不夠。改用精簡版 |
| `https://NAS:3001` 打不開 | 確認 DSM 防火牆；有其他套件占用 3001 就在 `.env` 改 `HOST_VIEW_PORT` |
| 8787 被占用 | 在 `.env` 改 `HOST_UI_PORT` |
| Walmart 一直要求驗證 | 連進遠端瀏覽器按一次，順便登入 Walmart 帳號；把 `config.mjs` 的 `intervalSec.wm` 調大 |
| LINE 沒收到 | 網頁介面按「測試推播」，再看最下方的執行紀錄 |

### 精簡版（沒有瀏覽器容器）

```bash
sudo docker-compose -f docker-compose.lite.yml up -d
```

只跑 `dealwatch`。Best Buy 完全不受影響；Walmart 只用直接請求，被擋時沒有瀏覽器可以接手，
會自動拉長間隔重試。這種情況可以讓 NAS 專心跑 Best Buy（把 compose 裡的指令改成
`["node", "dealwatch.mjs", "ui", "--store", "bb"]`），Walmart 留在電腦上跑 `node dealwatch.mjs ui --store wm`。
