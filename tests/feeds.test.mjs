// Slickdeals / Reddit 模組的離線測試：用真實抓下來的 feed 裁切成 fixture，配合假的 fetchImpl。
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as slickdeals from '../src/slickdeals.mjs';
import * as reddit from '../src/reddit.mjs';
import { Blocked, setPace } from '../src/http.mjs';
import { evaluate } from '../src/specs.mjs';
import { decodeEntities, cleanText, slickdealsPrice, redditPrice } from '../src/feed.mjs';
import config from '../config.mjs';

const fixture = name => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const ALL = 1e6; // 小時；測試不讓 fixture 日期隨時間過期

function mock(body, init = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(body, init);
  };
  return { calls, fetchImpl };
}

beforeEach(() => {
  reddit.resetCache();
  slickdeals.resetCache();
  // 測試不需要真實的站台間隔
  setPace('sd', 10, 0);
  setPace('rd', 10, 0);
});

test('Slickdeals：直線前的價格、結尾的店名、名稱清理與網址', async () => {
  const m = mock(fixture('slickdeals-desktop.xml'));
  const { items } = await slickdeals.search({ query: '9800x3d', maxAgeHours: ALL }, { fetchImpl: m.fetchImpl });
  const item = items.find(i => i.key === 'sd:20225415');
  assert.ok(item, '應解析到 ASUS ROG GM700');
  assert.equal(item.store, 'sd');
  assert.equal(item.price, 1799.99);
  assert.equal(item.seller, 'Amazon');
  assert.equal(item.kind, 'new');
  assert.equal(item.cond, 'New');
  assert.equal(item.cartUrl, null);
  assert.match(item.key, /^sd:\d+$/);
  assert.match(item.name, /^ASUS ROG GM700/);
  assert.match(item.name, /Ryzen 7 9800X3D/);
  assert.match(item.name, /RTX 5070/);
  assert.doesNotMatch(item.name, /[™®]|^\$/);
  assert.ok(!item.url.includes('utm_'), 'utm 參數應移除');
  assert.equal(item.thread, item.url);
  assert.ok(item.postedAt.endsWith('Z'));
  assert.equal(m.calls.length, 1);
  assert.match(m.calls[0].url, /q=9800x3d/);
  assert.match(m.calls[0].url, /rss=1/);
});

test('Slickdeals：`$X | ... at Amazon` 與 `$X, Amazon, ...` 兩種開頭格式', async () => {
  const m = mock(fixture('slickdeals-laptop.xml'));
  const { items } = await slickdeals.search({ query: 'gaming laptop', maxAgeHours: ALL }, { fetchImpl: m.fetchImpl });

  const pipe = items.find(i => i.key === 'sd:20207925');
  assert.equal(pipe.price, 14.99);
  assert.equal(pipe.seller, 'Amazon');
  assert.match(pipe.name, /^UGREEN Wireless Bluetooth Vertical Ergonomic Mouse$/);

  const comma = items.find(i => i.key === 'sd:20199159');
  assert.equal(comma.price, 19.99);
  assert.equal(comma.seller, 'Amazon');
  assert.match(comma.name, /^DURATECH USB-C/);

  // 標題內嵌 `at Best Buy YMMV`：店名只取 Best Buy，名稱尾巴的 YMMV 也清掉
  const hp = items.find(i => i.key === 'sd:20211381');
  assert.equal(hp.seller, 'Best Buy');
  assert.equal(hp.kind, 'ob');
  assert.equal(hp.cond, 'Open-Box');
  assert.doesNotMatch(hp.name, /at Best Buy|YMMV/);
});

