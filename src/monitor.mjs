#!/usr/bin/env node
// dealwatch — Best Buy open-box/refurbished 與 Walmart 上新監控。用法見 README.md 或 `node dealwatch.mjs help`
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import config from '../config.mjs';
import * as bestbuy from './bestbuy.mjs';
import * as walmart from './walmart.mjs';
import * as woot from './woot.mjs';
import * as newegg from './newegg.mjs';
import * as ebay from './ebay.mjs';
import * as microcenter from './microcenter.mjs';
import * as slickdeals from './slickdeals.mjs';
import * as reddit from './reddit.mjs';
import { STORES as STORE_META } from './stores.mjs';
import { Blocked, setPace } from './http.mjs';
import { evaluate, parseSpecs } from './specs.mjs';
import { State } from './state.mjs';
import { addToCart, openUrl } from './cart.mjs';
import { storeTabs } from './browser.mjs';
import { startUi } from './ui.mjs';
import { scanStatus } from './scan-status.mjs';
import { buildMarket, makePricer, foldMarket, judge, msrpOf } from './market.mjs';
import { c, printTable, alertLine, offPct, push, pushTargets } from './notify.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
// 金鑰放 .env（不進版控），沒有這個檔就略過
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}
const STORES = Object.fromEntries(Object.entries(STORE_META).map(([code, s]) => [code, s.name]));

// 環境變數可以蓋過 config 裡跟部署環境有關的設定（Docker / NAS 上不用改檔案）
const uiCfg = {
  port: +process.env.UI_PORT || config.ui?.port || 8787,
  host: process.env.UI_HOST || config.ui?.host || '127.0.0.1',
  password: process.env.UI_PASSWORD || config.ui?.password || '',
  // 遠端看瀏覽器畫面的入口：給完整網址，或只給埠號（網頁會用你連進來的主機名稱組出網址）
  browserViewUrl: process.env.BROWSER_VIEW_URL || config.ui?.browserViewUrl || '',
  browserViewPort: +process.env.BROWSER_VIEW_PORT || 0,
};
const cdpUrl = process.env.DEALWATCH_CDP_URL || config.walmart.cdpUrl || '';
const walmartVia = process.env.WALMART_VIA || config.walmart.via;
// 有設 ZIP_CODE 就蓋過 config.zip；設成空字串代表不限定取貨地點
if (process.env.ZIP_CODE !== undefined) config.zip = process.env.ZIP_CODE.trim();
for (const [store, key] of [['bb', 'BESTBUY_INTERVAL_SEC'], ['wm', 'WALMART_INTERVAL_SEC'], ['wt', 'WOOT_INTERVAL_SEC'], ['ne', 'NEWEGG_INTERVAL_SEC'], ['eb', 'EBAY_INTERVAL_SEC'], ['mc', 'MICROCENTER_INTERVAL_SEC'], ['sd', 'SLICKDEALS_INTERVAL_SEC'], ['rd', 'REDDIT_INTERVAL_SEC']]) {
  if (+process.env[key] > 0) config.intervalSec[store] = +process.env[key];
}

// 最近的輸出留一份給網頁介面看（NAS 上沒有終端機可以盯）
const logLines = [];
for (const method of ['log', 'error']) {
  const original = console[method].bind(console);
  console[method] = (...args) => {
    original(...args);
    logLines.push(...args.join(' ').replace(/\x1b\[[0-9;]*m/g, '').split('\n'));
    if (logLines.length > 400) logLines.splice(0, logLines.length - 400);
  };
}

const HELP = `用法: node dealwatch.mjs <指令> [選項]

  doctor              部署前唯讀診斷（--offline / --store bb|wm|wt|ne / --json）
  scan                掃一次各家店（config.stores），列出所有符合條件的商品（預設指令）
  watch               持續監控，有上新 / 降價就提醒；輸入提醒編號可直接開購物車
  ui                  持續監控 + 開一個本機網頁看結果、篩選、一鍵加入購物車
  q <關鍵字>          立刻用任意關鍵字查各家店（不套分類過濾）
  cart <編號>         把上一次 scan / q 結果的第 N 筆加入購物車並開結帳頁
  cart bb <sku> [excellent|good|fair]    直接用 Best Buy SKU（加成色 = open-box）
  cart wm <itemId>                       直接用 Walmart item id
  notify-test         送一則測試推播，確認 LINE 等管道設定正確
  market              列出撿漏判斷採用的參考價（MSRP / 市價）
  browser             打開 dealwatch 專用的瀏覽器視窗（通過 Walmart 人機驗證或登入 Walmart 帳號）
  urls                列出 Walmart 的搜尋網址（被擋時改用瀏覽器開）
  ingest <檔案.html>  解析瀏覽器另存的 Walmart 搜尋頁，一樣做過濾 / 比對 / 提醒

選項:
  --store bb,wt       只跑指定的店（bb Best Buy、wm Walmart、wt Woot、ne Newegg、sd Slickdeals、rd r/buildapcsales）
  --cat laptop,gpu    只跑指定分類（${Object.keys(config.categories).join(', ')}）
  --steals            只顯示符合撿漏標準（config.steals）的
  --min-off 15        只顯示折扣 >= 15% 的
  --top 30            只顯示前 30 筆
  --json              scan / q 改輸出 JSON
  --dry               cart: 只印出加入購物車連結，不開瀏覽器
  --auto-cart         watch: 符合 config.cart.auto 的提醒自動開購物車
  --headless          watch: 不開瀏覽器、不讀鍵盤（雲端 24hr 執行用）
  --once              watch: 只跑一輪就結束（給排程器用）`;

function parseArgs(argv) {
  const flags = {}, pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const key = a.slice(2);
    flags[key] = ['store', 'cat', 'min-off', 'top'].includes(key) ? argv[++i] : true;
  }
  return { cmd: pos[0] ?? 'scan', rest: pos.slice(1), flags };
}

