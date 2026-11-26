import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { get, requireSuccess, Blocked, setPace } from '../src/http.mjs';
import * as bestbuy from '../src/bestbuy.mjs';
import * as walmart from '../src/walmart.mjs';

setPace('wm', 1, 0);

test('DNS、TLS、timeout 錯誤保留可供診斷的分類', async () => {
  for (const [cause, code] of [['ENOTFOUND', 'dns'], ['CERT_HAS_EXPIRED', 'tls'], ['UND_ERR_CONNECT_TIMEOUT', 'timeout'], ['ECONNRESET', 'network']]) {
    await assert.rejects(get('bb', 'https://example.invalid', { retries: 0, fetchImpl: async () => { throw new TypeError('fetch failed', { cause: { code: cause } }); } }), e => e.code === code);
  }
});

test('實際本機 HTTP 伺服器逾時會結束請求', async t => {
  const server = http.createServer(() => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await assert.rejects(get('bb', `http://127.0.0.1:${server.address().port}`, { timeout: 50, retries: 0 }), e => e.code === 'timeout');
});

test('403／412／429 是 blocked；503 是 HTTP 服務錯誤', () => {
  for (const status of [403, 412, 429]) assert.throws(() => requireSuccess('商店', { status }), e => e instanceof Blocked && e.status === status);
  assert.throws(() => requireSuccess('商店', { status: 503 }), e => e.code === 'http' && e.status === 503);
});

test('Best Buy 區分格式錯誤、GraphQL 錯誤和有效空結果', async () => {
  const search = body => bestbuy.search({ query: 'example' }, { retries: 0, fetchImpl: async () => new Response(body) });
  for (const body of ['null', '[]', '{}', '<html>maintenance</html>', '{"data":{"search":{}}}']) await assert.rejects(search(body), e => e.code === 'format');
  await assert.rejects(search('{"errors":[{"message":"bad query"}]}'), e => e.code === 'upstream');
  assert.deepEqual(await search('{"data":{"search":{"documents":null,"numFound":0}}}'), { total: 0, items: [] });
});

test('Best Buy open-box 商品連結不重複附加路徑或成色參數', () => {
  const existing = bestbuy.openBoxUrl('https://www.bestbuy.com/product/example/sku/123/openbox?condition=fair', 'Good');
  const bare = bestbuy.openBoxUrl('/product/example/sku/123', 'Good');
  assert.equal(existing, 'https://www.bestbuy.com/product/example/sku/123/openbox?condition=good');
  assert.equal(bare, existing);
});

test('Best Buy 價格可查時仍明確標示庫存未知', async () => {
  const product = { skuId: '123', name: { short: 'Example' }, price: { customerPrice: 500 }, url: { pdp: '/product/example/sku/123' } };
  const result = await bestbuy.search({ query: 'example' }, { retries: 0, fetchImpl: async () => new Response(JSON.stringify({ data: { search: { numFound: 1, documents: [{ product }] } } })) });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].stockKnown, false);
});

test('Best Buy onlyOpenBox 不帶 condition_facet 也能抽 buyingOptions，且保留停產新品的清倉 Open-Box', async () => {
  const seenUrls = [];
  const docActive = {
    product: {
      skuId: '101',
      dotComDisplayStatus: 'active',
      name: { short: 'Lenovo Legion 5i RTX 5060 Gaming Laptop' },
      whatItIs: ['Laptop Computer'],
      price: { customerPrice: 1199.99, displayableRegularPrice: 1199.99 },
      url: { pdp: '/product/legion/sku/101' },
      buyingOptions: [
        { type: 'Fair', pdpUrl: '/product/legion/sku/101', product: { openBoxCondition: 0, price: { customerPrice: 950 } } },
        { type: 'Good', pdpUrl: '/product/legion/sku/101', product: { openBoxCondition: 1, price: { customerPrice: 1020 } } },
      ],
    },
  };
  const docInactive = {
    product: {
      skuId: '202',
      dotComDisplayStatus: 'inactive',
      name: { short: 'Razer Blade 14 RTX 4070 Gaming Laptop' },
      whatItIs: ['Laptop Computer'],
      price: { customerPrice: null, displayableRegularPrice: 2599.99 },
      url: { pdp: '/product/razer/sku/202' },
      buyingOptions: [
        { type: 'Fair', pdpUrl: '/product/razer/sku/202', product: { openBoxCondition: 0, price: { customerPrice: 1699.99 } } },
      ],
    },
  };
  const docNoOb = {
    product: {
      skuId: '303',
      dotComDisplayStatus: 'active',
      name: { short: 'New Only Laptop' },
      price: { customerPrice: 999 },
      url: { pdp: '/product/new/sku/303' },
      buyingOptions: [],
    },
  };
  const body = JSON.stringify({ data: { search: { numFound: 3, documents: [docActive, docInactive, docNoOb] } } });
  const result = await bestbuy.search({ query: 'gaming laptop', condition: null, onlyOpenBox: true }, {
    retries: 0,
    fetchImpl: async url => { seenUrls.push(String(url)); return new Response(body); },
  });
  const vars = JSON.parse(new URL(seenUrls[0]).searchParams.get('variables'));
  assert.deepEqual(vars.filter.facets, [], 'onlyOpenBox 不應帶 condition_facet');
  assert.equal(result.items.length, 2, '應只抽出有 Open-Box buyingOptions 的兩筆');
  assert.equal(result.items[0].key, 'bb:101:ob');
  assert.equal(result.items[0].price, 950);
  assert.equal(result.items[0].inStock, true);
  assert.equal(result.items[1].key, 'bb:202:ob');
  assert.equal(result.items[1].inStock, true, '新品 inactive 時清倉 Open-Box 仍應保留');
  assert.equal(result.items[1].ref, 2599.99);
});

test('Walmart 驗證頁、非 JSON、缺少搜尋結構都不會誤報成功', () => {
  assert.throws(() => walmart.parse('<div id="px-captcha"></div>'), e => e.code === 'blocked');
  for (const body of ['<html></html>', '<script id="__NEXT_DATA__">bad</script>', '<script id="__NEXT_DATA__">{}</script>']) assert.throws(() => walmart.parse(body), e => e.code === 'format');
  const data = { props: { pageProps: { initialData: { searchResult: { itemStacks: [] } } } } };
  assert.deepEqual(walmart.parse(`<script type="application/json" id='__NEXT_DATA__'>${JSON.stringify(data)}</script>`), []);
});

test('Walmart HTTP 模式不啟動瀏覽器；重新 configure 清除之前被擋的狀態', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; walmart.configure({ via: 'http' }); });
  let browserCalls = 0;
  const empty = '<script id="__NEXT_DATA__">{"props":{"pageProps":{"initialData":{"searchResult":{"itemStacks":[]}}}}}</script>';
  globalThis.fetch = async () => new Response('blocked', { status: 403 });
  walmart.configure({ via: 'auto', browser: { html: async () => { browserCalls++; return empty; } } });
  await walmart.search({ query: 'example' });
  assert.equal(browserCalls, 1);
  walmart.configure({ via: 'http', browser: { html: () => assert.fail('HTTP 模式不應使用瀏覽器') } });
  globalThis.fetch = async () => new Response(empty);
  assert.deepEqual(await walmart.search({ query: 'example' }), { total: 0, items: [] });
});