test('Slickdeals：`- $X at Walmart` 與沒有店名的標題（用 data-store-slug）', async () => {
  const m = mock(fixture('slickdeals-gpu.xml'));
  const { items } = await slickdeals.search({ query: 'rtx 5080', maxAgeHours: ALL }, { fetchImpl: m.fetchImpl });

  const cyber = items.find(i => i.key === 'sd:20149056');
  assert.equal(cyber.price, 2599);
  assert.equal(cyber.seller, 'Walmart');

  // 標題沒有店名，靠 content:encoded 的 data-store-slug="walmart"
  const pny = items.find(i => i.key === 'sd:20211477');
  assert.equal(pny.price, 1579);
  assert.equal(pny.seller, 'Walmart');
  assert.match(pny.name, /^PNY NVIDIA GeForce RTX 5080/);
  assert.doesNotMatch(pny.name, /^\[/);
  assert.equal(pny.score, -2);
});

test('Slickdeals：解析不出價格的貼文（抽獎）直接丟掉', async () => {
  const m = mock(fixture('slickdeals-gpu.xml'));
  const { items } = await slickdeals.search({ query: 'rtx', maxAgeHours: ALL }, { fetchImpl: m.fetchImpl });
  assert.equal(items.length, 4);
  assert.ok(!items.some(i => /Giveaway/i.test(i.name)));
});

test('Slickdeals：超過 maxAgeHours 的貼文被過濾', async () => {
  const cutoff = Date.parse('2026-10-29T00:00:00Z');
  const maxAgeHours = (Date.now() - cutoff) / 36e5 + 1;
  const m = mock(fixture('slickdeals-laptop.xml'));
  const { items } = await slickdeals.search({ query: 'gaming laptop', maxAgeHours }, { fetchImpl: m.fetchImpl });
  assert.ok(items.some(i => i.key === 'sd:20229297'), '10/29 的 NIMO 應保留');
  assert.ok(!items.some(i => i.key === 'sd:20205657'), '10/25 的 Lenovo 應被濾掉');
  assert.ok(items.every(i => Date.parse(i.postedAt) >= cutoff));
});

// 搜尋 RSS 回 Cloudflare 的 403，官方 feed 由 feeds(url) 決定內容
function blockedSearch(feeds) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    if (String(url).includes('newsearch.php')) return new Response('<html><title>Just a moment...</title></html>', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
    return feeds(String(url));
  };
  return { calls, fetchImpl };
}

test('Slickdeals：搜尋被擋時改讀官方 feed，自己比對名稱，同一篇只算一次', async () => {
  const m = blockedSearch(url => new Response(fixture(url.includes('Forums-9') ? 'slickdeals-gpu.xml' : 'slickdeals-desktop.xml')));
  const { items } = await slickdeals.search({ query: 'rtx 5080', maxAgeHours: ALL }, { fetchImpl: m.fetchImpl });
  assert.ok(items.some(i => i.key === 'sd:20211477'), '應找到 Hot Deals 裡的 RTX 5080');
  assert.ok(items.every(i => /rtx/i.test(i.name) && i.name.includes('5080')));
  assert.equal(new Set(items.map(i => i.key)).size, items.length);
  assert.equal(slickdeals.usingOfficialFeeds(), true);

  const same = blockedSearch(() => new Response(fixture('slickdeals-gpu.xml')));
  slickdeals.resetCache();
  const both = await slickdeals.search({ query: 'rtx 5080', maxAgeHours: ALL }, { fetchImpl: same.fetchImpl });
  assert.equal(new Set(both.items.map(i => i.key)).size, both.items.length);
});

test('Slickdeals：被擋的搜尋只敲一次，官方 feed 同一輪也只抓一次', async () => {
  const m = blockedSearch(() => new Response(fixture('slickdeals-gpu.xml')));
  await Promise.all(['rtx 5070 ti', 'rtx 5080', 'rtx 5090', 'ddr5'].map(query => slickdeals.search({ query, maxAgeHours: ALL }, { fetchImpl: m.fetchImpl })));
  assert.equal(m.calls.filter(url => url.includes('newsearch.php')).length, 1);
  assert.equal(m.calls.filter(url => url.includes('feedburner')).length, 2);
  await slickdeals.search({ query: 'rtx 5080', maxAgeHours: ALL }, { fetchImpl: m.fetchImpl });
  assert.equal(m.calls.length, 3, '被擋的記憶和快取都還在，不再發請求');
});

