import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { State } from '../src/state.mjs';
import { addToCart } from '../src/cart.mjs';
import { CHECKOUT_URL } from '../src/bestbuy.mjs';
import { evaluate } from '../src/specs.mjs';
import { judge, makePricer } from '../src/market.mjs';
import config from '../config.mjs';

function makeState(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dealwatch-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new State(dir);
}

test('State.update 支援 alertNew: false 與自訂 dropPct 門檻（eBay 防洗版）', t => {
  const state = makeState(t);
  const baseItem = (id, price) => ({ key: `eb:${id}`, store: 'eb', cat: 'desktop', price });

  // 第一輪先建立分類基準
  assert.deepEqual(state.update('eb', [baseItem('1', 2000)], ['desktop'], { dropPct: 15, alertNew: false }), []);

  // 第二輪上新：alertNew: false 不發 NEW，但仍記錄基準與價格歷史
  const second = baseItem('2', 1000);
  assert.deepEqual(state.update('eb', [baseItem('1', 2000), second], ['desktop'], { dropPct: 15, alertNew: false }), []);
  assert.deepEqual(second.hist, [1000]);

  // 降幅 10%（1000 -> 900）未達 15%，不發 DROP
  assert.deepEqual(state.update('eb', [baseItem('2', 900)], ['desktop'], { dropPct: 15, alertNew: false }), []);

  // 降幅達 20%（900 -> 720 >= 15%），發 DROP
  const drops = state.update('eb', [baseItem('2', 720)], ['desktop'], { dropPct: 15, alertNew: false });
  assert.equal(drops.length, 1);
  assert.equal(drops[0].why, 'DROP');
  assert.equal(drops[0].prev, 900);
});

test('State.replaceLastPrice 與 State.remove 可回滾誤報價格與無效商品紀錄', t => {
  const state = makeState(t);
  state.update('eb', [{ key: 'eb:10', store: 'eb', cat: 'desktop', price: 5000 }], ['desktop'], { dropPct: 15, alertNew: false });
  state.update('eb', [{ key: 'eb:10', store: 'eb', cat: 'desktop', price: 3000 }], ['desktop'], { dropPct: 15, alertNew: false });
  assert.deepEqual(state.items['eb:10'].hist, [5000, 3000]);

  // 更正為較高實價（與前一筆不同）：覆寫最後一筆
  assert.equal(state.replaceLastPrice('eb:10', 4759.99), true);
  assert.deepEqual(state.items['eb:10'].hist, [5000, 4759.99]);

  // 更正回與前一筆完全相同的價格：直接退回前價，不留重複節點
  assert.equal(state.replaceLastPrice('eb:10', 5000), true);
  assert.deepEqual(state.items['eb:10'].hist, [5000]);

  // 移除無效競標／多規格商品
  assert.equal(state.remove('eb:10'), true);
  assert.equal(state.remove('eb:10'), false);
  assert.equal(state.items['eb:10'], undefined);
});

test('addToCart 只會為 Best Buy 導向 Best Buy 結帳頁；Newegg 與 Walmart 各自正確分流', async () => {
  const opened = [];
  const opener = url => opened.push(url);

  // Newegg：只開加入購物車連結，不跳轉 Best Buy 結帳頁
  await addToCart({ store: 'ne', cartUrl: 'https://secure.newegg.com/Shopping/AddtoCart.aspx?Submit=ADD&ItemList=N82E16814137782' }, { goCheckout: true, checkoutDelayMs: 5, opener });
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(opened, ['https://secure.newegg.com/Shopping/AddtoCart.aspx?Submit=ADD&ItemList=N82E16814137782']);
  assert.ok(!opened.includes(CHECKOUT_URL));

  // Walmart：goCheckout 時將 addToCart 換成 buynow
  opened.length = 0;
  await addToCart({ store: 'wm', cartUrl: 'https://affil.walmart.com/cart/addToCart?offers=abc%7C1' }, { goCheckout: true, opener });
  assert.deepEqual(opened, ['https://affil.walmart.com/cart/buynow?offers=abc%7C1']);

  // Best Buy：先開 cartUrl，延遲後開 Best Buy 結帳頁
  opened.length = 0;
  await addToCart({ store: 'bb', cartUrl: 'https://api.bestbuy.com/click/-/1234567/cart' }, { goCheckout: true, checkoutDelayMs: 5, opener });
  assert.deepEqual(opened, ['https://api.bestbuy.com/click/-/1234567/cart', CHECKOUT_URL]);
});

