// Micro Center 模組的離線測試：用假的 browser.html 餵入縮小過的搜尋頁／商品頁。
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configure, search, product, searchUrl, parseSearch, parseProduct } from '../src/microcenter.mjs';
import { Blocked, RequestError } from '../src/http.mjs';
import { evaluate } from '../src/specs.mjs';
import config from '../config.mjs';

const read = name => fs.readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
const searchHtml = read('microcenter-search.html');
const openBoxHtml = read('microcenter-openbox.html');
const productHtml = read('microcenter-product.html');
const shipHtml = read('microcenter-product-ship.html');

const EMPTY = '<div class="searchInfoBar">0 Results for "zzz"</div><span class="productSearchCount">0</span>';

function mock(handler) {
  const calls = [];
  const browser = {
    hold: false,
    keepOpen: false,
    focused: false,
    async html(url) {
      calls.push(String(url));
      return typeof handler === 'function' ? handler(String(url)) : handler;
    },
    async focus() { browser.focused = true; },
  };
  return { browser, calls };
}

const searchMock = () => mock(url => (url.includes('fq=') ? openBoxHtml : searchHtml));

beforeEach(() => configure({ browser: null, storeId: '165', gapMs: 0 }));

test('搜尋網址：門市代號、每頁 96 筆、最新排序、含缺貨；open-box 用 fq 篩選', () => {
  configure({ storeId: '025', gapMs: 0 });
  assert.equal(searchUrl({ query: 'rtx 5080' }), 'https://www.microcenter.com/search/search_results.aspx?Ntt=rtx+5080&storeid=025&rpp=96&sortby=newest&myStore=false');
  assert.equal(searchUrl({ query: 'rtx 5080', openBox: true }), 'https://www.microcenter.com/search/search_results.aspx?Ntt=rtx+5080&storeid=025&rpp=96&sortby=newest&myStore=false&fq=Valuable+Links:Open+Box');
  // 空白與特殊字元要編碼
  assert.ok(searchUrl({ query: 'a & b' }).includes('Ntt=a+%26+b&'));
});

test('搜尋頁解析商品欄位（id / 名稱 / 價格 / 品牌 / SKU / 分類 / 網址）', async () => {
  const { browser, calls } = searchMock();
  configure({ browser, storeId: '165', gapMs: 0 });
  const result = await search({ query: 'rtx 5080' });

  // 一般搜尋頁只看到 1 個 open-box，站方公告 2 個，所以要再載入一次 open-box 篩選頁
  assert.equal(calls.length, 2);
  assert.equal(calls[0], searchUrl({ query: 'rtx 5080' }));
  assert.equal(calls[1], searchUrl({ query: 'rtx 5080', openBox: true }));
  assert.equal(result.total, 9);
  assert.equal(result.items.length, 12);

  const byKey = new Map(result.items.map(i => [i.key, i]));
  const gpu = byKey.get('mc:689735');
  assert.equal(gpu.name, 'ASUS NVIDIA GeForce RTX 5080 ROG Astral Overclocked Triple Fan 16GB GDDR7 PCIe 5.0 Graphics Card');
  assert.equal(gpu.brand, 'ASUS');
  assert.equal(gpu.sku, '793182');
  assert.equal(gpu.type, 'Graphics Cards');
  assert.equal(gpu.price, 2699.99);
  assert.equal(gpu.ref, undefined);
  assert.equal(gpu.inStock, true);
  assert.equal(gpu.pickupOnly, true);
  assert.equal(gpu.seller, 'Micro Center');
  assert.equal(gpu.cartUrl, null);
  assert.equal(gpu.url, 'https://www.microcenter.com/product/689735/asus-nvidia-geforce-rtx-5080-rog-astral-overclocked-triple-fan-16gb-gddr7-pcie-50-graphics-card');

  // 品牌已在 data-name 裡時不重複加
  assert.match(byKey.get('mc:711400').name, /^PowerSpec G765 Gaming PC/);
  // data-name 沒有品牌時補上
  assert.match(byKey.get('mc:715907').name, /^G\.Skill Flare X5 Series/);
});