const { cmd, rest, flags } = parseArgs(process.argv.slice(2));
const state = new State(path.join(ROOT, 'data'));
// 預設跑 config.stores 列的店
const stores = (flags.store ? flags.store.split(',') : config.stores ?? ['bb', 'wm']).filter(s => {
  if (STORES[s]) return true;
  console.error(c.red(`不認得的店家代號 ${s}，可用: ${Object.keys(STORES).join(', ')}`));
  return false;
});
const cats = Object.entries(config.categories).filter(([name]) => !flags.cat || flags.cat.split(',').includes(name));
const catNames = cats.map(([name]) => name);
const failed = r => r.blocked || (r.errors.length > 0 && !r.items.length);
const watchlist = (config.watchlist ?? []).map(parseWatch).filter(w => w && stores.includes(w.store));
const time = () => new Date().toTimeString().slice(0, 8);
setPace('wm', 2, config.walmart.gapMs);

// 每家要用瀏覽器的店各一個分頁，都在同一個瀏覽器裡
const tabs = storeTabs({ path: config.walmart.browserPath, profileDir: path.join(ROOT, 'data', 'chrome-profile'), cdpUrl }, ['wm', 'ne', 'eb', 'mc']);
// Walmart 直接請求被擋時改用獨立的瀏覽器視窗；被擋過就記 6 小時，這段時間直接走瀏覽器不再白試
const wmBrowser = tabs.wm;
walmart.configure({ via: walmartVia, browser: wmBrowser, startInBrowser: (state.readJson('walmart-mode.json')?.browserUntil ?? 0) > Date.now() });
// Newegg 被 Cloudflare 擋時也改用瀏覽器；WALMART_VIA=http（沒有瀏覽器的部署）就只走直接請求
newegg.configure({ browser: walmartVia === 'http' ? null : tabs.ne });
// eBay / Micro Center 直接請求一律被擋，只能用瀏覽器
ebay.configure({ browser: tabs.eb, ...config.ebay });
microcenter.configure({ browser: tabs.mc, ...config.microcenter });
function saveWalmartHint() {
  if (walmartVia === 'auto' && walmart.usingBrowser()) state.writeJson('walmart-mode.json', { browserUntil: Date.now() + 6 * 36e5 });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function keep(item) {
  if (!item.inStock || !(item.price > 0)) return false;
  if (item.store === 'bb' && !config.bestbuy.include3P && item.seller !== 'BestBuy') return false;
  if (item.store === 'wm' && config.walmart.sellers && !config.walmart.sellers.test(item.seller)) return false;
  if (item.store === 'eb' && !ebayOk(item)) return false;
  return true;
}

// eBay 賣家信用與商品狀況。好評率或評價數不明的一律不要
function ebayOk(item) {
  const e = config.ebay ?? {};
  const condition = item.cond === 'Used' ? 'Used' : { ob: 'Open-Box', refurb: 'Refurbished', new: 'New' }[item.kind];
  if (e.conditions && !e.conditions.includes(condition)) return false;
  if (e.minFeedbackPct != null && !(item.feedbackPct >= e.minFeedbackPct)) return false;
  if (e.minFeedbackCount != null && !(item.feedbackCount >= e.minFeedbackCount)) return false;
  return true;
}

// 先試關鍵字所屬的分類，不合再試其他分類（例如搜 9800x3d 也會出現整機）
function classify(item, preferred) {
  if (!keep(item)) return null;
  const condition = { ob: 'Open-Box', refurb: 'Refurbished', new: 'New' }[item.kind];
  for (const name of [preferred, ...catNames.filter(n => n !== preferred)]) {
    if (!name) continue;
    const cat = config.categories[name];
    // 全新品只進有開 'New' 的分類，否則搜記憶體時順帶出現的全新筆電也會混進來
    if (item.store === 'bb' && !(cat.bestbuyConditions ?? config.bestbuy.conditions).includes(condition)) continue;
    if (item.store === 'bb' && item.kind === 'new' && offPct(item) < (cat.newMinOffPct ?? config.bestbuy.newMinOffPct)) continue;
    const specs = evaluate(cat, item);
    if (specs) return { ...item, cat: name, specs, off: offPct(item) };
  }
  return null;
}

async function bestbuyPages(query, condition) {
  const { pageSize: size, maxPages } = config.bestbuy;
  const opts = { query, condition, size, zip: config.zip, sort: condition === 'New' ? 'Best-Discount' : '' };
  const first = await bestbuy.search(opts);
  const pages = Math.min(maxPages, Math.ceil(first.total / size));
  const more = await Promise.all(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => bestbuy.search({ ...opts, page: i + 2 })));
  return [first, ...more].flatMap(r => r.items);
}

