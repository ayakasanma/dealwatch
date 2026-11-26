// Reddit r/buildapcsales：Reddit 於 2026/11 停用公開 RSS，正式監控改由專用瀏覽器載入頁面，
// 仍保留 Atom RSS 解析供離線測試或自訂 feedUrl 使用。商品在別家店賣，seller 是那家店。
// 介面（src/monitor.mjs 會呼叫）：
//   configure({ browser, feedUrl })
//   usingBrowser() -> boolean
//   search({ query, minPrice, maxPrice }, httpOptions) -> { total, items }
//
// 保護機制：
//   1. 一次抓到的貼文在記憶體放 60 秒，同一輪 monitor 的所有關鍵字共用。
//   2. 同時進來的呼叫共用同一個進行中的 Promise，只載入一次。
//   3. 遇到 429 記下 5 分鐘冷卻，期間直接丟 Blocked 讓 monitor 退避。
import config from '../config.mjs';
import { get, Blocked, RequestError, requireSuccess } from './http.mjs';
import {
  xmlTag, decodeEntities, cleanText, cleanName, isoDate, redditPrice, originalPrice,
  kindOf, inStockOf, typeOf, bracketOf, isCategory, sellerFromTitle, storeFromDomain,
} from './feed.mjs';

const FEED = 'https://www.reddit.com/r/buildapcsales/new/.rss?limit=100';
const PAGE = 'https://www.reddit.com/r/buildapcsales/new/';
const CACHE_TTL = 60e3;
const COOLDOWN = 5 * 60e3;
const MAX_AGE_HOURS = config.feeds?.maxAgeHours ?? 48;
const RATE_LIMIT = 'Reddit 限流 (HTTP 429)，稍後再試';
const BLOCKED_MSG = 'Reddit 要求登入或人機驗證，請在 dealwatch 專用瀏覽器視窗手動完成';

let browser = null;
let feedUrl = '';
let cache = null; // { t, records }
let job = null; // 進行中的抓取
let blockedUntil = 0;

export function configure({ browser: b = null, feedUrl: u = '' } = {}) {
  browser = b;
  feedUrl = String(u ?? '').trim();
  resetCache();
}

export const usingBrowser = () => !!browser && !feedUrl;

// 測試用：清掉快取與冷卻
export function resetCache() {
  cache = null;
  job = null;
  blockedUntil = 0;
}

export async function search({ query, minPrice, maxPrice, maxAgeHours } = {}, httpOptions) {
  const records = await load(httpOptions);
  const limit = (maxAgeHours ?? MAX_AGE_HOURS) * 36e5;
  const now = Date.now();
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const items = [];
  for (const record of records) {
    if (!(now - Date.parse(record.item.postedAt) <= limit)) continue;
    if (!matches(record, words)) continue;
    if (minPrice != null && record.item.price < minPrice) continue;
    if (maxPrice != null && record.item.price > maxPrice) continue;
    items.push(record.item);
  }
  return { total: items.length, items };
}

// 標題（含開頭方括號）包含 query 的每個字，或方括號分類等於 query
function matches({ title, bracket }, words) {
  if (!words.length) return true;
  if (bracket && bracket.toLowerCase() === words.join(' ')) return true;
  const lower = title.toLowerCase();
  return words.every(word => lower.includes(word));
}

function load(httpOptions) {
  const now = Date.now();
  if (cache && now - cache.t < CACHE_TTL) return Promise.resolve(cache.records);
  if (blockedUntil > now) return Promise.reject(new Blocked(RATE_LIMIT, 429));
  if (job) return job;
  const useBrowser = !!browser && !feedUrl && !httpOptions?.fetchImpl;
  job = (useBrowser ? fetchBrowserPage() : fetchFeed(httpOptions))
    .then(records => {
      cache = { t: Date.now(), records };
      return records;
    })
    .finally(() => { job = null; });
  return job;
}

const CHECK_PAGE = `(() => ({
  ready: !!document.querySelector('shreddit-post, .thing[data-fullname]')
    || /blocked by network security|whoa there, pardner|prove your humanity|verify you are human|log in to reddit/i.test(document.body?.innerText ?? ''),
  html: document.documentElement.outerHTML,
}))()`;

async function fetchBrowserPage() {
  let html;
  if (typeof browser.evaluate === 'function') {
    const res = await browser.evaluate(PAGE, CHECK_PAGE, { until: v => !!v?.ready, timeout: 12000 });
    html = res?.html ?? '';
  } else {
    html = await browser.html(PAGE);
  }
  try {
    const records = parseHtml(html);
    browser.hold = false;
    return records;
  } catch (err) {
    if (err instanceof Blocked) {
      browser.keepOpen = browser.hold = true;
      await browser.focus?.().catch(() => {});
    }
    throw err;
  }
}

async function fetchFeed(httpOptions) {
  const url = feedUrl || FEED;
  const response = await get('rd', url, httpOptions);
  if (response.status === 404 && !feedUrl) {
    throw new RequestError('Reddit 已停用公開 RSS（HTTP 404），請改用瀏覽器模式載入 r/buildapcsales', 'http', { status: 404 });
  }
  try {
    requireSuccess('Reddit', response);
  } catch (err) {
    if (err instanceof Blocked && err.status === 429) {
      blockedUntil = Date.now() + COOLDOWN;
      throw new Blocked(RATE_LIMIT, 429);
    }
    throw err;
  }
  return parse(response.body ?? '');
}