test('原價只在劃線價大於售價時才給；Open Box 另外一筆', async () => {
  const { browser } = searchMock();
  configure({ browser, storeId: '165', gapMs: 0 });
  const { items } = await search({ query: 'rtx 5080' });
  const byKey = new Map(items.map(i => [i.key, i]));

  assert.equal(byKey.get('mc:690477').price, 1979.99);
  assert.equal(byKey.get('mc:690477').ref, 2349.99);
  assert.equal(byKey.get('mc:709072').ref, 3499.99);
  assert.equal(byKey.get('mc:715907').ref, 1999.99);
  assert.equal(byKey.get('mc:689735').ref, undefined);

  const ob = byKey.get('mc:708684:ob');
  assert.equal(ob.kind, 'ob');
  assert.equal(ob.cond, 'Open-Box');
  assert.equal(ob.price, 3824.96);
  assert.equal(ob.ref, 4499.99);
  assert.equal(ob.inStock, true);
  assert.equal(ob.pickupOnly, true);
  // 同一件商品的新品與 open-box 是兩筆
  assert.equal(byKey.get('mc:708684').kind, 'new');
  assert.equal(byKey.get('mc:708684').price, 4499.99);

  // open-box 篩選頁重複出現的商品要去重，只留一筆
  assert.equal(items.filter(i => i.key === 'mc:708684:ob').length, 1);
  // 只在篩選頁出現的商品要補進來
  assert.equal(byKey.get('mc:713641:ob').price, 5039.96);
  assert.equal(byKey.get('mc:713641:ob').ref, 5599.99);
});

test('minPrice / maxPrice 在本地過濾，total 仍回報網站總數', async () => {
  const { browser } = searchMock();
  configure({ browser, storeId: '165', gapMs: 0 });
  const { items, total } = await search({ query: 'rtx 5080', minPrice: 500, maxPrice: 3000 });
  assert.equal(total, 9);
  assert.ok(items.length > 0);
  for (const item of items) assert.ok(item.price >= 500 && item.price <= 3000, `${item.key} 價格 ${item.price}`);
  assert.ok(!items.some(i => i.key === 'mc:713641:ob'));
});

test('庫存判斷：IN STOCK / SOLD OUT / NOT CARRIED', async () => {
  const { browser } = searchMock();
  configure({ browser, storeId: '165', gapMs: 0 });
  const { items } = await search({ query: 'rtx 5080' });
  const byKey = new Map(items.map(i => [i.key, i]));
  assert.equal(byKey.get('mc:689735').inStock, true);
  assert.equal(byKey.get('mc:706502').inStock, false); // SOLD OUT
  assert.equal(byKey.get('mc:693509').inStock, false); // NOT CARRIED，沒有 forms
  assert.equal(byKey.get('mc:693509').kind, 'refurb');
  assert.equal(byKey.get('mc:693509').cond, 'Refurb');
  assert.equal(byKey.get('mc:693509').pickupOnly, false);
});

test('原價規則：劃線價等於或小於售價時不給 ref', () => {
  const block = (id, price, strike) => `
    <li id="pwrapper_${id}" class="product_wrapper">
      <div class="result_left">
        <a href="#" class="favorite" data-name="Test Graphics Card" data-id="${id}" data-price="${price}" data-brand="Test" data-category="Graphics Cards" data-core="Graphics Cards"></a>
        <a href="/product/${id}/test-graphics-card"><img src="x.jpg"></a>
      </div>
      <p class="sku">SKU: 000${id}</p>
      <div class="price_wrapper">
        <div class="stock">1 <span class="msgInStock">IN STOCK</span></div>
        <div class="price">${strike == null ? '' : `<div class="standardDiscount"><strike>$${strike}</strike></div>`}<span>$${price}</span></div>
        <div class="rebate-price"></div>
        <div class="clearance"></div>
        <div class="mapped"></div>
      </div>
    </li>`;
  const { items } = parseSearch(`<div class="searchInfoBar">3 Results for "x"</div>${block(1, 100, 100)}${block(2, 100, 90)}${block(3, 100, 120)}`);
  const byId = new Map(items.map(i => [i.id, i]));
  assert.equal(byId.get('1').ref, undefined);
  assert.equal(byId.get('2').ref, undefined);
  assert.equal(byId.get('3').ref, 120);
});

