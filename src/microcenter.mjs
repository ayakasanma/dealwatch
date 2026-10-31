// Micro Center：搜尋頁的 product_wrapper 區塊與商品頁的 JSON-LD。直接請求一律 403，只能用瀏覽器載入；
// 價格與庫存以 config.microcenter.storeId 那家門市為準。
// 介面（src/monitor.mjs 會呼叫）：
//   configure({ browser, storeId, gapMs })
//   search({ query, minPrice, maxPrice }) -> { total, items }
//   product(productId) -> items   指定商品用，productId 是商品網址 /product/<productId>/ 那一段
import { Blocked, RequestError } from './http.mjs';

const BASE = 'https://www.microcenter.com';
const SEARCH_PATH = '/search/search_results.aspx';
const PAGE_SIZE = 96; // 站台支援的最大每頁筆數，減少翻頁
const BLOCKED_MESSAGE = 'Micro Center 要求人機驗證，請在 dealwatch 專用瀏覽器視窗手動完成';

let browser = null;
let storeId = '165';
let gapMs = 4000;
// 看到攔截頁時，隔這麼久再看一次，都還是攔截頁才算被擋
let recheckMs = [3000, 5000];
// 多個關鍵字會同時呼叫 search：所有載入排同一條佇列，並確保兩次載入間隔至少 gapMs
let gate = Promise.resolve();
let readyAt = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const plus = s => encodeURIComponent(String(s ?? '').trim()).replace(/%20/g, '+');

export function configure({ browser: b = null, storeId: sid = '165', gapMs: gap = 4000, recheckMs: recheck = [3000, 5000] } = {}) {
  browser = b;
  recheckMs = recheck;
  storeId = String(sid ?? '').trim() || '165';
  const n = Number(gap);
  gapMs = Number.isFinite(n) && n >= 0 ? n : 4000;
  gate = Promise.resolve();
  readyAt = 0;
}

// 依照佇列載入一頁；載入結束後才開始計算下一次可載入的時間
function load(url) {
  if (!browser) return Promise.reject(new RequestError('Micro Center 需要瀏覽器…', 'config'));
  const job = gate.then(async () => {
    const wait = readyAt - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await settled(await browser.html(url));
    } finally {
      readyAt = Date.now() + gapMs;
    }
  });
  gate = job.catch(() => {});
  return job;
}

// 攔截頁可能幾秒後自己換成正常頁面，等一下再判斷，不重新載入。一個查詢誤判會讓整輪作廢，還會叫人去按驗證
async function settled(html) {
  for (const ms of recheckMs) {
    if (!isBlockedPage(html) || !browser.currentHtml) break;
    await sleep(ms);
    html = await browser.currentHtml();
  }
  return html;
}

// 正常頁面也會載入 recaptcha / Cloudflare 腳本，所以不能只比對 captcha 或 challenge-platform；
// 只看 <title> 與頁面前段真正的人機驗證字樣。
const BLOCK_TITLE = /just a moment|access denied|pardon our interruption|attention required|verify you are human|security check|request blocked|too many requests/i;
const BLOCK_BODY = /access denied|pardon our interruption|verify you are human|enable javascript and cookies to continue|unusual traffic/i;

function isBlockedPage(html) {
  const s = String(html ?? '');
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1] ?? '';
  if (BLOCK_TITLE.test(title)) return true;
  return BLOCK_BODY.test(s.slice(0, 20000));
}

function assertNotBlocked(html) {
  if (isBlockedPage(html)) throw new Blocked(BLOCKED_MESSAGE);
}

async function holdForHuman() {
  if (!browser) return;
  browser.keepOpen = browser.hold = true;
  try { await browser.focus?.(); } catch { /* 取不到焦點不影響錯誤回報 */ }
}

async function fetchPage(url) {
  if (!browser) throw new RequestError('Micro Center 需要瀏覽器…', 'config');
  const html = await load(url);
  if (isBlockedPage(html)) {
    await holdForHuman();
    const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]).slice(0, 60);
    throw new Blocked(title ? `${BLOCKED_MESSAGE}（頁面標題：${title}）` : BLOCKED_MESSAGE);
  }
  browser.hold = false;
  return html;
}

