// eBay 模組的離線測試：用假的 browser 物件餵入縮小過的搜尋頁／商品頁 HTML。
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configure, search, product, searchUrl, parseSearch, parseItem } from '../src/ebay.mjs';
import { Blocked, RequestError } from '../src/http.mjs';

const read = name => fs.readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
const searchHtml = read('ebay-search.html');
const itemHtml = read('ebay-item.html');

const ERROR_PAGE = '<!doctype html><html><head><title>Error Page | eBay</title></head><body></body></html>';
const CHALLENGE_PAGE = '<!doctype html><html><head><title>Pardon Our Interruption</title></head><body><h1>Pardon Our Interruption</h1></body></html>';
const NO_RESULTS = '<!doctype html><html><head><title>rtx 9999 for sale | eBay</title></head><body><h1 class="srp-controls__count-heading"> 0<!--F/--> results for rtx 9999 </h1></body></html>';

function fakeBrowser(body = searchHtml) {
  const browser = { calls: [], hold: false, keepOpen: false, focused: 0 };
  browser.html = async url => {
    browser.calls.push(url);
    return typeof body === 'function' ? body(url, browser.calls.length) : body;
  };
  browser.focus = async () => { browser.focused++; };
  return browser;
}

beforeEach(() => {
  configure({ browser: null, conditions: ['New', 'Open-Box', 'Refurbished', 'Used'], usOnly: false, gapMs: 0 });
});

test('搜尋網址：最新上架、直購、狀況代號、分類、價格、美國境內、每頁 120', () => {
  configure({ conditions: ['New', 'Open-Box', 'Refurbished', 'Used'], usOnly: true, gapMs: 0 });
  assert.equal(searchUrl({ query: 'rtx 5080', minPrice: 400, maxPrice: 2000, category: 27386 }),
    'https://www.ebay.com/sch/i.html?_nkw=rtx+5080&_sop=10&LH_BIN=1'
    + '&LH_ItemCondition=1000%7C1500%7C2010%7C2020%7C2030%7C2500%7C3000'
    + '&_sacat=27386&_udlo=400&_udhi=2000&LH_PrefLoc=1&_ipg=120');
});

test('搜尋網址：conditions 只給子集時只帶對應代號；沒給 category / 價格就不帶', () => {
  configure({ conditions: ['New', 'Used'], usOnly: false, gapMs: 0 });
  assert.equal(searchUrl({ query: 'ddr5 32gb' }),
    'https://www.ebay.com/sch/i.html?_nkw=ddr5+32gb&_sop=10&LH_BIN=1&LH_ItemCondition=1000%7C3000&_ipg=120');
  configure({ conditions: ['Open-Box'], usOnly: false, gapMs: 0 });
  assert.match(searchUrl({ query: 'x' }), /LH_ItemCondition=1500&/);
  assert.doesNotMatch(searchUrl({ query: 'x' }), /_sacat|_udlo|_udhi|LH_PrefLoc/);
  configure({ conditions: [], usOnly: false, gapMs: 0 });
  assert.doesNotMatch(searchUrl({ query: 'x' }), /LH_ItemCondition/);
});

test('假卡片（Shop on eBay / itm/123456）略過，total 用頁面標頭', () => {
  const { total, items } = parseSearch(searchHtml, 27386);
  assert.equal(total, 42);
  assert.equal(items.length, 11);
  assert.ok(!items.some(i => i.id === '2500219655424533'));
  assert.ok(!items.some(i => /shop on ebay/i.test(i.name)));
});

test('標題清理：去掉 New Listing 與 Opens in a new window or tab', () => {
  const { items } = parseSearch(searchHtml, 27386);
  const byId = new Map(items.map(i => [i.id, i]));
  assert.equal(byId.get('100000000001').name, 'MSI NVIDIA GeForce RTX 5080 16GB GDDR7 VENTUS 3X OC WHITE Graphics Card');
  assert.equal(byId.get('100000000002').name, 'ASUS TUF Gaming GeForce RTX 5080 16GB GDDR7 RGB G-SYNC Compatible');
  assert.ok(items.every(i => !/new listing|opens in a new window/i.test(i.name)));
});