test('GPU 分類納入 RX 9070 XT，並套用 config.steals.override 撿漏門檻', () => {
  const rx9070xt = { store: 'bb', key: 'bb:1:new', cat: 'gpu', type: 'graphics card', name: 'ASRock AMD Radeon RX 9070 XT 16GB Graphics Card', price: 799.99 };
  const rx9070 = { store: 'bb', key: 'bb:2:new', cat: 'gpu', type: 'graphics card', name: 'ASRock AMD Radeon RX 9070 16GB Graphics Card', price: 599.99 };
  const rtx5070 = { store: 'bb', key: 'bb:3:new', cat: 'gpu', type: 'graphics card', name: 'MSI NVIDIA GeForce RTX 5070 12GB Graphics Card', price: 549.99 };
  const specs9070xt = evaluate(config.categories.gpu, rx9070xt);
  assert.equal(specs9070xt?.gpu, 'RX 9070 XT');
  assert.equal(evaluate(config.categories.gpu, rx9070), null);
  assert.equal(evaluate(config.categories.gpu, rtx5070), null);

  const priceOf = makePricer({ prices: {} }, [], config.steals.override);
  const check = (name, price) => {
    const item = { store: 'bb', key: `bb:${name}`, cat: 'gpu', kind: 'new', type: 'graphics card', name, price };
    item.specs = evaluate(config.categories.gpu, item);
    return judge(item, priceOf, config.steals)?.steal;
  };
  assert.equal(check('ASRock AMD Radeon RX 9070 XT 16GB', 800), true);
  assert.equal(check('ASRock AMD Radeon RX 9070 XT 16GB', 801), false);
  assert.equal(check('MSI GeForce RTX 5070 Ti 16GB', 1200), true);
  assert.equal(check('MSI GeForce RTX 5070 Ti 16GB', 1201), false);
  assert.equal(check('ASUS GeForce RTX 5080 16GB', 1500), true);
  assert.equal(check('ASUS GeForce RTX 5080 16GB', 1501), false);
  assert.equal(check('MSI GeForce RTX 5090 32GB', 3200), true);

  const checkCat = (cat, type, name, price) => {
    const item = { store: 'bb', key: `bb:${cat}:${name}`, cat, kind: 'new', type, name, price };
    item.specs = evaluate(config.categories[cat], item);
    return judge(item, priceOf, config.steals)?.steal;
  };
  assert.equal(checkCat('cpu', 'processor', 'AMD Ryzen 7 9800X3D Desktop Processor', 340), true);
  assert.equal(checkCat('cpu', 'processor', 'AMD Ryzen 7 9800X3D Desktop Processor', 341), false);
  assert.equal(checkCat('cpu', 'processor', 'AMD Ryzen 9 9950X3D Desktop Processor', 520), true);
  assert.equal(checkCat('cpu', 'processor', 'Intel Core Ultra 9 285K Processor', 380), true);
  assert.equal(checkCat('ram', 'memory', 'CORSAIR Vengeance 32GB (2x16GB) DDR5 6000', 280), true);
  assert.equal(checkCat('ram', 'memory', 'CORSAIR Vengeance 32GB (2x16GB) DDR5 6000', 281), false);
  assert.equal(checkCat('ram', 'memory', 'G.SKILL Trident Z5 64GB (2x32GB) DDR5 6000', 600), true);
});

test('整機估值套用 buildAllowance $350、desktopMargin 6% 與非全新 10% 折價', () => {
  const priceOf = makePricer({ prices: { 'ssd:1000': 99, 'ssd:2000': 199 } }, [], config.steals.override);
  const checkDesktop = (name, price, { kind = 'new', cond = 'New' } = {}) => {
    const item = { store: 'bb', key: `bb:desk:${name}:${kind}:${price}`, cat: 'desktop', kind, cond, type: 'gaming desktop', name, price };
    item.specs = evaluate(config.categories.desktop, item);
    return judge(item, priceOf, config.steals);
  };

  // 截圖誤報案例 1：Acer Nitro 60 整新品 $2,458.34 不應判為撿漏
  const refurb5070ti = checkDesktop('Acer Nitro 60 Gaming Desktop - Intel Core i7-14700F - 32GB DDR5 - NVIDIA GeForce RTX 5070 Ti - 2TB SSD', 2458.34, { kind: 'refurb', cond: 'Refurb Excellent' });
  assert.equal(refurb5070ti.steal, false);
  assert.match(refurb5070ti.reason, /Refurb Excellent 折 10%/);

  // 同規格全新 5070 Ti 整機約 $2,100 以下才算撿漏；整新品約 $1,890 以下
  assert.equal(checkDesktop('Gaming Desktop - Intel Core i7-14700F - 32GB DDR5 - RTX 5070 Ti - 2TB SSD', 2100).steal, true);
  assert.equal(checkDesktop('Gaming Desktop - Intel Core i7-14700F - 32GB DDR5 - RTX 5070 Ti - 2TB SSD', 2150).steal, false);
  assert.equal(checkDesktop('Gaming Desktop - Intel Core i7-14700F - 32GB DDR5 - RTX 5070 Ti - 2TB SSD', 1950, { kind: 'refurb', cond: 'Refurb' }).steal, false);
  assert.equal(checkDesktop('Gaming Desktop - Intel Core i7-14700F - 32GB DDR5 - RTX 5070 Ti - 2TB SSD', 1850, { kind: 'refurb', cond: 'Refurb' }).steal, true);

  // 截圖誤報案例 2：7900X + 5080 + 32GB $2,830 不應判為撿漏
  assert.equal(checkDesktop('iBUYPOWER Slate Gaming Desktop PC: Ryzen 9 7900X, RTX 5080, 32GB DDR5', 2830).steal, false);
  // 9800X3D + 5080 + 32GB + 1TB 全新整機約 $2,400 以下才算撿漏
  assert.equal(checkDesktop('Gaming Desktop PC Ryzen 7 9800X3D RTX 5080 32GB DDR5 1TB SSD', 2390).steal, true);
  assert.equal(checkDesktop('Gaming Desktop PC Ryzen 7 9800X3D RTX 5080 32GB DDR5 1TB SSD', 2450).steal, false);
});
