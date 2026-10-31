// eBay：直購（Buy It Now）搜尋結果。直接請求一律 403，只能用瀏覽器載入。
// 介面（src/monitor.mjs 會呼叫）：
//   configure({ browser, conditions, usOnly, gapMs, ... })
//   search({ query, minPrice, maxPrice, category }) -> { total, items }
//   product(itemId) -> items      指定商品用，itemId 是商品網址 /itm/<itemId> 那一段
import { Blocked, RequestError } from './http.mjs';
import { usdRate } from './fx.mjs';

const BASE = 'https://www.ebay.com';
const PAGE_SIZE = 120;

// 狀況名稱 → eBay 的 LH_ItemCondition 代號
const CONDITION_CODES = {
  New: ['1000'],
  'Open-Box': ['1500'],
  Refurbished: ['2010', '2020', '2030', '2500'],
  Used: ['3000'],
};
const CONDITION_ORDER = Object.keys(CONDITION_CODES);

// 分類代號 → 商品類型（config.categories[*].type 的正規式要能比對）
const CATEGORY_TYPES = {
  27386: 'graphics card',
  177: 'laptop',
  179: 'desktop gaming pc',
  164: 'processor',
  170083: 'memory',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 只留數字（可含小數點）。$0 不算價格
const money = v => {
  if (v == null) return undefined;
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
// 運費可以是 0
const amount = v => {
  if (v == null) return undefined;
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

// eBay 依連線的國家顯示當地幣別（例如 NT$ 74,975），數字前面的符號決定幣別。
// 不認得的符號原樣傳下去，換算時找不到匯率就報錯，不會被當成美金。
const CURRENCIES = { $: 'USD', US$: 'USD', NT$: 'TWD', C$: 'CAD', CA$: 'CAD', AU$: 'AUD', A$: 'AUD', HK$: 'HKD', S$: 'SGD', '£': 'GBP', '€': 'EUR', '¥': 'JPY', 'JP¥': 'JPY' };
export function currencyOf(priceText) {
  const symbol = /^[^\d]*/.exec(String(priceText ?? '').trim())[0].replace(/\s/g, '');
  return CURRENCIES[symbol] ?? symbol;
}
// 任何幣別符號加金額（+$16.64、+NT$ 384、Was: C $100.00），金額在第一個群組
const MONEY = String.raw`(?:[A-Z]{0,3}\s*[$£€¥]|[A-Z]{3}\s)\s*([\d,]+(?:\.\d+)?)`;
const SHIPPING_FEE = new RegExp(String.raw`\+\s*${MONEY}\s*(?:delivery|shipping)`, 'i');
const WAS_PRICE = new RegExp(String.raw`(?:Was|Previous price|List price)[:\s]*${MONEY}`, 'i');

const decode = s => String(s ?? '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

const stripTags = s => String(s ?? '')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<[^>]*>/g, ' ');

const textOf = s => decode(stripTags(s)).replace(/\s+/g, ' ').trim();

// 評價數可能寫成 6.9K / 1.2M
function feedbackCount(raw) {
  const m = /^\s*([\d.,]+)\s*([KkMm])?/.exec(String(raw ?? ''));
  if (!m) return undefined;
  let n = Number.parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return undefined;
  if (m[2]) n *= /k/i.test(m[2]) ? 1e3 : 1e6;
  return Math.round(n);
}

// 「Brand New」「Open Box」「Pre-Owned」「Certified - Refurbished」…
function conditionOf(raw) {
  const s = String(raw ?? '').toLowerCase();
  if (!s) return null;
  // "New (Other)" 是舊分類的 open-box
  if (/new\s*\(other\)/.test(s)) return { kind: 'ob', cond: 'Open-Box' };
  if (/open[\s-]*box/.test(s)) return { kind: 'ob', cond: 'Open-Box' };
  if (/refurb|recondition|renewed/.test(s)) return { kind: 'refurb', cond: 'Refurb' };
  if (/pre-?owned|\bused\b|for parts/.test(s)) return { kind: 'refurb', cond: 'Used' };
  if (/\bnew\b/.test(s)) return { kind: 'new', cond: 'New' };
  return null;
}

// 沒有分類代號時從標題猜類型。只回一個主要類型，避免「Desktop Memory」同時被當成桌機。
function typeOf(title) {
  const t = String(title ?? '');
  if (/laptop|notebook/i.test(t)) return 'laptop';
  if (/\b(?:memory|ram)\b|\bddr[45]\b/i.test(t)) return 'memory';
  if (/(?:geforce|radeon)\b|\b(?:rtx|gtx|rx)[\s-]*\d{3,4}\b/i.test(t)) return 'graphics card';
  if (/\b(?:processor|cpu)\b/i.test(t) && !/food processor/i.test(t)) return 'processor';
  if (/desktop|gaming pc|tower/i.test(t)) return 'desktop gaming pc';
  return '';
}

function makeItem({ id, name, category, kind, cond, seller, feedbackPct, feedbackCount: count, itemPrice, shipping, currency = 'USD', ref, bestOffer, listedAt, inStock }) {
  const type = CATEGORY_TYPES[category] ?? typeOf(name);
  return {
    store: 'eb',
    id,
    key: `eb:${id}`,
    kind,
    cond,
    name,
    type,
    seller,
    feedbackPct,
    feedbackCount: count,
    price: itemPrice + (shipping ?? 0),
    itemPrice,
    shipping,
    currency,
    ref,
    bestOffer: !!bestOffer,
    inStock: inStock !== false,
    listedAt,
    url: `${BASE}/itm/${id}`,
    cartUrl: null,
  };
}

// ---- 瀏覽器載入與節流 ----

let browser = null;
let conditions = [...CONDITION_ORDER];
let usOnly = false;
let gapMs = 10000;
let chain = Promise.resolve();
let lastLoad = 0;
let shownRate = 1; // eBay 最近顯示的幣別對美金的匯率

export function configure({ browser: b, conditions: c, usOnly: u, gapMs: g } = {}) {
  shownRate = 1;
  if (b !== undefined) browser = b;
  if (Array.isArray(c)) conditions = c;
  if (typeof u === 'boolean') usOnly = u;
  if (Number.isFinite(g) && g >= 0) gapMs = g;
}

const titleOf = html => /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
const isErrorPage = html => /error\s*page/i.test(titleOf(html));
const isChallenge = html => /Pardon Our Interruption|Security Measure|Please verify yourself|Are you a human/i.test(html);

// 所有載入排隊，兩次之間至少隔 gapMs
function loadPage(url) {
  const job = chain.then(async () => {
    const wait = lastLoad + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastLoad = Date.now();
    return browser.html(url);
  });
  chain = job.catch(() => {});
  return job;
}

async function challenge() {
  if (browser) {
    // 絕對不嘗試破解：留著頁面、帶到最前面，交給人處理
    browser.keepOpen = browser.hold = true;
    await browser.focus().catch(() => {});
  }
  throw new Blocked('eBay 要求人機驗證，請在 dealwatch 專用瀏覽器視窗手動完成');
}

async function load(url) {
  for (let attempt = 0; ; attempt++) {
    const html = await loadPage(url);
    if (isChallenge(html)) await challenge();
    if (isErrorPage(html)) {
      if (attempt === 0) {
        // 短時間內連續載入會回錯誤頁：隔 gapMs 再試一次
        await sleep(gapMs);
        continue;
      }
      throw new Blocked('eBay 回錯誤頁（請求太密）');
    }
    if (browser) browser.hold = false;
    return html;
  }
}

// ---- 搜尋 ----

export function searchUrl({ query, minPrice, maxPrice, category, conditions: conds, usOnly: us } = {}) {
  const u = new URL(`${BASE}/sch/i.html`);
  u.searchParams.set('_nkw', String(query ?? ''));
  u.searchParams.set('_sop', '10');
  u.searchParams.set('LH_BIN', '1');
  const list = Array.isArray(conds) ? conds : conditions;
  const codes = CONDITION_ORDER.filter(c => list.includes(c)).flatMap(c => CONDITION_CODES[c]);
  if (codes.length) u.searchParams.set('LH_ItemCondition', codes.join('|'));
  if (category != null && category !== '') u.searchParams.set('_sacat', String(category));
  if (minPrice != null) u.searchParams.set('_udlo', String(minPrice));
  if (maxPrice != null) u.searchParams.set('_udhi', String(maxPrice));
  if (typeof us === 'boolean' ? us : usOnly) u.searchParams.set('LH_PrefLoc', '1');
  u.searchParams.set('_ipg', String(PAGE_SIZE));
  return u.href;
}

function totalOf(html, fallback) {
  const heading = /class="srp-controls__count-heading"[^>]*>([\s\S]*?)<\/h1>/i.exec(html)
    ?? /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (heading) {
    const t = textOf(heading[1]);
    if (/no results|did not match/i.test(t)) return 0;
    const n = /([\d,]+)\s*results/i.exec(t);
    if (n) return Number.parseInt(n[1].replace(/,/g, ''), 10);
  }
  return fallback;
}

// 卡片：前面會有兩張「Shop on eBay」假卡片（href itm/123456、listing id 很長）
export function parseSearch(html, category) {
  const items = [];
  const tags = [...String(html).matchAll(/<li\b[^>]*\bdata-listingid="(\d+)"[^>]*>/gi)];
  for (let i = 0; i < tags.length; i++) {
    if (!/\bs-card\b/.test(tags[i][0])) continue;
    // 最後一張卡片後面接的是整頁頁尾／腳本，切一個合理上限避免誤抓
    const end = Math.min(tags[i + 1]?.index ?? String(html).length, tags[i].index + 60000);
    const block = String(html).slice(tags[i].index, end);
    const item = cardItem(block, tags[i][1], category);
    if (item) items.push(item);
  }
  return { total: totalOf(html, items.length), items };
}

function cardItem(block, id, category) {
  // 假卡片
  if (/\/itm\/123456(?:[?"&]|$)/.test(block)) return null;

  const titleHtml = /class="[^"]*\bs-card__title\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1] ?? '';
  const name = textOf(titleHtml
    .replace(/<span[^>]*>\s*New Listing\s*<\/span>/gi, ' ')
    .replace(/<span[^>]*>\s*Opens in a new window or tab\s*<\/span>/gi, ' '));
  if (!name || /^shop on ebay$/i.test(name)) return null;

  const priceText = textOf(/class="[^"]*\bs-card__price\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(block)?.[1] ?? '');
  // 多規格價格區間（$100.00 to $200.00）整筆略過，免得用最低價誤判
  if (/\bto\b/i.test(priceText)) return null;
  const itemPrice = money(priceText);
  if (itemPrice == null) return null;

  const flat = textOf(block);
  // s-card__subtitle-row 是外層容器，不能一起抓
  const subtitles = [...block.matchAll(/class="[^"]*\bs-card__subtitle\b(?!-)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)].map(m => textOf(m[1]));
  const conditionText = subtitles.find(s => conditionOf(s)) ?? '';
  const { kind, cond } = conditionOf(conditionText) ?? { kind: 'new', cond: 'New' };

  const fb = /([A-Za-z0-9._*-]+)\s+([\d.]+)%\s*positive\s*\(([^)]+)\)/i.exec(flat);
  const seller = fb?.[1];
  const feedbackPct = fb ? Number.parseFloat(fb[2]) : undefined;

  const plus = SHIPPING_FEE.exec(flat);
  const shipping = plus ? amount(plus[1]) : /Free\s+(?:delivery|shipping)/i.test(flat) ? 0 : undefined;

  const was = WAS_PRICE.exec(flat);
  const ref = was ? money(was[1]) : undefined;

  const listedAt = /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{1,2}\s+\d{1,2}:\d{2})\b/.exec(flat)?.[1];

  return makeItem({
    id,
    name,
    category,
    kind,
    cond,
    seller,
    feedbackPct: Number.isFinite(feedbackPct) ? feedbackPct : undefined,
    feedbackCount: fb ? feedbackCount(fb[3]) : undefined,
    itemPrice,
    shipping,
    currency: currencyOf(priceText),
    ref: ref != null && ref > itemPrice ? ref : undefined,
    bestOffer: /or Best Offer/i.test(flat),
    listedAt,
    inStock: true,
  });
}