test('各種狀況對應 kind / cond', () => {
  const byId = new Map(parseSearch(searchHtml, 27386).items.map(i => [i.id, i]));
  const cases = [
    ['100000000001', 'new', 'New'],      // Brand New
    ['100000000002', 'ob', 'Open-Box'],  // Open Box
    ['100000000003', 'refurb', 'Used'],  // Pre-Owned
    ['100000000004', 'refurb', 'Refurb'],// Certified - Refurbished
    ['100000000005', 'refurb', 'Refurb'],// Excellent - Refurbished
    ['100000000006', 'refurb', 'Refurb'],// Seller refurbished
    ['100000000007', 'ob', 'Open-Box'],  // New (Other)
    ['100000000008', 'refurb', 'Used'],  // Used
    ['100000000010', 'new', 'New'],
  ];
  for (const [id, kind, cond] of cases) {
    assert.deepEqual([byId.get(id).kind, byId.get(id).cond], [kind, cond], id);
  }
});

test('運費加總：+$x delivery 加上去、Free delivery 為 0、不明為 undefined', () => {
  const byId = new Map(parseSearch(searchHtml, 27386).items.map(i => [i.id, i]));
  const paid = byId.get('100000000001');
  assert.equal(paid.itemPrice, 2475);
  assert.equal(paid.shipping, 16.64);
  assert.ok(Math.abs(paid.price - 2491.64) < 1e-9);

  const free = byId.get('100000000002');
  assert.equal(free.shipping, 0);
  assert.equal(free.price, 1000);

  const unknown = byId.get('100000000010');
  assert.equal(unknown.shipping, undefined);
  assert.equal(unknown.price, 300);
});

test('好評率與評價數：% positive (N) / 6.9K / 逗號；解析不出來給 undefined', () => {
  const byId = new Map(parseSearch(searchHtml, 27386).items.map(i => [i.id, i]));
  assert.deepEqual([byId.get('100000000001').seller, byId.get('100000000001').feedbackPct, byId.get('100000000001').feedbackCount], ['alaperha2', 100, 90]);
  assert.deepEqual([byId.get('100000000002').seller, byId.get('100000000002').feedbackPct, byId.get('100000000002').feedbackCount], ['jw.it.partners', 99.9, 6900]);
  assert.equal(byId.get('100000000004').feedbackCount, 1234);
  assert.equal(byId.get('100000000010').seller, undefined);
  assert.equal(byId.get('100000000010').feedbackPct, undefined);
  assert.equal(byId.get('100000000010').feedbackCount, undefined);
});

test('價格區間（$100.00 to $200.00）整筆略過', () => {
  const { items } = parseSearch(searchHtml, 27386);
  assert.ok(!items.some(i => i.id === '100000000009'));
});

test('其他欄位：bestOffer、ref（Was: 且大於售價）、listedAt、url、cartUrl', () => {
  const byId = new Map(parseSearch(searchHtml, 27386).items.map(i => [i.id, i]));
  const one = byId.get('100000000001');
  assert.equal(one.bestOffer, true);
  assert.equal(one.listedAt, 'Oct-30 09:24');
  assert.equal(one.url, 'https://www.ebay.com/itm/100000000001');
  assert.equal(one.cartUrl, null);
  assert.equal(one.ref, undefined);
  assert.equal(one.inStock, true);

  assert.equal(byId.get('100000000011').ref, 1299);
  assert.equal(byId.get('100000000011').price, 999);
  assert.equal(byId.get('100000000002').bestOffer, false);
});

test('minPrice / maxPrice 在本地用 itemPrice 過濾（不含運費），total 不變', async () => {
  const browser = fakeBrowser(searchHtml);
  configure({ browser, gapMs: 0 });
  const result = await search({ query: 'rtx 5080', minPrice: 1000 });
  assert.equal(result.total, 42);
  assert.deepEqual(result.items.map(i => i.id).sort(), ['100000000001', '100000000002', '100000000003']);
  // 990 + 20 運費 = 1010，但 itemPrice 990 < 1000，不能用總價偷渡
  assert.ok(!result.items.some(i => i.id === '100000000012'));
});