const decode = s => String(s ?? '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"')
  .replace(/&#0*39;|&apos;/gi, "'")
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/\s+/g, ' ')
  .trim();

// 一般數字：data-price、strike 等
function amount(value) {
  const m = /(\d[\d,]*(?:\.\d+)?)/.exec(String(value ?? ''));
  if (!m) return undefined;
  const n = Number.parseFloat(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// 只抓 $ 後面的金額，避免把 "1 Open Box" 的 1 當成價格
function dollarAmount(value) {
  const m = /\$\s*([\d,]+(?:\.\d{1,2})?)/.exec(String(value ?? ''));
  return m ? amount(m[1]) : undefined;
}

function money(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : undefined;
  return amount(value);
}

function typeOf(category, core) {
  const c = String(category ?? '').trim();
  const k = String(core ?? '').trim();
  if (!k || /^undefined$/i.test(k)) return c;
  // data-core 常是 data-category 的重複（Graphics Cards / Desktops / Notebooks），不重複串接
  const word = k.split(/\s+/)[0].replace(/s$/i, '').toLowerCase();
  if (c.toLowerCase().includes(k.toLowerCase()) || (word && c.toLowerCase().includes(word))) return c;
  return `${c} ${k}`.trim();
}

// 標題已有品牌時不重複加
function withBrand(name, brand) {
  const n = String(name ?? '').trim();
  const b = String(brand ?? '').trim();
  if (!b || (n && n.toLowerCase().includes(b.toLowerCase()))) return n;
  return `${b} ${n}`.trim();
}

function conditionOf(name) {
  return /refurb|recondition|renewed/i.test(String(name ?? ''))
    ? { kind: 'refurb', cond: 'Refurb' }
    : { kind: 'new', cond: 'New' };
}

// ---------- 搜尋頁 ----------

export function searchUrl({ query = '', storeId: sid = storeId, openBox = false, page = 1 } = {}) {
  const parts = [
    `Ntt=${plus(query)}`,
    `storeid=${encodeURIComponent(String(sid ?? '').trim() || '165')}`,
    `rpp=${PAGE_SIZE}`,
    'sortby=newest',
    'myStore=false', // 含缺貨，才能回報 SOLD OUT；門市有貨才標 inStock
  ];
  const n = Number(page);
  if (Number.isInteger(n) && n > 1) parts.push(`page=${n}`);
  if (openBox) parts.push('fq=Valuable+Links:Open+Box');
  return `${BASE}${SEARCH_PATH}?${parts.join('&')}`;
}

function productBlocks(html) {
  return String(html).split(/<li id="pwrapper_\d+"[^>]*>/i).slice(1);
}

function stockText(block) {
  const m = /<div class="stock"[^>]*>([\s\S]*?)<\/div>\s*<div class="price"/i.exec(block);
  if (m) return decode(m[1]);
  // 少數版型沒有 price 區塊，退回找整段裡的庫存字樣
  return decode(/IN STOCK|SOLD OUT|NOT CARRIED|COMING SOON|OUT OF STOCK/i.exec(block)?.[0] ?? '');
}

function inStockFrom(text) {
  if (/SOLD OUT|NOT CARRIED|OUT OF STOCK|COMING SOON|UNAVAILABLE/i.test(text)) return false;
  return /IN STOCK/i.test(text);
}

// 搜尋頁的 open-box 價有兩種版型：
//   1. <div class="price-label compareTo">Open Box From $X</div>（只看 open-box 的篩選頁）
//   2. <div class="clearance">1 open box from $X</div>（一般搜尋頁，跟標準折扣一起出現）
function openBoxPrice(block) {
  const parts = [
    /<div class="price-label[^"]*compareTo"[^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1],
    /<div class="clearance"[^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1],
    /<span id="opCostNew"[^>]*>([\s\S]*?)<\/span>/i.exec(block)?.[1],
  ];
  for (const raw of parts) {
    if (!raw) continue;
    const t = decode(raw);
    if (!/open\s*box/i.test(t)) continue;
    const v = dollarAmount(t);
    if (v != null) return v;
  }
  // 文字被標籤拆開時的後備：抓 "open box ... from" 後面的一小段
  const m = /open\s*box[\s\S]{0,40}?from/i.exec(block);
  return m ? dollarAmount(decode(block.slice(m.index, m.index + 300))) : undefined;
}

// 回傳一個商品可能有的 1~2 筆（新品 + open-box）
function parseBlock(block) {
  const id = /data-id="(\d+)"/i.exec(block)?.[1];
  if (!id) return [];
  const brand = decode(/data-brand="([^"]*)"/i.exec(block)?.[1] ?? '');
  const name = withBrand(decode(/data-name="([^"]*)"/i.exec(block)?.[1] ?? ''), brand);
  if (!name) return [];
  const category = decode(/data-category="([^"]*)"/i.exec(block)?.[1] ?? '').split('|')[0].trim();
  const core = decode(/data-core="([^"]*)"/i.exec(block)?.[1] ?? '');
  const type = typeOf(category, core);
  const sku = /SKU:\s*(\d+)/i.exec(block)?.[1] ?? '';

  const priceText = /data-price="([^"]*)"/i.exec(block)?.[1];
  let price = money(priceText);
  if (price == null) {
    const shown = /<div class="price"[^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1];
    price = amount(decode(shown ?? ''));
  }
  if (price == null) return [];

  const strike = /<strike>([\s\S]*?)<\/strike>/i.exec(block)?.[1];
  const list = strike ? amount(decode(strike)) : undefined;
  const ref = list != null && list > price ? list : undefined;

  const stock = stockText(block);
  const inStock = inStockFrom(stock);
  const pickupOnly = /Matrix-PickupOnly/i.test(block) || /In Store Only/i.test(block);
  const link = /href="\/product\/(\d+)\/([^"?#]*)"/i.exec(block);
  const url = link ? `${BASE}/product/${link[1]}/${link[2]}` : `${BASE}/product/${id}/x`;

  const { kind, cond } = conditionOf(name);
  const items = [{
    store: 'mc',
    id,
    key: `mc:${id}`,
    kind,
    cond,
    name,
    type,
    brand,
    sku,
    seller: 'Micro Center',
    price,
    ref,
    inStock,
    pickupOnly,
    url,
    cartUrl: null,
  }];

  const obPrice = openBoxPrice(block);
  if (obPrice != null) {
    items.push({
      store: 'mc',
      id,
      key: `mc:${id}:ob`,
      kind: 'ob',
      cond: 'Open-Box',
      name,
      type,
      brand,
      sku,
      seller: 'Micro Center',
      price: obPrice,
      ref: price > obPrice ? price : undefined,
      inStock: true,
      pickupOnly,
      url,
      cartUrl: null,
    });
  }
  return items;
}