test('Slickdeals：官方 feed 也被擋才算被擋；搜尋是別的錯誤就不改讀 feed', async () => {
  const blocked = blockedSearch(() => new Response('', { status: 403 }));
  await assert.rejects(slickdeals.search({ query: 'x' }, { fetchImpl: blocked.fetchImpl }), err => err instanceof Blocked && /官方 feed/.test(err.message));

  slickdeals.resetCache();
  const down = mock('', { status: 500 });
  await assert.rejects(slickdeals.search({ query: 'x' }, { fetchImpl: down.fetchImpl, retries: 0 }), err => !(err instanceof Blocked));
  assert.equal(slickdeals.usingOfficialFeeds(), false);
  assert.ok(down.calls.every(call => call.url.includes('newsearch.php')));
});

test('Reddit：商品網址、討論串、店名、價格與 id', async () => {
  const m = mock(fixture('reddit-new.xml'));
  const { items } = await reddit.search({ query: '', maxAgeHours: ALL }, { fetchImpl: m.fetchImpl });
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0].url, 'https://www.reddit.com/r/buildapcsales/new/.rss?limit=100');

  const sam = items.find(i => i.key === 'rd:1xjoq0r');
  assert.ok(sam, '應解析到 Sam\'s Club 的貼文');
  assert.equal(sam.store, 'rd');
  assert.equal(sam.id, '1xjoq0r');
  assert.equal(sam.price, 79.98);
  assert.equal(sam.seller, "Sam's Club");
  assert.equal(sam.url, 'https://www.samsclub.com/ip/SteelSeries-Apex-7-Keyboard-Black/13867723378');
  assert.match(sam.thread, /reddit\.com\/r\/buildapcsales\/comments\/1xjoq0r/);
  assert.match(sam.name, /^SteelSeries Apex 7/);
  assert.equal(sam.cartUrl, null);
  assert.ok(sam.postedAt.startsWith('2026-10-30T19:22:12'));

  // 開頭放價格的格式
  const prebuilt = items.find(i => i.key === 'rd:1xj5bg2');
  assert.equal(prebuilt.price, 1799);
  assert.equal(prebuilt.seller, 'Micro Center');
  assert.match(prebuilt.name, /^MicroCenter In-Store PowerSpec G541/);
  assert.equal(prebuilt.url, 'https://www.microcenter.com/product/714627/powerspec-g541-gaming-pc');

  // `@ Walmart` 也算店名
  const abs = items.find(i => i.key === 'rd:1xhod1y');
  assert.equal(abs.price, 849);
  assert.equal(abs.seller, 'Walmart');
  assert.doesNotMatch(abs.name, /@ Walmart/);

  // 括號裡的原價放進 ref
  const apple = items.find(i => i.key === 'rd:1xg4bzj');
  assert.equal(apple.price, 1999.99);
  assert.equal(apple.ref, 2499.99);
});

test('Reddit：query 比對標題字詞或方括號分類', async () => {
  const m = mock(fixture('reddit-new.xml'));
  const laptop = await reddit.search({ query: 'laptop', maxAgeHours: ALL }, { fetchImpl: m.fetchImpl });
  assert.ok(laptop.items.some(i => i.key === 'rd:1xi473v'));
  assert.ok(!laptop.items.some(i => i.key === 'rd:1xjn2rk'));

  const prebuilt = await reddit.search({ query: 'prebuilt', maxAgeHours: ALL }, { fetchImpl: m.fetchImpl });
  assert.ok(prebuilt.items.some(i => i.key === 'rd:1xj5bg2'));
  assert.ok(!prebuilt.items.some(i => i.key === 'rd:1xi473v'));

  const gpu = await reddit.search({ query: 'gpu', maxAgeHours: ALL }, { fetchImpl: m.fetchImpl });
  assert.ok(gpu.items.some(i => i.key === 'rd:1xjn2rk'));
});

test('Reddit：售完字樣讓 inStock 為 false', async () => {
  const m = mock(fixture('reddit-oos.xml'));
  const { items } = await reddit.search({ query: '', maxAgeHours: ALL }, { fetchImpl: m.fetchImpl });
  assert.equal(items.length, 1);
  assert.equal(items[0].inStock, false);
});

