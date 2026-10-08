// dealwatch 設定檔。改完存檔，重新執行即可。
import msrp from './msrp.mjs';

export default {
  // 你的郵遞區號：Best Buy 的 open-box 多半限門市取貨，填了會以你附近的庫存為準
  zip: '61820',

  // watch 模式每家店的輪詢間隔（秒）。太密會被擋，被擋時腳本會自動加倍退避
  // Best Buy 一輪約 3 秒可以跑很密；Walmart 請求一密就會跳人機驗證，建議維持 5 分鐘
  intervalSec: { bb: 60, wm: 300 },

  ui: { port: 8787 }, // `node dealwatch.mjs ui` 的網頁介面埠號

  alert: {
    dropPct: 3, // 價格比上次低這麼多 % 才算「降價」
  },

  cart: {
    goCheckout: true,      // 加入購物車後自動再開結帳頁
    checkoutDelayMs: 3500, // Best Buy 等加入購物車完成再開結帳頁的時間
    browser: null,         // null = 系統預設瀏覽器；也可填 chrome.exe 的完整路徑
    // watch --auto-cart 時，撿漏裡符合這個條件的會自動開購物車（每輪最多 2 個）
    auto: item => true,
  },

  bestbuy: {
    conditions: ['Open-Box', 'Refurbished'], // 各分類可用 bestbuyConditions 覆蓋
    newMinOffPct: 10, // 'New' 全新品只留折扣 >= 這個 % 的（否則整個目錄都會進來），分類可覆蓋
    include3P: true, // 是否包含 Marketplace 第三方賣家
    pageSize: 100,
    maxPages: 2,
  },

  walmart: {
    sort: 'new',       // new = 最新上架
    pages: 1,          // 每個關鍵字抓幾頁（一頁約 40 件）
    gapMs: 1200,       // 每個請求之間至少隔多久（毫秒）。被擋過就調大
    // 抓取方式：'auto' 先直接請求，被擋就改開一個獨立的 Chrome 視窗載入頁面；'browser' 一律用瀏覽器；'http' 一律直接請求
    via: 'auto',
    browserPath: '',   // 留空自動找 Chrome / Edge
    sellers: null,     // 只看特定賣家就填正規式，例如 /^Walmart\.com$|Newegg/i
  },

  // 推播：也可以改用環境變數 LINE_TOKEN (+ LINE_TO) / DISCORD_WEBHOOK / TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID / NTFY_TOPIC
  notify: {
    // LINE Messaging API（LINE Notify 已於 2025/3 停止服務）。設定步驟見 README「LINE 推播」
    // 金鑰建議放在專案根目錄的 .env：LINE_CHANNEL_ID + LINE_CHANNEL_SECRET（腳本會自動換短期 token），
    // 或 LINE_TOKEN（長期 token）。也可以直接填在下面。
    lineChannelId: '',
    lineChannelSecret: '',
    lineToken: '', // Channel access token (long-lived)，有填就優先用這個
    lineTo: '',    // 你的 userId（U 開頭）。留空 = 廣播給這個官方帳號的所有好友
    lineDailyMax: 6, // 免費方案每月 200 則，一天 6 則剛好用不完；同一輪的提醒會併成一則
    onlySteals: true, // true = 只推符合下方 steals 標準的撿漏；false = 上新 / 降價也全部推
    discordWebhook: '',
    telegramToken: '',
    telegramChatId: '',
    ntfyTopic: '',
  },

  // 撿漏標準：符合的才會標 ★、推播。每件只通知一次，之後要再便宜 alert.dropPct 以上才會再通知。
  steals: {
    // 參考價以 msrp.mjs 的 MSRP 為準（現在市價普遍被炒高，跟市價比會把「大家都這麼貴」誤當成撿漏）：
    //   零件：售價 <= MSRP x (1 - msrpMargin)
    //   整機：售價 <= (CPU + 顯卡 + 記憶體 + SSD 的 MSRP + msrp.buildAllowance) x (1 - msrpMargin)
    // MSRP 表裡沒有的型號才退回跟市價比，要低於市價 margin 以上才算。
    // 市價 = Best Buy 全新品目錄與掃描到的全新零件裡的最低價，每 refreshHours 小時更新，存在 data/market.json
    msrp,
    msrpMargin: 0,
    desktopMinGpu: 'RTX 5070 Ti', // 整機只有這個等級以上的顯卡才會被判成撿漏
    margin: 0.10,
    tooGood: 0.5,    // 低於估值一半視為假貨或標題解析錯誤，不算撿漏
    refreshHours: 6,
    // 臨時想蓋過 MSRP 表的某個零件價格可以寫在這裡，例如 { 'gpu:5090': 2000, 'cpu:9800X3D': 450 }。
    // 長期要改的話直接改 msrp.mjs。
    override: {},
    // 估不出零件價的品項（筆電）用規則，命中任一條就算撿漏。可用欄位：
    //   store ('bb'|'wm')、cat、match（比對標題）、gpu（比對 gpu 欄）、minGpu（效能至少這個等級）、maxPrice
    rules: [
      { name: 'Best Buy 5080 以上筆電低於 $2000', store: 'bb', cat: 'laptop', gpu: /^50(80|90)/, maxPrice: 2000 },
      { name: 'ROG Zephyrus 5070 Ti 以上低於 $2000', cat: 'laptop', match: /zephyrus/i, gpu: /^50(70 Ti|80|90)/, maxPrice: 2000 },
    ],
  },

  // 每個分類：queries 是丟給兩家店的搜尋關鍵字，其餘是過濾條件
  //   type        站台商品類型（沒有類型時比對標題）
  //   include     標題必須符合 / exclude 標題不可符合
  //   minGpu      顯卡至少要這個等級
  //   minStickGB  記憶體單條至少幾 GB
  //   minPrice    低於這個價格視為配件或假貨直接略過
  //   show        表格只顯示哪些規格欄（零組件分類用）
  categories: {
    laptop: {
      queries: {
        bestbuy: ['gaming laptop', 'rtx laptop'],
        walmart: ['gaming laptop rtx', 'rtx 5070 ti laptop'],
      },
      type: /laptop|notebook/i,
      minGpu: 'RTX 4050',
      minPrice: 350,
    },

    desktop: {
      queries: {
        bestbuy: ['gaming desktop', 'rtx gaming pc'],
        walmart: ['gaming desktop pc rtx', '9800x3d gaming pc'],
      },
      type: /desktop|gaming pc|tower/i,
      exclude: /all-in-one|\bAIO\b|monitor/i,
      minGpu: 'RTX 4060',
      minPrice: 500,
    },

    cpu: {
      queries: {
        bestbuy: ['ryzen 9800x3d processor', 'ryzen 9950x3d processor', 'ryzen 7800x3d processor', 'core ultra 9 285k processor'],
        walmart: ['ryzen 9800x3d', 'ryzen 9950x3d'],
      },
      type: /processor|cpu/i,
      show: ['cpu'],
      // Best Buy 的 CPU / 記憶體幾乎沒有 open-box，所以這兩類連全新品一起看
      bestbuyConditions: ['Open-Box', 'Refurbished', 'New'],
      newMinOffPct: 0, // 清單內的 CPU 不管有沒有打折都列出來追蹤價格
      include: /9800X3D|9950X3D|9900X3D|9850X3D|7800X3D|7950X3D|9950X\b|9900X\b|285K|265K|14900K|13900K/i,
      exclude: /laptop|notebook|gaming pc|desktop pc|motherboard|bundle|combo|cooler/i,
      minPrice: 150,
    },

    gpu: {
      queries: {
        bestbuy: ['rtx 5070 ti', 'rtx 5080', 'rtx 5090', 'rx 9070 xt', 'graphics card'],
        walmart: ['rtx 5070 ti', 'rtx 5080', 'rtx 5090'],
      },
      type: /graphics card|video card|gpu/i,
      show: ['gpu'],
      exclude: /laptop|notebook|gaming pc|desktop pc|water block|backplate|bracket|riser/i,
      minGpu: 'RTX 5070 Ti',
      minPrice: 400,
    },

    ram: {
      queries: {
        bestbuy: ['ddr5 memory', 'ddr5 32gb', 'ddr5 64gb'],
        walmart: ['ddr5 32gb kit', 'ddr5 64gb kit'],
      },
      type: /memory|ram/i,
      show: ['ram'],
      bestbuyConditions: ['Open-Box', 'Refurbished', 'New'],
      exclude: /RDIMM|LRDIMM|\bECC\b|registered|server|laptop computer|gaming pc/i,
      minStickGB: 16,
      ddr: [5], // 要含 DDR4 就改成 [4, 5]
      minPrice: 40,
    },
  },
};
