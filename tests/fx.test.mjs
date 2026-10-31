// 當地幣別換算成美金：eBay 依連線的國家顯示當地幣別，不能把數字直接當美金。
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setRates, usdRate } from '../src/fx.mjs';
import { configure, currencyOf, parseSearch, search } from '../src/ebay.mjs';
import { RequestError } from '../src/http.mjs';

const card = (id, price, extra = '') => `<li class="s-card" data-listingid="${id}"><div class="s-card__title"><span>PNY GeForce RTX 5080 16GB</span></div><span class="s-card__price">${price}</span><div class="s-card__attribute-row"><span>${extra}</span></div></li>`;
const page = (...cards) => `<html><head><title>rtx 5080 | eBay</title></head><body><ul>${cards.join('')}</ul></body></html>`;

function fakeBrowser(html) {
  const browser = { calls: [], hold: false, keepOpen: false };
  browser.html = async url => { browser.calls.push(String(url)); return html; };
  browser.focus = async () => {};
  return browser;
}

beforeEach(() => { setRates({ USD: 1, TWD: 32, CAD: 1.25 }); });
afterEach(() => { setRates(null); configure({ browser: null }); });

test('價格文字前面的符號決定幣別', () => {
  for (const [text, code] of [['$2,475.00', 'USD'], ['US $2,475.00', 'USD'], ['NT$ 74,975', 'TWD'], ['C $100.00', 'CAD'], ['AU $100.00', 'AUD'], ['£100.00', 'GBP'], ['€100.00', 'EUR'], ['TWD 74,975', 'TWD']]) {
    assert.equal(currencyOf(text), code, text);
  }
});

test('解析當地幣別：金額、運費、原價都抓得到，幣別跟著記下來', () => {
  const [item] = parseSearch(page(card('123456789012', 'NT$ 64,000', '+NT$ 320 delivery Was: NT$ 80,000')), 27386).items;
  assert.equal(item.currency, 'TWD');
  assert.equal(item.itemPrice, 64000);
  assert.equal(item.shipping, 320);
  assert.equal(item.ref, 80000);
});

test('當地幣別的價格區間整筆略過', () => {
  assert.deepEqual(parseSearch(page(card('123456789012', 'NT$ 64,000 to NT$ 80,000')), 27386).items, []);
});

test('search 回傳的一律是美金：售價、運費、總價、原價', async () => {
  configure({ browser: fakeBrowser(page(card('123456789012', 'NT$ 64,000', '+NT$ 320 delivery Was: NT$ 80,000'))), gapMs: 0 });
  const { items: [item] } = await search({ query: 'rtx 5080' });
  assert.equal(item.currency, 'USD');
  assert.equal(item.itemPrice, 2000);
  assert.equal(item.shipping, 10);
  assert.equal(item.price, 2010);
  assert.equal(item.ref, 2500);
});

test('已經是美金的不換算，也不用抓匯率', async () => {
  setRates(null);
  configure({ browser: fakeBrowser(page(card('123456789012', '$2,475.00', '+$16.64 delivery'))), gapMs: 0 });
  const { items: [item] } = await search({ query: 'rtx 5080' });
  assert.equal(item.itemPrice, 2475);
  assert.equal(item.price, 2491.64);
});

test('價格範圍用美金比，換算後才過濾；下一次的網址換成當地幣別', async () => {
  const browser = fakeBrowser(page(card('123456789012', 'NT$ 3,200'), card('123456789013', 'NT$ 64,000')));
  configure({ browser, gapMs: 0 });
  const first = await search({ query: 'rtx 5080', minPrice: 1000 });
  assert.deepEqual(first.items.map(i => i.itemPrice), [2000]);
  assert.match(browser.calls[0], /_udlo=1000\b/);
  await search({ query: 'rtx 5080', minPrice: 1000 });
  assert.match(browser.calls[1], /_udlo=32000\b/);
});

test('沒有匯率或不認得幣別時報錯，不會把當地幣別當美金', async () => {
  setRates({ USD: 1 });
  configure({ browser: fakeBrowser(page(card('123456789012', 'NT$ 64,000'))), gapMs: 0 });
  await assert.rejects(search({ query: 'rtx 5080' }), err => err instanceof RequestError && /TWD/.test(err.message));

  setRates({ USD: 1, TWD: 32 });
  configure({ browser: fakeBrowser(page(card('123456789012', 'ZZ$ 64,000'))), gapMs: 0 });
  await assert.rejects(search({ query: 'rtx 5080' }), err => err instanceof RequestError && /ZZ\$/.test(err.message));
});

test('匯率一天抓一次；更新失敗沿用舊的，從來沒抓到過才報錯', async () => {
  setRates(null);
  let calls = 0;
  const ok = { fetchImpl: async () => { calls++; return new Response(JSON.stringify({ result: 'success', rates: { USD: 1, TWD: 32 } })); } };
  assert.equal(await usdRate('TWD', ok), 32);
  assert.equal(await usdRate('TWD', ok), 32);
  assert.equal(calls, 1);

  setRates(null);
  const down = { fetchImpl: async () => new Response('', { status: 500 }) };
  await assert.rejects(usdRate('TWD', down), RequestError);
  const garbled = { fetchImpl: async () => new Response('<html>') };
  await assert.rejects(usdRate('TWD', garbled), /格式/);

  const realNow = Date.now;
  try {
    assert.equal(await usdRate('TWD', ok), 32);
    Date.now = () => realNow() + 25 * 36e5;
    assert.equal(await usdRate('TWD', down), 32, '更新失敗沿用舊匯率');
  } finally { Date.now = realNow; }
});