// Best Buy 以外的店：一個關鍵字一個工作
function storeSearch(store, query, cat) {
  const opts = { query, minPrice: cat.minPrice, maxPrice: cat.maxPrice };
  if (store === 'wm') return walmartPages(query, cat);
  if (store === 'wt') return woot.search({ ...opts, limit: config.woot?.limit }).then(r => r.items);
  if (store === 'ne') return newegg.search(opts).then(r => r.items);
  if (store === 'eb') return ebay.search({ ...opts, category: cat.ebayCategory }).then(r => r.items);
  if (store === 'mc') return microcenter.search(opts).then(r => r.items);
  if (store === 'sd') return slickdeals.search(opts).then(r => r.items);
  if (store === 'rd') return reddit.search(opts).then(r => r.items);
  throw new Error(`沒有 ${store} 的搜尋方式`);
}

// 指定商品的單品查詢
function storeProduct(store, id) {
  const fn = { bb: bestbuy.product, wm: walmart.product, wt: woot.product, ne: newegg.product, eb: ebay.product, mc: microcenter.product }[store];
  if (!fn) throw new Error(`${STORES[store]} 不支援指定商品`);
  return fn(id);
}

async function walmartPages(query, cat) {
  const results = await Promise.all(Array.from({ length: config.walmart.pages }, (_, i) =>
    walmart.search({ query, sort: config.walmart.sort, page: i + 1, minPrice: cat.minPrice, maxPrice: cat.maxPrice })));
  return results.flatMap(r => r.items);
}

// 跑完一家店所有分類的所有關鍵字，回傳去重、過濾後的商品
async function scanStore(store) {
  const t0 = Date.now();
  const jobs = [];
  for (const [catName, cat] of cats) {
    for (const query of cat.queries?.[STORE_META[store].queries] ?? []) {
      if (store === 'bb') for (const condition of cat.bestbuyConditions ?? config.bestbuy.conditions) jobs.push({ catName, run: () => bestbuyPages(query, condition) });
      else jobs.push({ catName, run: () => storeSearch(store, query, cat) });
    }
  }
  const settled = await Promise.allSettled(jobs.map(j => j.run()));
  const found = new Map(), errors = [];
  let blocked = false, raw = 0;
  settled.forEach((res, i) => {
    if (res.status === 'rejected') { errors.push(res.reason.message); blocked ||= res.reason instanceof Blocked; return; }
    for (const item of res.value) {
      raw++;
      if (found.has(item.key)) continue;
      const hit = classify(item, jobs[i].catName);
      if (hit) found.set(item.key, hit);
    }
  });
  // 指定商品：不靠搜尋結果，直接查。缺貨或暫時查不到的只記狀態，不進清單
  const mine = watchlist.filter(w => w.store === store);
  const watch = await Promise.all(mine.map(async w => {
    try {
      const forms = await storeProduct(store, w.id);
      await markStock(forms);
      for (const item of forms.filter(keep)) {
        const hit = found.get(item.key) ?? classify(item) ?? forceClassify(item);
        if (hit) found.set(item.key, { ...hit, watch: w });
      }
      const best = forms.filter(f => f.price > 0).sort((a, b) => a.price - b.price)[0];
      return best ? { ...w, name: best.name, price: best.price, cond: best.cond, inStock: forms.some(keep), stockKnown: store !== 'bb' || !!best.stockKnown, url: best.url } : { ...w, error: '查不到這個商品' };
    } catch (err) {
      blocked ||= err instanceof Blocked;
      errors.push(err.message);
      return { ...w, error: err.message };
    }
  }));
  await markStock([...found.values()]);
  const items = [...found.values()].filter(i => i.inStock);
  // 整輪失敗時不要用空結果蓋掉上一輪的行情
  if (items.length || !errors.length) await judgeItems(store, items);
  return { store, items, watch, errors: [...new Set(errors)], blocked, requests: jobs.length + mine.length, raw, ms: Date.now() - t0 };
}

function printWatch(list) {
  if (!list.length) return;
  console.log(c.bold('\n指定商品:'));
  for (const w of list) {
    const where = STORES[w.store];
    if (w.error) console.log(`  ${where} ${w.id}  ${c.red(w.error)}`);
    else console.log(`  ${where} ${w.id}  $${w.price}  ${w.inStock ? w.cond : c.yellow('缺貨')}${w.maxPrice ? `  到價通知 $${w.maxPrice}` : ''}  ${w.name.slice(0, 70)}`);
  }
}

// 指定商品不套分類的過濾條件（等級、價格下限等），只用商品類型決定歸到哪一類
function forceClassify(item) {
  const name = Object.keys(config.categories).find(n => config.categories[n].type?.test(item.type || item.name));
  return name ? { ...item, cat: name, specs: parseSpecs(item.name), off: offPct(item) } : null;
}