test('錯誤頁：隔 gapMs 重試一次，還是錯誤頁就丟 Blocked', async () => {
  const browser = fakeBrowser(ERROR_PAGE);
  configure({ browser, gapMs: 0 });
  await assert.rejects(search({ query: 'rtx 5080' }), err =>
    err instanceof Blocked && /請求太密/.test(err.message));
  assert.equal(browser.calls.length, 2);
});

test('錯誤頁重試一次就成功', async () => {
  const browser = fakeBrowser((url, n) => (n === 1 ? ERROR_PAGE : searchHtml));
  configure({ browser, gapMs: 0 });
  const result = await search({ query: 'rtx 5080' });
  assert.equal(browser.calls.length, 2);
  assert.equal(result.items.length, 11);
});

test('人機驗證頁：不重試、不破解，丟 Blocked 並保留頁面、帶到最前面', async () => {
  const browser = fakeBrowser(CHALLENGE_PAGE);
  configure({ browser, gapMs: 0 });
  await assert.rejects(search({ query: 'rtx 5080' }), err =>
    err instanceof Blocked && /人機驗證/.test(err.message));
  assert.equal(browser.calls.length, 1);
  assert.equal(browser.hold, true);
  assert.equal(browser.keepOpen, true);
  assert.equal(browser.focused, 1);
});

test('成功載入後把 hold 放掉', async () => {
  const browser = fakeBrowser(searchHtml);
  browser.hold = true;
  configure({ browser, gapMs: 0 });
  await search({ query: 'rtx 5080' });
  assert.equal(browser.hold, false);
});

test('查無結果回 { total: 0, items: [] }', async () => {
  const parsed = parseSearch(NO_RESULTS);
  assert.deepEqual(parsed, { total: 0, items: [] });
  const browser = fakeBrowser(NO_RESULTS);
  configure({ browser, gapMs: 0 });
  assert.deepEqual(await search({ query: 'rtx 9999' }), { total: 0, items: [] });
});

test('沒有瀏覽器時 search / product 都丟 RequestError(config)', async () => {
  configure({ browser: null });
  for (const run of [() => search({ query: 'rtx' }), () => product('287692386049')]) {
    await assert.rejects(run(), err =>
      err instanceof RequestError && err.code === 'config' && /需要瀏覽器/.test(err.message));
  }
});

test('分類代號對應的 type 能讓五個分類都比對成功', () => {
  const cases = [
    [27386, 'graphics card'],
    [177, 'laptop'],
    [179, 'desktop gaming pc'],
    [164, 'processor'],
    [170083, 'memory'],
  ];
  for (const [category, type] of cases) {
    const { items } = parseSearch(searchHtml, category);
    assert.equal(items[0].type, type, String(category));
  }
  // 沒有分類時從標題猜
  assert.equal(parseSearch(searchHtml).items[0].type, 'graphics card');
  assert.equal(parseSearch('<li class="s-card" data-listingid="1"><div class="s-card__title"><span>ASUS ROG Zephyrus G16 RTX 5080 Gaming Laptop</span></div><span class="s-card__price">$2,000.00</span></li>').items[0].type, 'laptop');
});

test('商品頁解析：JSON-LD 的標題／價格／狀況／庫存＋頁面賣家與運費', async () => {
  const browser = fakeBrowser(itemHtml);
  configure({ browser, gapMs: 0 });
  const items = await product('287692386049');
  assert.equal(browser.calls.length, 1);
  assert.equal(browser.calls[0], 'https://www.ebay.com/itm/287692386049');
  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.key, 'eb:287692386049');
  assert.equal(item.name, 'MSI NVIDIA GeForce RTX 5080 16GB GDDR7 VENTUS 3X OC WHITE Graphics Card');
  assert.equal(item.itemPrice, 1999);
  assert.equal(item.shipping, 0);
  assert.equal(item.price, 1999);
  assert.equal(item.seller, 'jw.it.partners');
  assert.equal(item.feedbackPct, 99.9);
  assert.equal(item.feedbackCount, 6986);
  assert.deepEqual([item.kind, item.cond], ['new', 'New']);
  assert.equal(item.inStock, true);
  assert.equal(item.type, 'graphics card');
  assert.equal(item.url, 'https://www.ebay.com/itm/287692386049');
  assert.equal(item.cartUrl, null);
  assert.equal(item.listedAt, '2026-10-30T21:35:13Z');
});