test('Reddit：超過 maxAgeHours 的貼文被過濾', async () => {
  const cutoff = Date.parse('2026-10-29T00:00:00Z');
  const maxAgeHours = (Date.now() - cutoff) / 36e5 + 1;
  const m = mock(fixture('reddit-new.xml'));
  const { items } = await reddit.search({ query: 'prebuilt', maxAgeHours }, { fetchImpl: m.fetchImpl });
  assert.ok(items.some(i => i.key === 'rd:1xj5bg2'), '10/30 的 PowerSpec 應保留');
  assert.ok(!items.some(i => i.key === 'rd:1xbeb7z'), '10/21 的 Woot 整新機應被濾掉');
  assert.ok(items.every(i => Date.parse(i.postedAt) >= cutoff));
});

test('Reddit：同時 5 個 search 只發一個請求，60 秒內沿用快取', async () => {
  const m = mock(fixture('reddit-new.xml'));
  const queries = ['gpu', 'laptop', 'cpu', 'ram', 'prebuilt'];
  const results = await Promise.all(queries.map(query =>
    reddit.search({ query, maxAgeHours: ALL }, { fetchImpl: m.fetchImpl, headers: { 'x-test': '1' } })));
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0].options.headers['x-test'], '1', 'httpOptions 應原樣傳給 get');
  assert.ok(results.every(r => Array.isArray(r.items)));

  await reddit.search({ query: 'rtx', maxAgeHours: ALL }, { fetchImpl: m.fetchImpl });
  assert.equal(m.calls.length, 1, '快取有效期內不應再請求');
});

test('Reddit：429 轉成 Blocked，冷卻期內不再發請求', async () => {
  const m = mock('', { status: 429 });
  await assert.rejects(
    reddit.search({ query: 'gpu' }, { fetchImpl: m.fetchImpl }),
    err => err instanceof Blocked && err.message === 'Reddit 限流 (HTTP 429)，稍後再試',
  );
  await assert.rejects(
    reddit.search({ query: 'gpu' }, { fetchImpl: m.fetchImpl }),
    err => err instanceof Blocked && /429/.test(err.message),
  );
  assert.equal(m.calls.length, 1);
});

test('合法但空的 feed 回傳 0 筆', async () => {
  const sd = await slickdeals.search({ query: 'x' }, {
    fetchImpl: mock('<rss version="2.0"><channel></channel></rss>').fetchImpl,
  });
  assert.deepEqual(sd, { total: 0, items: [] });

  reddit.resetCache();
  const rd = await reddit.search({ query: 'x' }, {
    fetchImpl: mock('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>').fetchImpl,
  });
  assert.deepEqual(rd, { total: 0, items: [] });
});

test('HTML 驗證頁轉成 Blocked', async () => {
  await assert.rejects(
    slickdeals.search({ query: 'x' }, { fetchImpl: mock('<!DOCTYPE html><html><body>Just a moment...</body></html>').fetchImpl }),
    err => err instanceof Blocked && /驗證頁/.test(err.message),
  );
  reddit.resetCache();
  await assert.rejects(
    reddit.search({ query: 'x' }, { fetchImpl: mock('<html><body>whoa there, pardner</body></html>').fetchImpl }),
    err => err instanceof Blocked && /驗證頁/.test(err.message),
  );
});

test('minPrice / maxPrice 會過濾', async () => {
  const m = mock(fixture('slickdeals-laptop.xml'));
  const { items } = await slickdeals.search({ query: 'x', minPrice: 500, maxPrice: 2000, maxAgeHours: ALL }, { fetchImpl: m.fetchImpl });
  assert.ok(items.length > 0);
  assert.ok(items.every(i => i.price >= 500 && i.price <= 2000));
});

