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

export async function search(opts) {
  const url = searchUrl(opts);
  const result = items => ({ total: items.length, items });
  if (!viaBrowser) {
    try { return result(parse(await httpHtml(url))); }
    catch (err) {
      if (!(err instanceof Blocked) || mode !== 'auto' || !browser) throw err;
      viaBrowser = true; // 直接請求被擋，這次執行接下來都改走瀏覽器
    }
  }
  try { return result(parse(await browserHtml(url))); }
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

// 解析一頁搜尋結果 HTML（也給 ingest 指令用，來源可以是瀏覽器另存的網頁）
export function parse(html) {
  if (html.includes('Robot or human?')) throw new Blocked('Walmart 要求人機驗證');
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('Walmart 頁面格式不符（找不到 __NEXT_DATA__）');
  const stacks = JSON.parse(m[1]).props?.pageProps?.initialData?.searchResult?.itemStacks ?? [];
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