test('商品頁解析：找不到商品資料回 []；已結束／售完 inStock 為 false', async () => {
  assert.deepEqual(parseItem('<html><body>nothing here</body></html>', '1'), []);

  const ended = `<html><head><title>Old GPU | eBay</title>
    <script type="application/ld+json">${JSON.stringify({
      '@type': 'Product',
      name: 'Old GeForce RTX 3080',
      offers: { '@type': 'Offer', price: '499.00', itemCondition: 'https://schema.org/UsedCondition', availability: 'https://schema.org/OutOfStock' },
    })}</script></head><body></body></html>`;
  const [item] = parseItem(ended, '42');
  assert.equal(item.inStock, false);
  assert.deepEqual([item.kind, item.cond], ['refurb', 'Used']);
  assert.equal(item.price, 499);
});

test('同時多個搜尋會排隊，兩次載入至少間隔 gapMs', async () => {
  const stamps = [];
  const browser = {
    hold: false,
    html: async () => { stamps.push(Date.now()); return searchHtml; },
    focus: async () => {},
  };
  configure({ browser, gapMs: 80 });
  const [a, b] = await Promise.all([search({ query: 'a' }), search({ query: 'b' })]);
  assert.equal(a.items.length, 11);
  assert.equal(b.items.length, 11);
  assert.equal(stamps.length, 2);
  assert.ok(stamps[1] - stamps[0] >= 60, `間隔只有 ${stamps[1] - stamps[0]}ms`);
});

test('多規格價格區間（拆分 span、巢狀 span、破折號、var 參數、See options）整筆略過', () => {
  const card = (id, body) => `<li class="s-card" data-listingid="${id}">${body}</li>`;
  const title = '<div class="s-card__title"><span>Core-Ultra 9 285K Gaming Ai Workstation PC</span></div>';
  const html = [
    // 1. 多規格拆成多個 s-card__price span
    card('1', `${title}<div class="s-card__attribute-row"><span class="s-card__price">$2,799.55</span><span> to </span><span class="s-card__price">$4,759.99</span></div>`),
    // 2. 巢狀 span 包在 s-card__price 裡
    card('2', `${title}<div class="s-card__attribute-row"><span class="s-card__price"><span>$2,799.55</span><span> to </span><span>$4,759.99</span></span></div>`),
    // 3. 破折號區間
    card('3', `${title}<div class="s-card__attribute-row"><span class="s-card__price">$100.00 - $200.00</span></div>`),
    // 4. 連結含 var= 多規格參數
    card('4', `<a href="https://www.ebay.com/itm/4?var=123456">${title}</a><div class="s-card__attribute-row"><span class="s-card__price">$2,799.55</span></div>`),
    // 5. 屬性列含 See options
    card('5', `${title}<div class="s-card__attribute-row"><span class="s-card__price">$2,799.55</span></div><div class="s-card__attribute-row"><span>See options</span></div>`),
  ].join('');
  assert.deepEqual(parseSearch(html, 179).items, []);
});