test('kind：open box / refurbished / new', async () => {
  const sd = await slickdeals.search({ query: 'x', maxAgeHours: ALL }, {
    fetchImpl: mock(fixture('slickdeals-laptop.xml')).fetchImpl,
  });
  const hp = sd.items.find(i => i.key === 'sd:20211381');
  assert.deepEqual([hp.kind, hp.cond], ['ob', 'Open-Box']);

  reddit.resetCache();
  const rd = await reddit.search({ query: '', maxAgeHours: ALL }, {
    fetchImpl: mock(fixture('reddit-new.xml')).fetchImpl,
  });
  assert.deepEqual([rd.items.find(i => i.key === 'rd:1xbeb7z').kind, rd.items.find(i => i.key === 'rd:1xbeb7z').cond], ['refurb', 'Refurb']);
  assert.deepEqual([rd.items.find(i => i.key === 'rd:1xi473v').kind, rd.items.find(i => i.key === 'rd:1xi473v').cond], ['ob', 'Open-Box']);
  assert.deepEqual([rd.items.find(i => i.key === 'rd:1xjn2rk').kind, rd.items.find(i => i.key === 'rd:1xjn2rk').cond], ['new', 'New']);
});

test('type 讓 GPU / CPU / RAM / 筆電 / 整機被 config 分類', async () => {
  const sdItem = async (file, key) => {
    reddit.resetCache();
    const { items } = await slickdeals.search({ query: 'x', maxAgeHours: ALL }, { fetchImpl: mock(fixture(file)).fetchImpl });
    return items.find(i => i.key === key);
  };
  const gpu = await sdItem('slickdeals-gpu.xml', 'sd:20211477');
  assert.ok(evaluate(config.categories.gpu, gpu), 'RTX 5080 顯卡應符合 gpu 分類');
  assert.match(gpu.type, /graphics card|video card|gpu/i);

  const cpu = await sdItem('slickdeals-cpu.xml', 'sd:19848939');
  assert.ok(evaluate(config.categories.cpu, cpu), '7800X3D 應符合 cpu 分類');
  assert.match(cpu.type, /processor|cpu/i);

  const ram = await sdItem('slickdeals-ram.xml', 'sd:20210574');
  assert.ok(evaluate(config.categories.ram, ram), 'DDR5 32GB 應符合 ram 分類');
  assert.match(ram.type, /memory|ram/i);

  const laptop = await sdItem('slickdeals-laptop.xml', 'sd:20223867');
  assert.ok(evaluate(config.categories.laptop, laptop), 'RTX 5090 筆電應符合 laptop 分類');
  assert.match(laptop.type, /laptop|notebook/i);

  const { items } = await reddit.search({ query: '', maxAgeHours: ALL }, { fetchImpl: mock(fixture('reddit-new.xml')).fetchImpl });
  const desktop = items.find(i => i.key === 'rd:1xj5bg2');
  assert.ok(evaluate(config.categories.desktop, desktop), 'Prebuilt 應符合 desktop 分類');
  assert.match(desktop.type, /desktop|gaming pc|tower/i);

  // 組合包不能被當成單獨的 CPU
  const bundle = items.find(i => i.key === 'rd:1xhqhg5');
  assert.equal(bundle.type, 'bundle');
  assert.equal(evaluate(config.categories.cpu, bundle), null);
});

test('HTML 實體與商標符號會清掉', () => {
  assert.equal(decodeEntities('A &amp; B &quot;x&quot; &#8482;'), 'A & B "x" ™');
  assert.equal(cleanText('AMD Ryzen™ 7 9800X3D® &amp; more'), 'AMD Ryzen 7 9800X3D & more');
});

test('價格解析規則', () => {
  assert.equal(slickdealsPrice('$1,799.99 | ASUS ROG at Amazon'), 1799.99);
  assert.equal(slickdealsPrice('MSI RTX 5080 VENTUS $1,299.99'), 1299.99);
  assert.equal(redditPrice('[Prebuilt] $1799 - MicroCenter X'), 1799);
  assert.equal(redditPrice('[GPU] Foo - $599.99 (In-store only)'), 599.99);
  assert.equal(redditPrice('[GPU] Foo - $99 ($79 after rebate)'), 79);
  assert.equal(redditPrice('Apple - $1,999.99 ($2,499.99 - $500)'), 1999.99);
});