// 當地幣別的價格換算成美金，之後的比價、過濾和通知都用美金
async function inUsd(item) {
  const rate = await usdRate(item.currency);
  if (rate === 1) return item;
  const usd = v => (v == null ? v : Math.round(v / rate * 100) / 100);
  return { ...item, currency: 'USD', price: usd(item.price), itemPrice: usd(item.itemPrice), shipping: usd(item.shipping), ref: usd(item.ref) };
}

export async function search({ query, minPrice, maxPrice, category } = {}) {
  if (!browser) throw new RequestError('eBay 需要瀏覽器…', 'config');
  // 網址裡的價格範圍也是當地幣別，用上一頁看到的幣別換算
  const local = v => (v == null ? v : Math.round(v * shownRate));
  const html = await load(searchUrl({ query, minPrice: local(minPrice), maxPrice: local(maxPrice), category }));
  const { total, items: shown } = parseSearch(html, category);
  const items = await Promise.all(shown.map(inUsd));
  if (shown.length) shownRate = await usdRate(shown[0].currency);
  // 價格在本地再過濾一次（用商品價，不含運費）
  return {
    total,
    items: items.filter(i => (minPrice == null || i.itemPrice >= minPrice) && (maxPrice == null || i.itemPrice <= maxPrice)),
  };
}