// config.watchlist 的每一項可以是網址，或 { store: 'bb'|'wm'|'wt'|'ne'|'eb'|'mc', id, maxPrice }
function parseWatch(entry) {
  const w = typeof entry === 'string' ? { url: entry } : { ...entry };
  if (w.store && w.id) return { ...w, id: String(w.id) };
  const url = w.url ?? '';
  const wm = /walmart\.com\/ip\/(?:[^/?#]+\/)?(\d+)/.exec(url);
  const bb = /bestbuy\.com\/.*?(?:\/sku\/|skuId=|\/)(\d{7,8})(?:\.p)?(?=[/?#]|$)/.exec(url);
  const wt = /woot\.com\/offers\/([a-z0-9-]+)/i.exec(url);
  const ne = /newegg\.com\/(?:.*\/)?p\/([A-Za-z0-9-]+)/i.exec(url);
  if (wm) return { ...w, store: 'wm', id: wm[1] };
  if (bb) return { ...w, store: 'bb', id: bb[1] };
  if (wt) return { ...w, store: 'wt', id: wt[1].toLowerCase() };
  if (ne) return { ...w, store: 'ne', id: ne[1].toUpperCase() };
  const eb = /ebay\.com\/itm\/(?:[^/?#]+\/)?(\d{9,})/i.exec(url);
  const mc = /microcenter\.com\/product\/(\d+)/i.exec(url);
  if (eb) return { ...w, store: 'eb', id: eb[1] };
  if (mc) return { ...w, store: 'mc', id: mc[1] };
  console.error(c.red(`指定商品看不出是哪家店的哪個商品，已略過: ${url}（Best Buy 請用含 /sku/數字 的網址，或寫成 { store: 'bb', id: 'SKU' }）`));
  return null;
}

// 市價表每隔幾小時從 Best Buy 目錄重建一次
let marketJob = null;
function loadMarket() {
  return marketJob ??= (async () => {
    const saved = state.readJson('market.json');
    if (saved && Date.now() - saved.t < config.steals.refreshHours * 36e5) return saved;
    try {
      const built = await buildMarket();
      state.writeJson('market.json', built);
      return built;
    } catch (err) {
      console.error(c.red(`市價表更新失敗（${err.message}），這一輪${saved ? '沿用舊表' : '只套用規則'}`));
      return saved;
    }
  })().finally(() => { marketJob = null; });
}

// 各家店最近一輪的商品，用來互相比價
const lastItems = {};

// 零件自己「原本的價格」也算行情，所以只有新上架或剛降價的零件才可能是撿漏。
// 已經判定過的撿漏不套用，價格沒回升前會一直維持 ★。整機和筆電看的是絕對標準，不受這個影響。
function ownMarketPrice(store, item) {
  if (!['cpu', 'gpu', 'ram'].includes(item.cat)) return undefined;
  if (!state.isSeeded(store, item.cat)) return item.price;
  const rec = state.items[item.key];
  return rec && rec.told == null ? rec.hist.at(-1) : undefined;
}

async function judgeItems(store, items) {
  lastItems[store] = items;
  const all = Object.values(lastItems).flat();
  const market = await loadMarket();
  const priceOf = makePricer(market, all, config.steals.override);
  for (const item of items) {
    item.deal = judge(item, priceOf, config.steals, ownMarketPrice(store, item));
    // eBay 的整機多半是賣家自己組的，電源、主機板看不出等級，零件估值不準；只在 ebay.stealCats 的分類算撿漏
    const ebayCats = config.ebay?.stealCats;
    if (item.store === 'eb' && item.deal?.steal && ebayCats && !ebayCats.includes(item.cat)) {
      item.deal = { ...item.deal, steal: false, reason: `eBay ${item.cat} 不算撿漏（ebay.stealCats）｜${item.deal.reason}` };
    }
    // 指定商品有設到價通知的話，到價就算撿漏
    const target = item.watch?.maxPrice;
    if (target && item.price <= target) item.deal = { ...item.deal, steal: true, reason: `指定商品到價：售價 ${item.price}，你設定 ${target} 以下通知` };
    if (knownSoldOut(item)) markSoldOut(item);
  }
  // 判斷完才把這一輪的行情併進市價表。撿漏本身不併，它還在的期間才會一直維持 ★
  if (market && foldMarket(market, items.filter(i => !i.deal?.steal))) state.writeJson('market.json', market);
}

// 還沒通知過的撿漏
const pendingSteals = items => items.filter(i => i.deal?.steal && state.needsNotify(i, config.alert.dropPct));

// 庫存查詢結果記 30 分鐘。key -> { t, ok }，ok 為 false 表示確定售完
const stockCache = new Map();
const STOCK_TTL = 30 * 60e3;
const knownSoldOut = item => { const hit = stockCache.get(item.key); return !!hit && hit.ok === false && Date.now() - hit.t < STOCK_TTL; };

// Best Buy 自營的全新 / 整新品直接查庫存，售完的標成沒貨。
// open-box（多半限門市取貨）和第三方賣家的商品這個方法查不到，維持原樣（庫存待確認）。
async function markStock(items) {
  await Promise.all(items.filter(i => i.store === 'bb' && i.seller === 'BestBuy' && i.kind !== 'ob').map(async item => {
    let hit = stockCache.get(item.key);
    if (!hit || Date.now() - hit.t > STOCK_TTL) stockCache.set(item.key, hit = { t: Date.now(), ok: await bestbuy.available(item.id, config.zip) });
    if (hit.ok != null) item.stockKnown = true;
    if (hit.ok === false) item.inStock = false;
  }));
}

// 推播前的最後一關：Best Buy 第三方賣家的商品庫存只能開商品頁看，所以只對即將通知的撿漏做。
// 確定售完的不通知；沒有瀏覽器可用、判斷不出來的照樣通知，但註明庫存未驗證。
async function confirmSteals(items, candidates = pendingSteals(items)) {
  const confirmed = [];
  for (const item of candidates) {
    if (item.store === 'bb' && item.seller !== 'BestBuy') {
      const ok = await bestbuy.pageStock(wmBrowser, item.url);
      stockCache.set(item.key, { t: Date.now(), ok });
      if (ok === false) { markSoldOut(item); continue; }
      if (ok === null) item.deal = { ...item.deal, reason: `${item.deal.reason}（第三方賣家，庫存未驗證）` };
    }
    confirmed.push(item);
  }
  return confirmed;
}

function markSoldOut(item) {
  item.soldOut = true;
  if (item.deal?.steal) item.deal = { ...item.deal, steal: false, reason: `已售完｜${item.deal.reason}` };
}

const catOrder = Object.keys(config.categories);
const sortItems = items => items.sort((a, b) => catOrder.indexOf(a.cat) - catOrder.indexOf(b.cat) || b.off - a.off || a.price - b.price);

function applyView(items) {
  let out = items;
  if (flags.steals) out = out.filter(i => i.deal?.steal);
  if (flags['min-off']) out = out.filter(i => i.off >= +flags['min-off']);
  if (flags.top) out = out.slice(0, +flags.top);
  return out;
}

function summary(r) {
  const err = r.errors.length ? c.red(` 錯誤: ${r.errors.join('; ')}`) : '';
  return `${STORES[r.store]}: ${r.requests} 個查詢 ${(r.ms / 1000).toFixed(1)}s，${r.raw} 筆中 ${r.items.length} 筆符合${err}`;
}

async function cmdScan() {
  const results = await Promise.all(stores.map(scanStore));
  // 被擋或整輪失敗的店不更新狀態，避免把半套結果當基準
  const alerts = results.filter(r => !failed(r)).flatMap(r => state.update(r.store, r.items, catNames, config.alert));
  state.save();
  const all = results.flatMap(r => r.items);
  // 單次掃描不推播，但撿漏一樣先確認第三方賣家的庫存，免得列出已售完的
  await confirmSteals(all, all.filter(i => i.deal?.steal));
  const items = applyView(sortItems(all));
  state.writeJson('last.json', items);
  if (flags.json) { console.log(JSON.stringify({ items, alerts: alerts.map(a => ({ why: a.why, prev: a.prev, key: a.item.key })) }, null, 1)); return; }
  printTable(items);
  console.log();
  for (const r of results) console.log(c.dim(summary(r)));
  printWatch(results.flatMap(r => r.watch));
  if (alerts.length) { console.log(c.bold(`\n和上次相比有 ${alerts.length} 則變動:`)); for (const a of alerts.slice(0, 40)) console.log(alertLine(a)); }
  const steals = items.filter(i => i.deal?.steal);
  if (steals.length) { console.log(c.bold(`\n★ 撿漏 ${steals.length} 筆:`)); for (const item of steals) console.log(alertLine({ why: 'STEAL', item })); }
  console.log(c.dim('\n加入購物車並開結帳頁: node dealwatch.mjs cart <編號>（scan 不會推播，推播由 watch 負責）'));
}

async function cmdNotifyTest() {
  const t = pushTargets(config.notify);
  const on = [t.line && 'LINE', t.discord && 'Discord', t.telegramToken && 'Telegram', t.ntfy && 'ntfy'].filter(Boolean);
  if (!on.length) { console.error('還沒設定任何推播管道。請在 config.mjs 的 notify 填入，或設定環境變數。'); process.exit(1); }
  console.log(`送出測試訊息到: ${on.join(', ')}`);
  const ok = await push(config.notify, [], `✅ dealwatch 推播測試 ${new Date().toLocaleString()}`);
  if (!ok) { console.error(c.red('有管道送出失敗，見上方訊息。')); process.exit(1); }
  console.log('已送出，請看手機。');
}

// 列出撿漏判斷實際採用的參考價：override > MSRP > 掃到的市價
function cmdMarket() {
  const street = state.readJson('market.json')?.prices ?? {};
  const { msrp, override, msrpPremium, margin } = config.steals;
  const keys = new Set([...Object.keys(street), ...Object.keys(override), ...['cpu', 'gpu'].flatMap(kind => Object.keys(msrp[kind]).map(k => `${kind}:${k}`))]);
  console.log('零件'.padEnd(18) + 'MSRP'.padStart(8) + '市價'.padStart(8) + '撿漏價'.padStart(7));
  for (const key of [...keys].filter(k => !k.startsWith('ssd:')).sort()) {
    const m = msrpOf(key, msrp), s = street[key];
    // 跟 src/market.mjs 的判斷一致：指定價 > 被炒高時 MSRP 加溢價 > 比市價低 margin
    const [target, how] = override[key] != null ? [override[key], '你指定的']
      : m != null && s != null && s > m * 1.1 ? [Math.round(Math.min(m * (1 + msrpPremium), s * (1 - margin))), `MSRP +${Math.round(msrpPremium * 100)}%`]
      : m != null && s == null ? [m, 'MSRP（查無市價）']
      : [Math.round(Math.min(s, m ?? Infinity) * (1 - margin)), `比市價低 ${Math.round(margin * 100)}%，限新上架或剛降價`];
    console.log(key.padEnd(20) + String(m ?? '').padStart(8) + String(s ?? '').padStart(10) + String(target).padStart(10) + `  ${how}`);
  }
  console.log(c.dim(`\n記憶體 MSRP 以每 GB 單價換算（DDR5 $${msrp.ramPerGB[5]}、DDR4 $${msrp.ramPerGB[4]}）；整機 = 各零件撿漏價加總 + $${msrp.buildAllowance}。`));
  console.log(c.dim('MSRP 改 msrp.mjs；溢價比例與個別指定價改 config.mjs 的 steals.msrpPremium / steals.override。'));
}


// 打開 Walmart 專用的瀏覽器視窗並留著，讓你通過人機驗證或登入帳號
async function cmdBrowser() {
  wmBrowser.keepOpen = wmBrowser.hold = true;
  const html = await wmBrowser.html('https://www.walmart.com/');
  await wmBrowser.focus();
  console.log(html.includes('Robot or human?')
    ? '已開啟 dealwatch 專用的瀏覽器視窗，Walmart 正在要求人機驗證：請在那個視窗按住按鈕完成驗證。'
    : '已開啟 dealwatch 專用的瀏覽器視窗，Walmart 目前可以正常瀏覽。想登入帳號可以直接在那個視窗登入。');
  console.log('視窗可以縮小但先不要關；之後的 scan / watch / ui 會沿用它。');
}

// Walmart 擋掉腳本時的替代路徑：用瀏覽器開 `urls` 列出的網址、另存 HTML，再餵給 ingest
function cmdUrls() {
  for (const [, cat] of cats) for (const query of cat.queries?.walmart ?? []) console.log(walmart.searchUrl({ query, sort: config.walmart.sort, minPrice: cat.minPrice, maxPrice: cat.maxPrice }));
}

async function cmdIngest(files) {
  if (!files.length) { console.error('用法: node dealwatch.mjs ingest <walmart搜尋頁.html> [...]'); process.exit(1); }
  const found = new Map();
  for (const file of files) {
    for (const item of walmart.parse(fs.readFileSync(file, 'utf8'))) {
      const hit = !found.has(item.key) && classify(item);
      if (hit) found.set(item.key, hit);
    }
  }
  const items = sortItems([...found.values()]);
  await judgeItems('wm', items);
  const alerts = state.update('wm', items, catNames, config.alert);
  const steals = (await confirmSteals(items)).map(item => ({ why: 'STEAL', item }));
  for (const s of steals) state.markNotified(s.item);
  state.save();
  state.writeJson('last.json', items);
  for (const a of [...alerts, ...steals]) state.appendLine('alerts.jsonl', { t: new Date().toISOString(), why: a.why, prev: a.prev, ...a.item });
  if (flags.json) { console.log(JSON.stringify({ items, alerts: [...alerts, ...steals].map(a => ({ why: a.why, prev: a.prev, key: a.item.key })) }, null, 1)); }
  else {
    printTable(items);
    console.log(c.dim(`\n${files.length} 個檔案，${items.length} 筆符合`));
    for (const a of [...alerts, ...steals]) console.log(alertLine(a));
  }
  await push(config.notify, config.notify.onlySteals ? steals : [...steals, ...alerts]);
}

async function cmdQuery(query) {
  if (!query) { console.error('請給關鍵字，例如: node dealwatch.mjs q 9800x3d'); process.exit(1); }
  const jobs = [];
  if (stores.includes('bb')) for (const condition of [null, 'Open-Box', 'Refurbished']) jobs.push(bestbuy.search({ query, condition, size: 48, zip: config.zip }));
  if (stores.includes('wm')) jobs.push(walmart.search({ query, sort: '' }));
  if (stores.includes('wt')) jobs.push(woot.search({ query }));
  if (stores.includes('ne')) jobs.push(newegg.search({ query }));
  if (stores.includes('eb')) jobs.push(ebay.search({ query }));
  if (stores.includes('mc')) jobs.push(microcenter.search({ query }));
  if (stores.includes('sd')) jobs.push(slickdeals.search({ query }));
  if (stores.includes('rd')) jobs.push(reddit.search({ query }));
  const t0 = Date.now();
  const settled = await Promise.allSettled(jobs);
  const seen = new Set();
  const items = settled.flatMap(s => (s.status === 'fulfilled' ? s.value.items : []))
    .filter(i => i.inStock && i.price > 0 && !seen.has(i.key) && seen.add(i.key))
    .map(i => ({ ...i, specs: parseSpecs(i.name), off: offPct(i) }))
    .sort((a, b) => a.price - b.price);
  const view = applyView(items);
  state.writeJson('last.json', view);
  if (flags.json) { console.log(JSON.stringify(view, null, 1)); return; }
  printTable(view);
  for (const s of settled) if (s.status === 'rejected') console.log(c.red(s.reason.message));
  console.log(c.dim(`\n${((Date.now() - t0) / 1000).toFixed(1)}s，${view.length} 筆。加入購物車: node dealwatch.mjs cart <編號>`));
}

async function cmdCart(args) {
  let item;
  if (args[0] === 'bb' && args[1]) {
    const code = { excellent: 2, good: 1, fair: 0 }[args[2]?.toLowerCase()];
    item = { store: 'bb', name: `Best Buy SKU ${args[1]}${args[2] ? ' open-box ' + args[2] : ''}`, cartUrl: bestbuy.cartUrl(args[1], code) };
  } else if (args[0] === 'wm' && args[1]) {
    item = { store: 'wm', name: `Walmart item ${args[1]}`, cartUrl: walmart.cartUrl({ id: args[1] }) };
  } else {
    item = state.readJson('last.json')?.[+args[0] - 1];
    if (!item) { console.error('找不到這個編號。先跑 scan 或 q，再用表格最左邊的 # 編號。'); process.exit(1); }
  }
  if (!item.cartUrl) {
    console.log(`這件沒有加入購物車連結（Best Buy 第三方賣家、Woot、Newegg 第三方、社群回報的 deal），改開商品頁: ${item.name}\n${item.url}`);
    if (!flags.dry) openUrl(item.url, config.cart.browser);
    return;
  }
  console.log(`加入購物車: ${item.name}\n${item.cartUrl}`);
  if (flags.dry) { console.log(c.dim('（--dry：只顯示連結，不開瀏覽器）')); return; }
  await addToCart(item, config.cart);
}

// watch 與 ui 共用同一套監控迴圈；ui 另外開一個本機網頁
async function cmdWatch({ ui = false } = {}) {
  const headless = !!flags.headless || ui;
  const recent = [];  // 提醒編號從 1 起算，對應 recent[n-1]
  const current = {}; // store -> 最近一輪的商品
  const status = {};  // store -> 最近一輪的結果摘要，給網頁顯示
  const wake = {};    // store -> 叫醒正在等下一輪的迴圈
  const paused = new Set(); // 被網頁介面暫停的店
  const watchStatus = {};   // store -> 指定商品最近一次查到的狀態

  const handle = async (r, alerts) => {
    current[r.store] = r.items;
    const steals = (await confirmSteals(r.items)).map(item => ({ why: 'STEAL', item }));
    const stealKeys = new Set(steals.map(s => s.item.key));
    // 撿漏用自己的格式印（含估值說明），同一件就不再重複印上新 / 降價
    const plain = alerts.filter(a => !stealKeys.has(a.item.key));
    for (const a of [...steals, ...plain]) {
      recent.push({ t: Date.now(), ...a });
      console.log(`${c.dim(time())} ${c.bold('#' + recent.length)} ${alertLine(a)}\n   ${c.dim(a.item.cartUrl ?? a.item.url)}`);
      state.appendLine('alerts.jsonl', { t: new Date().toISOString(), why: a.why, prev: a.prev, ...a.item });
    }
    if (!steals.length && !plain.length) return;
    for (const s of steals) state.markNotified(s.item);
    state.save();
    if (!headless) process.stdout.write('\x07');
    if (flags['auto-cart'] && !flags.headless) {
      for (const s of steals.filter(s => config.cart.auto?.(s.item)).slice(0, 2)) {
        console.log(c.yellow(`自動加入購物車: ${s.item.name.slice(0, 70)}`));
        if (s.item.cartUrl) await addToCart(s.item, config.cart); else openUrl(s.item.url, config.cart.browser);
      }
    }
    await push(config.notify, config.notify.onlySteals ? steals : [...steals, ...plain]);
  };

  const loop = async store => {
    let backoff = 1;
    for (;;) {
      while (paused.has(store)) {
        status[store] = { ...status[store], scanning: false, paused: true, next: null };
        await new Promise(resolve => { wake[store] = resolve; });
      }
      status[store] = { ...status[store], scanning: true, paused: false };
      const r = await scanStore(store);
      watchStatus[store] = r.watch;
      const summaryOf = { t: Date.now(), ms: r.ms, requests: r.requests, raw: r.raw, scanning: false, viaBrowser: (store === 'wm' && walmart.usingBrowser()) || (store === 'ne' && newegg.usingBrowser()) || store === 'eb' || store === 'mc' };
      if (failed(r)) {
        if (backoff === 1) await push(config.notify, [], `⚠️ ${STORES[store]} 查詢失敗（${r.errors[0]}），已自動拉長間隔重試`);
        backoff = Math.min(backoff * 2, 16);
        console.log(`${c.dim(time())} ${c.red(`${STORES[store]} 查詢失敗: ${r.errors.join('; ')}`)} → 間隔 x${backoff}`);
        status[store] = scanStatus(status[store], summaryOf, { failed: true, errors: r.errors, count: r.items.length });
      } else {
        backoff = 1;
        const firstRun = !catNames.every(n => state.isSeeded(store, n));
        const alerts = state.update(store, r.items, catNames, config.alert);
        state.save();
        saveWalmartHint();
        console.log(c.dim(`${time()} ${summary(r)}，★ 撿漏 ${r.items.filter(i => i.deal?.steal).length} 筆${firstRun ? '（首次執行，已建立基準）' : alerts.length ? '' : '，無變動'}`));
        status[store] = scanStatus(status[store], summaryOf, { failed: false, errors: r.errors, count: r.items.length });
        await handle(r, alerts);
      }
      if (flags.once) return;
      const wait = (config.intervalSec[store] ?? 90) * 1000 * backoff * (0.85 + Math.random() * 0.3);
      status[store].next = Date.now() + wait;
      await new Promise(resolve => { const timer = setTimeout(resolve, wait); wake[store] = () => { clearTimeout(timer); resolve(); }; });
    }
  };

  console.log(c.bold(`dealwatch 監控中: ${stores.map(s => STORES[s]).join(' + ')}｜分類: ${cats.map(([n]) => n).join(', ')}`));
  if (ui) {
    const local = ['127.0.0.1', 'localhost', '::1'].includes(uiCfg.host);
    await startUi({
      ...uiCfg,
      getState: () => ({
        now: Date.now(),
        stores: Object.fromEntries(stores.map(s => [s, { name: STORES[s], intervalSec: config.intervalSec[s], ...status[s] }])),
        items: sortItems(Object.values(current).flat()),
        alerts: recent.slice(-60).reverse().map(a => ({ t: a.t, why: a.why, prev: a.prev, key: a.item.key, name: a.item.name, price: a.item.price, store: a.item.store, cond: a.item.cond, cartUrl: a.item.cartUrl, url: a.item.url, reason: a.item.deal?.reason })),
        market: state.readJson('market.json')?.t ?? null,
        cats: catNames,
        watchlist: stores.flatMap(s => watchStatus[s] ?? []),
        steals: { rules: config.steals.rules.map(r => r.name) },
        browserViewUrl: uiCfg.browserViewUrl, browserViewPort: uiCfg.browserViewPort,
        push: Object.entries(pushTargets(config.notify)).filter(([k, v]) => ['line', 'discord', 'telegramToken', 'ntfy'].includes(k) && v).map(([k]) => k.replace('Token', '')),
      }),
      getLog: () => logLines.slice(-200),
      rescan: () => { for (const s of stores) if (!paused.has(s)) wake[s]?.(); },
      setPaused: (store, on) => {
        if (!stores.includes(store)) return false;
        if (on) paused.add(store); else paused.delete(store);
        console.log(`${time()} ${STORES[store]} ${on ? '已暫停' : '恢復監控'}`);
        wake[store]?.();
        return true;
      },
      notifyTest: () => push(config.notify, [], `✅ dealwatch 推播測試 ${new Date().toLocaleString()}`),
    });
    console.log(c.bold(`網頁介面: http://${local ? 'localhost' : '<這台機器的 IP>'}:${uiCfg.port}${uiCfg.password ? '（需要密碼）' : ''}`));
    if (local && !flags['no-open']) openUrl(`http://localhost:${uiCfg.port}`, config.cart.browser);
  } else if (!headless && process.stdin.isTTY) {
    console.log(c.dim('輸入提醒的 # 編號 + Enter = 加入購物車並開結帳頁｜l = 列出目前全部｜q = 離開'));
    readline.createInterface({ input: process.stdin }).on('line', async line => {
      const s = line.trim().toLowerCase();
      if (s === 'q') return quit(0);
      if (s === 'l') { printTable(sortItems(Object.values(current).flat()), { numbered: false }); return; }
      const item = recent[+s - 1]?.item;
      if (!item) { if (s) console.log(c.dim('沒有這個編號')); return; }
      console.log(c.yellow(`${item.cartUrl ? '加入購物車' : '開商品頁（第三方賣家）'}: ${item.name.slice(0, 80)}`));
      if (item.cartUrl) await addToCart(item, config.cart); else openUrl(item.url, config.cart.browser);
    });
  }
  await Promise.all(stores.map(loop));
}

// 結束前把自己開的瀏覽器關掉
async function quit(code) {
  await Promise.all([tabs.ne, tabs.eb, tabs.mc].map(tab => tab.dispose()));
  await wmBrowser.dispose();
  process.exit(code);
}
process.on('SIGINT', () => quit(0));
process.on('SIGTERM', () => quit(0)); // docker stop

try {
  if (cmd === 'scan') await cmdScan();
  else if (cmd === 'watch') await cmdWatch();
  else if (cmd === 'ui') await cmdWatch({ ui: true });
  else if (cmd === 'q') await cmdQuery(rest.join(' '));
  else if (cmd === 'cart') await cmdCart(rest);
  else if (cmd === 'notify-test') await cmdNotifyTest();
  else if (cmd === 'browser') await cmdBrowser();
  else if (cmd === 'market') cmdMarket();
  else if (cmd === 'urls') cmdUrls();
  else if (cmd === 'ingest') await cmdIngest(rest);
  else console.log(HELP);
  saveWalmartHint();
  await quit(0);
} catch (err) {
  console.error(c.red(`錯誤: ${err.message}`));
  await quit(1);
}