function buildRecord({ id, title, thread, productUrl, postedAt, extraStockText = '' }) {
  if (!id || !title || !postedAt) return undefined;
  const price = redditPrice(title);
  if (!(price > 0)) return undefined;
  const url = productUrl || thread;
  const bracket = bracketOf(title);
  let host = '';
  try { host = new URL(url).hostname; } catch {}
  // 方括號不是分類就當店名；是分類（[GPU]、[Prebuilt]…）就用商品網址的網域推
  const fromDomain = host && !/(^|\.)reddit\.com$/i.test(host) ? storeFromDomain(host) : '';
  const seller = bracket && !isCategory(bracket) ? bracket : fromDomain || sellerFromTitle(title) || 'Unknown';
  const { kind, cond } = kindOf(title);
  return {
    title,
    bracket,
    item: {
      store: 'rd',
      id,
      key: `rd:${id}`,
      kind,
      cond,
      name: cleanName(title, seller),
      type: typeOf(title, bracket),
      seller,
      price,
      ref: originalPrice(title, price),
      inStock: inStockOf(`${title} ${extraStockText}`),
      url,
      thread,
      postedAt,
      cartUrl: null,
    },
  };
}

const attrOf = (tag, name) => {
  const m = new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? decodeEntities(m[1] ?? m[2] ?? '') : '';
};

const fullRedditUrl = href => {
  const s = String(href ?? '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return s.startsWith('/') ? `https://www.reddit.com${s}` : '';
};

export function parseHtml(body) {
  const html = String(body ?? '');
  const records = [];

  // 新版 Reddit：<shreddit-post id="t3_..." post-title="..." permalink="..." content-href="..." created-timestamp="...">
  const shredditRe = /<shreddit-post\b([^>]*)>([\s\S]*?)<\/shreddit-post>/gi;
  for (const m of html.matchAll(shredditRe)) {
    const attrs = m[1], inner = m[2];
    const id = attrOf(attrs, 'id').replace(/^t3_/, '');
    const title = cleanText(attrOf(attrs, 'post-title'));
    const thread = fullRedditUrl(attrOf(attrs, 'permalink'));
    const rawHref = attrOf(attrs, 'content-href');
    const productUrl = /^https?:\/\//i.test(rawHref) ? rawHref : '';
    const postedAt = isoDate(attrOf(attrs, 'created-timestamp'));
    const flair = cleanText(/slot="post-flair"[\s\S]{0,400}?<\/[^>]+>/i.exec(inner)?.[0]?.replace(/<[^>]+>/g, ' ') ?? '');
    const rec = buildRecord({ id, title, thread, productUrl, postedAt, extraStockText: flair });
    if (rec) records.push(rec);
  }
  if (records.length) return records;

  // 舊版 Reddit：<div class="... thing ..." data-fullname="t3_..." data-permalink="..." data-url="..." data-timestamp="...">
  const thingTags = [...html.matchAll(/<div\b[^>]*\bdata-fullname="t3_([a-z0-9]+)"[^>]*>/gi)];
  for (let i = 0; i < thingTags.length; i++) {
    const tag = thingTags[i][0], id = thingTags[i][1];
    const end = Math.min(thingTags[i + 1]?.index ?? html.length, thingTags[i].index + 12000);
    const block = html.slice(thingTags[i].index, end);
    const title = cleanText(/<a\b[^>]*\bclass="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block)?.[1] ?? '');
    const thread = fullRedditUrl(attrOf(tag, 'data-permalink'));
    const rawUrl = attrOf(tag, 'data-url');
    const productUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : '';
    const ts = Number(attrOf(tag, 'data-timestamp'));
    const postedAt = Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : isoDate(/<time\b[^>]*\bdatetime="([^"]+)"/i.exec(block)?.[1]);
    const flair = cleanText(/<span\b[^>]*\bclass="[^"]*\blinkflairlabel\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(block)?.[1] ?? '');
    const rec = buildRecord({ id, title, thread, productUrl, postedAt, extraStockText: flair });
    if (rec) records.push(rec);
  }
  if (records.length) return records;

  const visible = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  if (/blocked by network security|whoa there, pardner|prove your humanity|verify you are human|log in to reddit|access denied|just a moment/i.test(visible)) {
    throw new Blocked(BLOCKED_MSG);
  }
  throw new RequestError('Reddit 頁面格式不符（找不到貼文列表）', 'format');
}

function parse(body) {
  const blocks = [...body.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)].map(match => match[1]);
  // 完全沒有 entry：合法但空的 feed 回空陣列，HTML 驗證頁則視為被擋
  if (!blocks.length) {
    if (!/<feed[\s>]/i.test(body) || /<!doctype\s+html|<html[\s>]|<body[\s>]/i.test(body)) {
      throw new Blocked('Reddit 擋下請求（驗證頁）');
    }
    return [];
  }
  return blocks.map(parseEntry).filter(Boolean);
}

function parseEntry(block) {
  const title = cleanText(xmlTag(block, 'title'));
  const thread = decodeEntities(/<link\s+href="([^"]+)"/i.exec(block)?.[1] ?? '');
  const id = xmlTag(block, 'id').trim().replace(/^t3_/, '') || /\/comments\/([a-z0-9]+)/i.exec(thread)?.[1];
  const postedAt = isoDate(xmlTag(block, 'published') || xmlTag(block, 'updated'));
  // content 是跳脫過的 HTML，解回來後找 [link] 錨點（實際商品網址）
  const html = decodeEntities(decodeEntities(xmlTag(block, 'content')));
  const productUrl = decodeEntities(/<a\s[^>]*href="([^"]+)"[^>]*>\s*\[link\]\s*<\/a>/i.exec(html)?.[1] ?? '');
  return buildRecord({ id, title, thread, productUrl, postedAt });
}