// ---- 單品 ----

function productData(html) {
  for (const m of String(html).matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(m[1]);
      for (const d of Array.isArray(parsed) ? parsed : [parsed]) {
        if (d && typeof d === 'object' && (d['@type'] === 'Product' || d.offers)) return d;
      }
    } catch { /* 壞掉的 JSON-LD 跳過 */ }
  }
  return null;
}

const visibleText = html => textOf(String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' '));

function visibleCondition(html) {
  return textOf(/class="x-item-condition-text"[\s\S]{0,600}?<span class="ux-textspans">([^<]+)/i.exec(html)?.[1] ?? '')
    || textOf(/Condition:\s*([^<]{1,60})/i.exec(visibleText(html))?.[1] ?? '');
}

function schemaCondition(raw) {
  const s = String(raw ?? '');
  if (/NewCondition/i.test(s)) return { kind: 'new', cond: 'New' };
  if (/RefurbishedCondition/i.test(s)) return { kind: 'refurb', cond: 'Refurb' };
  if (/UsedCondition|DamagedCondition/i.test(s)) return { kind: 'refurb', cond: 'Used' };
  return null;
}

export function parseItem(html, id) {
  id = String(id ?? '').trim();
  if (!id) return [];
  const data = productData(html);
  const offer = (Array.isArray(data?.offers) ? data.offers[0] : data?.offers) ?? {};
  const visible = visibleText(html);

  const name = textOf(data?.name ?? '') || textOf(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? '')
    || textOf(titleOf(html)).replace(/\s*\|\s*eBay\s*$/i, '');
  const itemPrice = money(offer.price)
    ?? money(/class="x-price-primary"[\s\S]{0,400}?US\s*\$([\d,]+(?:\.\d+)?)/i.exec(html)?.[1])
    ?? money(/US\s*\$([\d,]+(?:\.\d+)?)/.exec(visible)?.[1]);
  if (!name || itemPrice == null) return [];

  const condition = conditionOf(visibleCondition(html)) ?? schemaCondition(offer.itemCondition) ?? { kind: 'new', cond: 'New' };

  const shippingRaw = (Array.isArray(offer.shippingDetails) ? offer.shippingDetails[0] : offer.shippingDetails)?.shippingRate?.value;
  let shipping = amount(shippingRaw);
  if (shipping === undefined) {
    if (/Shipping:\s*Free/i.test(visible)) shipping = 0;
    else {
      const m = /(?:Shipping:\s*)?\+\s*\$([\d,]+(?:\.\d+)?)/i.exec(visible);
      if (m) shipping = amount(m[1]);
    }
  }

  const availability = String(offer.availability ?? '');
  const ended = /The listing you're looking for has ended|This listing (?:was )?ended|listing has ended|no longer available/i.test(visible);
  const inStock = /InStock|LimitedAvailability/i.test(availability) ? true
    : /OutOfStock|SoldOut/i.test(availability) ? false
    : !ended;

  // 賣家帳號（顯示名稱不一定是帳號，從 follow 連結的 entity id 拿）
  const seller = /entity_id=%7E([A-Za-z0-9._*-]+)/i.exec(html)?.[1]
    ?? /"entityId":"~([A-Za-z0-9._*-]+)"/.exec(html)?.[1]
    ?? /\/str\/([A-Za-z0-9._*-]+)/i.exec(html)?.[1];
  const pct = /([\d.]+)%\s*positive/i.exec(visible)?.[1];
  const sellerBlock = /x-sellercard-atf__about-seller([\s\S]{0,2000})/i.exec(html)?.[1] ?? '';

  return [makeItem({
    id,
    name,
    category: undefined,
    ...condition,
    seller,
    feedbackPct: pct ? Number.parseFloat(pct) : undefined,
    feedbackCount: feedbackCount(/\(([\d.,]+[KkMm]?)\)/.exec(sellerBlock)?.[1]),
    itemPrice,
    shipping,
    currency: offer.priceCurrency || 'USD',
    ref: undefined,
    bestOffer: /or Best Offer/i.test(visible.slice(0, 8000)),
    listedAt: data?.offers?.availabilityStarts ?? undefined,
    inStock,
  })];
}

export async function product(itemId) {
  const id = String(itemId ?? '').trim();
  if (!id) return [];
  if (!browser) throw new RequestError('eBay 需要瀏覽器…', 'config');
  const html = await load(`${BASE}/itm/${encodeURIComponent(id)}`);
  return Promise.all(parseItem(html, id).map(inUsd));
}