function totalOf(html, count) {
  const m = /<div class="searchInfoBar"[^>]*>\s*([\d,]+)\s+Results?/i.exec(html)
    ?? /<span class="productSearchCount"[^>]*>\s*([\d,]+)/i.exec(html);
  return m ? Number(m[1].replace(/,/g, '')) : count;
}

function openBoxCountOf(html) {
  const m = /Open Box\s*\((\d+)\)/i.exec(String(html ?? ''));
  return m ? Number(m[1]) : 0;
}

export function parseSearch(html) {
  assertNotBlocked(html);
  const s = String(html ?? '');
  const items = [];
  const seen = new Set();
  for (const block of productBlocks(s)) {
    for (const item of parseBlock(block)) {
      if (seen.has(item.key)) continue;
      seen.add(item.key);
      items.push(item);
    }
  }
  const hasMarkers = /<div class="searchInfoBar"|<span class="productSearchCount"/i.test(s);
  if (!hasMarkers && !items.length) throw new RequestError('Micro Center 搜尋頁格式不符', 'format');
  return { total: totalOf(s, items.length), items };
}

function mergeItems(base, extra) {
  const seen = new Set(base.map(i => i.key));
  for (const item of extra) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    base.push(item);
  }
  return base;
}

export async function search({ query, minPrice, maxPrice } = {}) {
  const firstHtml = await fetchPage(searchUrl({ query }));
  const { total, items } = parseSearch(firstHtml);
  let all = items;
  // 一般搜尋頁已經會出現部分 open-box 價；只有還沒看齊站方公告的數量時，才多載一頁「只看 open-box」
  const seenOb = items.filter(i => i.kind === 'ob').length;
  if (seenOb < openBoxCountOf(firstHtml)) {
    const obHtml = await fetchPage(searchUrl({ query, openBox: true }));
    all = mergeItems(all, parseSearch(obHtml).items);
  }
  // 價格條件在本地過濾
  return {
    total,
    items: all.filter(i => (minPrice == null || i.price >= minPrice) && (maxPrice == null || i.price <= maxPrice)),
  };
}