test('競標卡片略過；正常直購含 Only 2 left / Free delivery / Was 原價不誤殺', () => {
  const card = (id, body) => `<li class="s-card" data-listingid="${id}">${body}</li>`;
  const title = '<div class="s-card__title"><span>Core Ultra 9 285K Gaming PC RTX 5090</span></div>';
  const html = [
    card('1', `${title}<div class="s-card__attribute-row"><span class="s-card__price">$3,908.50</span></div><div class="s-card__attribute-row"><span>0 bids</span></div>`),
    card('2', `${title}<div class="s-card__attribute-row"><span class="s-card__price">$3,908.50</span></div><div class="s-card__attribute-row"><span>5 bids</span></div>`),
    card('3', `${title}<div class="s-card__attribute-row"><span class="s-card__price">$3,908.50</span></div><div class="s-card__attribute-row"><span>or Buy It Now</span></div>`),
    card('4', `${title}<div class="s-card__attribute-row"><span class="s-card__price">$3,908.50</span></div><div class="s-card__attribute-row"><span>6d 12h left</span></div>`),
    card('5', `${title}<div class="s-card__attribute-row"><span class="s-card__price">$3,908.50</span></div><div class="s-card__attribute-row"><span>Time left: 2h 10m</span></div>`),
    card('6', `${title}<div class="s-card__attribute-row"><span class="s-card__price">$3,908.50</span></div><div class="s-card__attribute-row"><span>Starting bid</span></div>`),
    card('7', `${title}<span class="s-card__price">$3,908.50</span><span class="s-card__bids">1 bid</span>`),
    // 競標價 + 一口價雙 s-card__price
    card('8', `${title}<div class="s-card__attribute-row"><span class="s-card__price">$2,500.00</span></div><div class="s-card__attribute-row"><span class="s-card__price">$4,500.00</span></div>`),
    // 正常直購（不應誤殺）
    card('9', `${title}<div class="s-card__attribute-row"><span>Was: $5,299.00</span></div><div class="s-card__attribute-row"><span class="s-card__price">$4,759.99</span></div><div class="s-card__attribute-row"><span>Only 2 left</span></div><div class="s-card__attribute-row"><span>Free delivery in 2-4 days</span></div>`),
  ].join('');
  const { items } = parseSearch(html, 179);
  assert.deepEqual(items.map(i => [i.id, i.price, i.ref]), [['9', 4759.99, 5299]]);
});

test('單品頁 parseItem 辨識多規格（x-msku / AggregateOffer）與競標；script/style 不誤判', () => {
  // 多規格 x-msku-evo 下拉選單
  const mskuHtml = `<html><head><title>PC | eBay</title></head><body>
    <h1>Core-Ultra 9 285K PC</h1>
    <div class="x-price-primary"><span>US $2,799.55</span></div>
    <div class="x-msku-evo"><select><option>RTX 5080</option></select></div>
  </body></html>`;
  assert.equal(parseItem(mskuHtml, '128216406996')[0].multiVariation, true);

  // AggregateOffer JSON-LD
  const aggHtml = `<html><head><title>PC | eBay</title>
    <script type="application/ld+json">${JSON.stringify({
      '@type': 'Product',
      name: 'Core-Ultra 9 285K PC',
      offers: { '@type': 'AggregateOffer', lowPrice: '2799.55', highPrice: '4759.99', offerCount: 2, availability: 'https://schema.org/InStock' },
    })}</script></head><body></body></html>`;
  const [agg] = parseItem(aggHtml, '128216406996');
  assert.equal(agg.multiVariation, true);
  assert.equal(agg.itemPrice, 2799.55);

  // 競標商品頁
  const bidHtml = `<html><head><title>PC | eBay</title></head><body>
    <h1>Core Ultra 9 285K PC</h1>
    <div class="x-price-primary"><span>US $3,908.50</span></div>
    <div class="x-bid-price">Current bid</div>
    <button data-testid="x-bid-action">Place bid</button>
  </body></html>`;
  assert.equal(parseItem(bidHtml, '128214374878')[0].auction, true);

  // 僅在 <script> / <style> 提及 x-msku 或 place bid 不誤判
  const cleanHtml = `<html><head><title>PC | eBay</title>
    <style>.x-msku-evo { display: none; }</style>
    <script>window.__cfg = { msku: "x-msku", bid: "place bid", cls: "x-bid-price" };</script>
    <script type="application/ld+json">${JSON.stringify({
      '@type': 'Product',
      name: 'RTX 5080 PC',
      offers: { '@type': 'Offer', price: '4759.99', availability: 'https://schema.org/InStock' },
    })}</script></head><body><h1>RTX 5080 PC</h1></body></html>`;
  const [clean] = parseItem(cleanHtml, '999999999999');
  assert.equal(clean.auction, undefined);
  assert.equal(clean.multiVariation, undefined);
});
