// Walmart：抓搜尋頁內嵌的 __NEXT_DATA__ JSON。sort=new 就是「最新上架」排序。
import { get, Blocked } from './http.mjs';

// 指定 offerId 才能鎖定搜尋結果看到的那個賣家；只給 itemId 會加入當下 buy box 的賣家
export const cartUrl = ({ id, offerId }) =>
  `https://affil.walmart.com/cart/addToCart?${offerId ? `offers=${offerId}` : `items=${id}`}%7C1`;

const money = s => (typeof s === 'number' ? s : parseFloat(String(s ?? '').replace(/[^0-9.]/g, ''))) || undefined;

export function searchUrl({ query, sort = 'new', page = 1, minPrice, maxPrice }) {
  const u = new URL('https://www.walmart.com/search');
  u.searchParams.set('q', query);
  if (sort) u.searchParams.set('sort', sort);
  if (page > 1) u.searchParams.set('page', page);
  if (minPrice) u.searchParams.set('min_price', minPrice);
  if (maxPrice) u.searchParams.set('max_price', maxPrice);
  return u.href;
}

// 取得頁面的兩條路：直接 HTTP 請求（快），或請一個真正的瀏覽器視窗載入（慢但不會被當成自動化流量）。
// via: 'http' 只用 HTTP；'browser' 只用瀏覽器；'auto' 先試 HTTP，被擋就改用瀏覽器。
let mode = 'http', browser = null, viaBrowser = false;
const httpBlocked = { search: false, product: false };
let queue = Promise.resolve();

export function configure({ via = 'auto', browser: b = null, startInBrowser = false } = {}) {
  mode = via;
  browser = b;
  viaBrowser = !!b && (via === 'browser' || (via === 'auto' && startInBrowser));
}

export const usingBrowser = () => viaBrowser;

async function httpHtml(url) {
  const { status, body } = await get('wm', url, { timeout: 15000 });
  if (status === 403 || status === 412 || status === 429) throw new Blocked(`Walmart 拒絕請求 (HTTP ${status}，被判定為自動化流量)`);
  return body;
}

// 瀏覽器只有一個分頁，一頁一頁慢慢載
function browserHtml(url) {
  const job = queue.then(async () => {
    const html = await browser.html(url);
    await new Promise(r => setTimeout(r, 800 + Math.random() * 1200));
    return html;
  });
  queue = job.catch(() => {});
  return job;
}

// 抓一頁並解析：先直接請求，被擋就改用瀏覽器。搜尋頁和商品頁被擋的情況不一樣，分開記。
async function load(kind, url, parser) {
  if (!viaBrowser && !httpBlocked[kind]) {
    try { return parser(await httpHtml(url)); }
    catch (err) {
      if (!(err instanceof Blocked) || mode !== 'auto' || !browser) throw err;
      // 直接請求被擋，這次執行接下來這類頁面都改走瀏覽器
      httpBlocked[kind] = true;
      if (kind === 'search') viaBrowser = true;
    }
  }
  try { return parser(await browserHtml(url)); }
  catch (err) {
    if (!(err instanceof Blocked)) throw err;
    // 視窗留著並帶到最前面，等你親手通過驗證；通過後下一輪就會恢復
    browser.keepOpen = true;
    await browser.focus();
    throw new Blocked(browser.remote
      ? 'Walmart 在瀏覽器裡要求人機驗證，請從網頁介面開啟遠端瀏覽器視窗手動完成（按住按鈕那種）'
      : 'Walmart 在瀏覽器裡要求人機驗證，請到 dealwatch 開的那個瀏覽器視窗手動完成（按住按鈕那種）');
  }
}

export async function search(opts) {
  const items = await load('search', searchUrl(opts), parse);
  return { total: items.length, items };
}

// 直接查單一商品頁（指定商品清單用）。缺貨也會回傳，inStock 為 false
export const product = id => load('product', `https://www.walmart.com/ip/${id}`, parseProduct);

function nextData(html) {
  if (html.includes('Robot or human?')) throw new Blocked('Walmart 要求人機驗證');
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('Walmart 頁面格式不符（找不到 __NEXT_DATA__）');
  return JSON.parse(m[1]).props?.pageProps?.initialData;
}

function parseProduct(html) {
  const p = nextData(html)?.data?.product;
  if (!p?.usItemId) return [];
  const used = p.conditionType && !/new/i.test(p.conditionType);
  return [{
    store: 'wm',
    id: p.usItemId,
    key: `wm:${p.usItemId}`,
    kind: used ? 'refurb' : 'new',
    cond: used ? 'Restored' : 'New',
    name: p.name ?? '',
    type: p.type ?? '',
    seller: p.sellerDisplayName ?? p.sellerName ?? '?',
    price: p.priceInfo?.currentPrice?.price,
    ref: p.priceInfo?.wasPrice?.price,
    inStock: p.availabilityStatus === 'IN_STOCK',
    offerId: p.offerId,
    url: `https://www.walmart.com/ip/${p.usItemId}`,
    cartUrl: cartUrl({ id: p.usItemId, offerId: p.offerId }),
  }];
}

// 解析一頁搜尋結果 HTML（也給 ingest 指令用，來源可以是瀏覽器另存的網頁）
export function parse(html) {
  const stacks = nextData(html)?.searchResult?.itemStacks ?? [];
  return stacks.flatMap(s => s.items ?? []).filter(i => i.__typename === 'Product' && i.usItemId).map(normalize);
}

function normalize(i) {
  const used = i.conditionV2 && i.conditionV2.groupCode !== 1;
  return {
    store: 'wm',
    id: i.usItemId,
    key: `wm:${i.usItemId}`,
    kind: used ? 'refurb' : 'new',
    cond: used ? 'Restored' : 'New',
    name: i.name ?? '',
    type: i.catalogProductType ?? '',
    seller: i.sellerName ?? '?',
    price: i.price,
    ref: money(i.priceInfo?.wasPrice),
    inStock: i.availabilityStatusV2?.value === 'IN_STOCK' && i.canAddToCart !== false,
    sponsored: !!i.isSponsoredFlag,
    offerId: i.offerId,
    url: `https://www.walmart.com/ip/${i.usItemId}`,
    cartUrl: cartUrl({ id: i.usItemId, offerId: i.offerId }),
  };
}