test('五個分類的 type 都能被 config 的正規式比對', async () => {
  const { browser } = searchMock();
  configure({ browser, storeId: '165', gapMs: 0 });
  const { items } = await search({ query: 'rtx 5080' });
  const byKey = new Map(items.map(i => [i.key, i]));
  const cases = [
    ['gpu', 'mc:689735', /graphics card|video card|gpu/i],
    ['laptop', 'mc:709072', /laptop|notebook/i],
    ['desktop', 'mc:711400', /desktop|gaming pc|tower/i],
    ['cpu', 'mc:712994', /processor|cpu/i],
    ['ram', 'mc:715907', /memory|ram/i],
  ];
  for (const [cat, key, pattern] of cases) {
    const item = byKey.get(key);
    assert.match(item.type, pattern, `${cat} 的 type 應可比對`);
    assert.ok(evaluate(config.categories[cat], item), `${cat} 應分類成功`);
  }
});

test('人機驗證頁丟 Blocked，保留頁面、帶到最前面', async () => {
  for (const html of [
    '<html><head><title>Just a moment...</title></head></html>',
    '<html><head><title>Access Denied</title></head></html>',
    '<html><body>Pardon Our Interruption</body></html>',
  ]) {
    const { browser } = mock(() => html);
    configure({ browser, storeId: '165', gapMs: 0 });
    await assert.rejects(search({ query: 'rtx' }), err => err instanceof Blocked && err.code === 'blocked' && /瀏覽器/.test(err.message));
    assert.equal(browser.hold, true);
    assert.equal(browser.keepOpen, true);
    assert.equal(browser.focused, true);
  }
});

test('攔截頁幾秒後自己換成正常頁面就不算被擋，也不重新載入', async () => {
  const blocked = '<html><head><title>Just a moment...</title></head></html>';
  const { browser, calls } = mock(url => (url.includes('fq=') ? openBoxHtml : blocked));
  let reads = 0;
  browser.currentHtml = async () => (++reads === 1 ? blocked : searchHtml);
  configure({ browser, storeId: '165', gapMs: 0, recheckMs: [0, 0] });
  const { items } = await search({ query: 'rtx' });
  assert.ok(items.length > 0);
  assert.equal(reads, 2);
  assert.equal(browser.hold, false);
  assert.equal(calls.filter(url => !url.includes('fq=')).length, 1);
});

test('一直是攔截頁才算被擋，訊息帶頁面標題', async () => {
  const blocked = '<html><head><title>Just a moment...</title></head></html>';
  const { browser } = mock(() => blocked);
  let reads = 0;
  browser.currentHtml = async () => { reads++; return blocked; };
  configure({ browser, storeId: '165', gapMs: 0, recheckMs: [0, 0] });
  await assert.rejects(search({ query: 'rtx' }), err => err instanceof Blocked && /人機驗證.*Just a moment/.test(err.message));
  assert.equal(reads, 2);
  assert.equal(browser.hold, true);
});

test('查無結果回 { total: 0, items: [] }，不是錯誤，也不再載入 open-box 頁', async () => {
  const { browser, calls } = mock(() => EMPTY);
  configure({ browser, storeId: '165', gapMs: 0 });
  assert.deepEqual(await search({ query: 'zzz' }), { total: 0, items: [] });
  assert.equal(calls.length, 1);
});