// ---------- 商品頁 ----------

function ldProduct(html) {
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of String(html).matchAll(re)) {
    let data;
    try { data = JSON.parse(m[1]); } catch { continue; }
    const nodes = Array.isArray(data) ? data : Array.isArray(data?.['@graph']) ? data['@graph'] : [data];
    const product = nodes.find(n => n && (n['@type'] === 'Product' || (Array.isArray(n['@type']) && n['@type'].includes('Product'))));
    if (product) return { product, nodes };
  }
  return null;
}

function offerOf(product) {
  const offers = Array.isArray(product.offers) ? product.offers : [product.offers];
  return offers.find(o => o && (o.price != null || o.availability)) ?? {};
}

function productUrl(id) {
  return `${BASE}/product/${encodeURIComponent(String(id ?? '').trim())}/x?storeid=${encodeURIComponent(storeId)}`;
}

export function parseProduct(html, id) {
  assertNotBlocked(html);
  const s = String(html ?? '');
  const ld = ldProduct(s);
  if (!ld) return [];
  const { product, nodes } = ld;
  const pid = String(id ?? '').trim() || /\/product\/(\d+)/.exec(String(product['@id'] ?? ''))?.[1] || '';
  if (!pid) return [];

  // 商品頁的 <h1> 也帶 data-name / data-brand / data-category，跟搜尋頁同一種格式；
  // 它通常比 JSON-LD 的 name 完整（JSON-LD 有時只有 "ASUS ROG G1000 Gaming PC"）。
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(s)?.[1] ?? '';
  const h1Name = /data-name="([^"]*)"/i.exec(h1)?.[1];
  const h1Brand = /data-brand="([^"]*)"/i.exec(h1)?.[1];
  const h1Category = decode(/data-category="([^"]*)"/i.exec(h1)?.[1] ?? '').split('|')[0].trim();

  const brand = decode(h1Brand ?? product.brand?.name ?? '');
  const name = withBrand(decode(h1Name ?? product.name ?? ''), brand);
  if (!name) return [];

  const offer = offerOf(product);
  const price = money(offer.price) ?? money(/data-price="([^"]*)"/i.exec(h1)?.[1]);
  if (price == null) return [];
  const availability = String(offer.availability ?? '');

  // 商品頁的庫存字樣：NEW IN STOCK 或 SOLD OUT
  const inventory = /<div id="pnlInventory"[^>]*>([\s\S]*?)<!--\s*links/i.exec(s)?.[1]
    ?? /<div class="inventory"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i.exec(s)?.[1] ?? '';
  const stock = decode(inventory);
  const inStock = /InStock|LimitedAvailability|PreOrder|BackOrder/i.test(availability)
    ? true
    : /OutOfStock|SoldOut|Discontinued/i.test(availability)
      ? false
      : /IN STOCK/i.test(stock) && !/SOLD OUT|OUT OF STOCK/i.test(stock);

  // 主價格區的劃線價（standardDiscount）；配件區也有 strike，所以只取 options-savings 到 options-pricing 之間
  const priceArea = /id="options-savings2022"([\s\S]*?)(?:id="options-pricing2022"|<p class="big-price")/i.exec(s)?.[1]
    ?? /<div class="standardDiscount"[^>]*>([\s\S]*?)<\/div>/i.exec(s)?.[0] ?? '';
  const discount = /<div class="standardDiscount"[^>]*>([\s\S]*?)<\/div>/i.exec(priceArea)?.[1];
  const list = discount ? amount(decode(/<strike>([\s\S]*?)<\/strike>/i.exec(discount)?.[1] ?? '')) : undefined;
  const ref = list != null && list > price ? list : undefined;

  // 分類：麵包屑倒數第二層（最後一層是商品名）
  const breadcrumb = nodes.find(n => n && n['@type'] === 'BreadcrumbList');
  const names = (breadcrumb?.itemListElement ?? []).map(e => String(e?.name ?? '').trim()).filter(Boolean);
  let type = names.length >= 2 ? names[names.length - 2] : '';
  if (!type || /^home$/i.test(type)) {
    type = h1Category || decode(/data-category="([^"]*)"/i.exec(s)?.[1] ?? '').split('|')[0].trim();
  }

  // 頁面上的 SKU 有前導零（072769），JSON-LD 的 sku 會變成 72769
  // span 裡包著 <strong>SKU: </strong>，先去掉標籤再抓數字
  const skuSpan = /<span class="[^"]*\bsku\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(s)?.[1];
  const sku = (skuSpan && /SKU:\s*([0-9]+)/i.exec(decode(skuSpan))?.[1])
    || String(product.sku ?? '').trim();

  // AvailabilityCode 只出現在商品頁的 dataLayer：Pickup Only 或 Usually ships...
  const code = /'AvailabilityCode'\s*:\s*'([^']*)'/i.exec(s)?.[1] ?? '';
  const pickupOnly = /pickup only/i.test(code)
    ? true
    : /ship/i.test(code)
      ? false
      : !/ship-container|Ship This Item|class="shippingOption/i.test(s);

  const condition = String(offer.itemCondition ?? '');
  const refurb = /refurb|recondition/i.test(name) || /UsedCondition|RefurbishedCondition/i.test(condition);
  const kind = refurb ? 'refurb' : 'new';
  const cond = refurb ? 'Refurb' : 'New';

  const canonical = /<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i.exec(s)?.[1];
  const url = (canonical ? decode(canonical) : '') || String(product['@id'] ?? '').split('#')[0] || `${BASE}/product/${pid}/x`;

  const items = [{
    store: 'mc',
    id: pid,
    key: `mc:${pid}`,
    kind,
    cond,
    name,
    type,
    brand,
    sku,
    seller: 'Micro Center',
    price,
    ref,
    inStock,
    pickupOnly,
    url,
    cartUrl: null,
  }];

  // 商品頁的 open-box：<div class="openboxOptions">…1 Open Box: from $X…
  const obBlock = /<div class="openboxOptions"[^>]*>([\s\S]*?)<\/div>/i.exec(s)?.[1];
  const obPrice = obBlock ? dollarAmount(decode(obBlock)) : undefined;
  if (obPrice != null) {
    items.push({
      store: 'mc',
      id: pid,
      key: `mc:${pid}:ob`,
      kind: 'ob',
      cond: 'Open-Box',
      name,
      type,
      brand,
      sku,
      seller: 'Micro Center',
      price: obPrice,
      ref: price > obPrice ? price : undefined,
      inStock: true,
      pickupOnly: true,
      url,
      cartUrl: null,
    });
  }
  return items;
}

export async function product(productId) {
  const id = String(productId ?? '').trim();
  if (!id) return [];
  return parseProduct(await fetchPage(productUrl(id)), id);
}
