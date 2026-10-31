// Slickdeals：關鍵字搜尋的 RSS。商品在別家店賣，seller 是那家店。
// 搜尋 RSS 在 Cloudflare 後面，部分連線（例如從 NAS）會被擋（403）。這時改讀 Slickdeals 發布在 FeedBurner 的官方 feed：
// 格式跟搜尋 RSS 一樣，但只有首頁精選與 Hot Deals 討論區各最新 25 則、不能搜尋，所以抓回來自己比對標題。
// 介面（src/monitor.mjs 會呼叫）：search({ query, minPrice, maxPrice }, httpOptions) -> { total, items }
import config from '../config.mjs';
import { get, Blocked, requireSuccess } from './http.mjs';
import {
  xmlTag, decodeEntities, cleanText, cleanName, stripUtm, isoDate,
  slickdealsPrice, originalPrice, kindOf, inStockOf, typeOf, bracketOf,
  sellerFromTitle, sellerFromText, storeFromSlug,
} from './feed.mjs';

const ENDPOINT = 'https://slickdeals.net/newsearch.php';
const OFFICIAL_FEEDS = [
  'https://feeds.feedburner.com/SlickdealsnetFP',
  'https://feeds.feedburner.com/SlickdealsnetForums-9',
];
const MAX_AGE_HOURS = config.feeds?.maxAgeHours ?? 48;
const SEARCH_BLOCK_MS = 6 * 36e5; // 搜尋被擋過就記 6 小時，這段時間直接讀官方 feed，不再去敲 Cloudflare
const FEED_TTL = 60e3; // 同一輪的關鍵字共用一次抓取

let searchBlockedUntil = 0;
let queue = Promise.resolve();
let feedCache = null; // { t, items }
let feedJob = null; // 進行中的抓取

// 測試用：清掉快取與被擋的記憶
export function resetCache() {
  searchBlockedUntil = 0;
  queue = Promise.resolve();
  feedCache = null;
  feedJob = null;
}

export const usingOfficialFeeds = () => Date.now() < searchBlockedUntil;

export function searchUrl(query) {
  return `${ENDPOINT}?q=${encodeURIComponent(query ?? '')}&searcharea=deals&searchin=first&rss=1`;
}

export async function search({ query, minPrice, maxPrice, maxAgeHours } = {}, httpOptions) {
  const found = (await searchRss(query, httpOptions)) ?? (await officialMatches(query, httpOptions));
  const items = found.filter(item => isFresh(item, maxAgeHours));
  return {
    total: items.length,
    items: items.filter(item => (minPrice == null || item.price >= minPrice) && (maxPrice == null || item.price <= maxPrice)),
  };
}

// 搜尋 RSS 一次發一個：第一個被擋，排在後面的關鍵字就不會再去敲。被擋時回傳 null
function searchRss(query, httpOptions) {
  const job = queue.then(async () => {
    if (usingOfficialFeeds()) return null;
    try {
      const response = await get('sd', searchUrl(query), httpOptions);
      requireSuccess('Slickdeals', response);
      return parse(response.body ?? '');
    } catch (err) {
      if (!(err instanceof Blocked)) throw err;
      searchBlockedUntil = Date.now() + SEARCH_BLOCK_MS;
      return null;
    }
  });
  queue = job.catch(() => {});
  return job;
}

// 官方 feed 裡名稱包含 query 每個字的貼文
async function officialMatches(query, httpOptions) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const items = await officialItems(httpOptions);
  return items.filter(item => words.every(word => item.name.toLowerCase().includes(word)));
}

function officialItems(httpOptions) {
  if (feedCache && Date.now() - feedCache.t < FEED_TTL) return Promise.resolve(feedCache.items);
  return feedJob ??= Promise.all(OFFICIAL_FEEDS.map(async url => {
    const response = await get('sd', url, httpOptions);
    requireSuccess('Slickdeals 官方 feed', response);
    return parse(response.body ?? '');
  })).then(lists => {
    // 同一篇可能同時在首頁和討論區
    const items = [...new Map(lists.flat().map(item => [item.key, item])).values()];
    feedCache = { t: Date.now(), items };
    return items;
  }).finally(() => { feedJob = null; });
}

function isFresh(item, maxAgeHours) {
  return Date.now() - Date.parse(item.postedAt) <= (maxAgeHours ?? MAX_AGE_HOURS) * 36e5;
}

function parse(body) {
  const blocks = [...body.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map(match => match[1]);
  // 完全沒有 item：合法但空的 feed 回空陣列，HTML 驗證頁則視為被擋
  if (!blocks.length) {
    if (!/<rss[\s>]/i.test(body) || /<!doctype\s+html|<html[\s>]|<body[\s>]/i.test(body)) {
      throw new Blocked('Slickdeals 擋下請求（驗證頁）');
    }
    return [];
  }
  return blocks.map(parseItem).filter(Boolean);
}

function parseItem(block) {
  const rawTitle = xmlTag(block, 'title');
  if (!rawTitle) return undefined;
  const title = cleanText(rawTitle);
  // 解析不出價格的貼文（抽獎、活動）直接丟掉
  const price = slickdealsPrice(title);
  if (!(price > 0)) return undefined;
  const url = stripUtm(xmlTag(block, 'link'));
  const id = /\/f\/(\d+)/.exec(url)?.[1];
  if (!id) return undefined;
  const postedAt = isoDate(xmlTag(block, 'pubDate'));
  if (!postedAt) return undefined;

  const content = decodeEntities(xmlTag(block, 'content:encoded'));
  const description = decodeEntities(xmlTag(block, 'description'));
  const slug = /data-store-slug="([^"]+)"/i.exec(content)?.[1] ?? /data-store-slug="([^"]+)"/i.exec(description)?.[1];
  const seller = sellerFromTitle(title) || storeFromSlug(slug) || sellerFromText(description) || 'Unknown';
  const { kind, cond } = kindOf(title);
  const score = Number.parseInt(/Thumb Score:\s*([+-]?\d+)/i.exec(content)?.[1] ?? '', 10);

  return {
    store: 'sd',
    id,
    key: `sd:${id}`,
    kind,
    cond,
    name: cleanName(title, seller),
    type: typeOf(title, bracketOf(title)),
    seller,
    price,
    ref: originalPrice(title, price),
    inStock: inStockOf(title),
    url,
    // Slickdeals 的 link 就是討論串，沒有另外的商品網址
    thread: url,
    postedAt,
    ...(Number.isFinite(score) ? { score } : {}),
    cartUrl: null,
  };
}