test('沒有瀏覽器時 search / product 丟 RequestError(config)', async () => {
  configure({ browser: null, gapMs: 0 });
  await assert.rejects(search({ query: 'rtx' }), err =>
    err instanceof RequestError && err.code === 'config' && /需要瀏覽器/.test(err.message));
  await assert.rejects(product('689735'), err =>
    err instanceof RequestError && err.code === 'config' && /需要瀏覽器/.test(err.message));
});

test('product() 載入商品頁，解析新品、原價、庫存與 open-box', async () => {
  const { browser, calls } = mock(() => productHtml);
  configure({ browser, storeId: '165', gapMs: 0 });
  const items = await product('708684');

  assert.equal(calls.length, 1);
  assert.equal(calls[0], 'https://www.microcenter.com/product/708684/x?storeid=165');
  assert.equal(items.length, 2);

  const nw = items.find(i => i.kind === 'new');
  assert.equal(nw.key, 'mc:708684');
  assert.equal(nw.cond, 'New');
  assert.match(nw.name, /^Lenovo Legion Pro 7/);
  assert.equal(nw.brand, 'Lenovo');
  assert.equal(nw.sku, '007518'); // 頁面上的 SKU，保留前導零
  assert.equal(nw.type, 'Laptops/Notebooks');
  assert.equal(nw.price, 4499.99);
  assert.equal(nw.ref, 5599.99);
  assert.equal(nw.inStock, true);
  assert.equal(nw.pickupOnly, true);
  assert.equal(nw.url, 'https://www.microcenter.com/product/708684/lenovo-legion-pro-7-16iax10h-oled-16-gaming-laptop-computer-eclipse-black');

  const ob = items.find(i => i.kind === 'ob');
  assert.equal(ob.key, 'mc:708684:ob');
  assert.equal(ob.cond, 'Open-Box');
  assert.equal(ob.price, 3824.96);
  assert.equal(ob.ref, 4499.99);
  assert.equal(ob.inStock, true);
  assert.equal(ob.pickupOnly, true);
});

test('商品頁可運送時 pickupOnly 為 false；沒有折扣就沒有 ref', () => {
  const items = parseProduct(shipHtml, '711875');
  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.pickupOnly, false);
  assert.equal(item.inStock, true);
  assert.equal(item.ref, undefined);
  assert.equal(item.type, 'Desktop Computers');
  assert.equal(item.sku, '048348');
  assert.equal(item.url, 'https://www.microcenter.com/product/711875/asus-rog-g1000-2026-gm1000-gaming-pc');
});

test('商品頁 SOLD OUT 時 inStock 為 false', () => {
  const html = productHtml
    .replace('https://schema.org/InStock', 'https://schema.org/OutOfStock')
    .replace('<span class="inventoryCnt">2 <span class="msgInStock">NEW IN STOCK</span></span>', 'SOLD OUT');
  const items = parseProduct(html, '708684');
  assert.equal(items.find(i => i.kind === 'new').inStock, false);
});

test('找不到商品回 []', async () => {
  const { browser } = mock(() => '<html><body>Not found</body></html>');
  configure({ browser, storeId: '165', gapMs: 0 });
  assert.deepEqual(await product('999'), []);
  assert.deepEqual(parseProduct('<html><body>no data</body></html>', '999'), []);
});

test('多個搜尋會排隊，兩次載入至少間隔 gapMs', async () => {
  const times = [];
  const browser = {
    hold: false,
    async html() {
      times.push(Date.now());
      await new Promise(resolve => setTimeout(resolve, 5));
      return EMPTY;
    },
    async focus() {},
  };
  configure({ browser, storeId: '165', gapMs: 50 });
  await Promise.all([search({ query: 'a' }), search({ query: 'b' })]);
  assert.equal(times.length, 2);
  assert.ok(times[1] - times[0] >= 45, `兩次載入只隔 ${times[1] - times[0]}ms`);
});
