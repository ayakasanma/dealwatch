import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { State } from '../src/state.mjs';
import { addToCart } from '../src/cart.mjs';
import { CHECKOUT_URL } from '../src/bestbuy.mjs';
import { evaluate, parseMobo } from '../src/specs.mjs';
import { typeOf } from '../src/feed.mjs';
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

test('parseMobo 與套組（bundle）分類及估值：以 Micro Center 5007482 驗證', () => {
  assert.equal(parseMobo('MSI X870E-P Pro WiFi'), 'X870E');
  assert.equal(parseMobo('ASUS ROG STRIX B650E-F Gaming WiFi'), 'B650E');
  assert.equal(parseMobo('ASUS TUF GAMING B650-E WIFI'), 'B650');
  assert.equal(parseMobo('GIGABYTE B850M AORUS ELITE WIFI6E'), 'B850');
  assert.equal(parseMobo('ASRock B650I Lightning WiFi'), 'B650');
  assert.equal(parseMobo('MSI MAG Z890 TOMAHAWK WIFI'), 'Z890');
  assert.equal(parseMobo('ASUS PRIME B760M-A AX'), 'B760');
  assert.equal(parseMobo('CyberPowerPC SLC8500WST Gaming PC'), '');

  // Slickdeals 標題應歸類為 bundle 而非單獨記憶體
  const sdName = 'AMD Ryzen 7 9800X3D, MSI X870E-P Pro WiFi, G.Skill Flare X5 Series 32GB DDR5-6000 Kit, Computer Build Bundle';
  assert.match(typeOf(sdName), /bundle/);
  assert.doesNotMatch(typeOf(sdName), /memory|ram/i);

  const mcBundle = {
    store: 'mc',
    key: 'mc:5007482',
    kind: 'new',
    cond: 'New',
    type: 'AMD Bundles',
    name: sdName,
    price: 849.99,
  };
  const specs = evaluate(config.categories.bundle, mcBundle);
  assert.ok(specs, 'Micro Center 5007482 應符合 bundle 分類');
  assert.equal(specs.cpu, 'r7 9800X3D');
  assert.equal(specs.mobo, 'X870E');
  assert.equal(specs.ram, '32G');
  assert.equal(evaluate(config.categories.cpu, mcBundle), null, '套組不應落入 cpu 分類');
  assert.equal(evaluate(config.categories.ram, mcBundle), null, '套組不應落入 ram 分類');

  // 沒主機板或整機不應進入 bundle 分類
  assert.equal(evaluate(config.categories.bundle, { type: 'AMD Bundles', name: 'AMD Ryzen 7 9800X3D + 32GB DDR5 Bundle', price: 600 }), null);
  assert.equal(evaluate(config.categories.bundle, { type: 'Desktops', name: 'Gaming PC Ryzen 7 9800X3D X870E RTX 5080', price: 2400 }), null);

  // 估值驗證：9800X3D ($340) + X870E ($210) + 32GB DDR5 ($280) = $830；bundleMargin 5% -> $788 以下為撿漏
  const priceOf = makePricer({ prices: {} }, [], config.steals.override);
  const judgeBundle = (name, price, { kind = 'new', cond = 'New' } = {}) => {
    const item = { store: 'mc', key: `mc:b:${name}:${kind}:${price}`, cat: 'bundle', kind, cond, type: 'AMD Bundles', name, price };
    item.specs = evaluate(config.categories.bundle, item);
    return judge(item, priceOf, config.steals);
  };

  const regular = judgeBundle(sdName, 849.99);
  assert.equal(regular.sum, 830);
  assert.equal(regular.steal, false);
  assert.match(regular.reason, /套組估值 \$830 = CPU 9800X3D 340 \+ 主機板 X870E 210 \+ RAM 32G DDR5 280/);

  assert.equal(judgeBundle(sdName, 800).steal, false);
  assert.equal(judgeBundle(sdName, 785).steal, true);

  // Open-Box 套組再折 10%（$830 -> $747，5% margin -> <= $709）
  assert.equal(judgeBundle(sdName, 720, { kind: 'ob', cond: 'Open-Box' }).steal, false);
  assert.equal(judgeBundle(sdName, 699, { kind: 'ob', cond: 'Open-Box' }).steal, true);

  // 僅 CPU + 主機板（不含 RAM）：9800X3D ($340) + B850 ($150) = $490，5% margin -> <= $465
  const cpuMobo = judgeBundle('AMD Ryzen 7 9800X3D + GIGABYTE B850M AORUS ELITE WIFI6E Combo', 499);
  assert.equal(cpuMobo.sum, 490);
  assert.equal(cpuMobo.steal, false);
  assert.equal(judgeBundle('AMD Ryzen 7 9800X3D + GIGABYTE B850M AORUS ELITE WIFI6E Combo', 460).steal, true);

  // 2x16GB 格式也能正確估成 32G DDR5
  const kit2x16 = judgeBundle('AMD Ryzen 7 9800X3D + MSI B650-P WiFi + 2x16GB DDR5-6000 Bundle', 700);
  assert.equal(kit2x16.sum, 340 + 120 + 280);
  assert.equal(kit2x16.steal, true);
});

test('筆電撿漏規則支援 minOffPct、自營賣家限制與 RTX 4080 / 4090 / 5070 門檻', () => {
  const priceOf = makePricer({ prices: {} }, [], config.steals.override);
  const checkLaptop = ({ name, price, ref, kind = 'ob', cond = 'OB Fair', seller = 'BestBuy' }) => {
    const item = { store: 'bb', key: `bb:lt:${name}:${price}:${kind}:${seller}`, cat: 'laptop', kind, cond, seller, type: 'Laptop Computer', name, price, ref, off: ref > price ? Math.round((1 - price / ref) * 100) : 0 };
    item.specs = evaluate(config.categories.laptop, item);
    return judge(item, priceOf, config.steals);
  };

  assert.equal(checkLaptop({ name: 'ASUS ROG Strix 16 RTX 4080 Gaming Laptop', price: 1299 })?.steal, true);
  assert.equal(checkLaptop({ name: 'ASUS ROG Strix 16 RTX 4090 Gaming Laptop', price: 1699 })?.steal, true);
  assert.equal(checkLaptop({ name: 'Lenovo Legion 5 RTX 5070 Gaming Laptop', price: 1049 })?.steal, true);

  // 自營 Open-Box RTX 5070 折 38% 且 <= $2200 -> 命中 minOffPct 規則
  assert.equal(checkLaptop({ name: 'Acer Predator Triton 14.5 OLED RTX 5070 Gaming Laptop', price: 1399, ref: 2299, kind: 'ob' })?.steal, true);
  // 3P 賣家灌水原價（例如 RTX 5070 標原價 $3099 賣 $1983）-> 不命中
  assert.equal(checkLaptop({ name: 'Acer Predator Triton 14.5 OLED RTX 5070 Gaming Laptop', price: 1983.48, ref: 3099.99, kind: 'refurb', cond: 'Refurb Excellent', seller: '3P賣家' }), null);
  // 折扣未達 35%（20% off）-> 不命中
  assert.equal(checkLaptop({ name: 'Acer Predator Triton 14.5 OLED RTX 5070 Gaming Laptop', price: 1839, ref: 2299, kind: 'ob' }), null);
  // 超過 $2200 上限 -> 不命中（避免老機高定價誤報）
  assert.equal(checkLaptop({ name: 'GIGABYTE AERO 16 RTX 5070 Gaming Laptop', price: 2400, ref: 4000, kind: 'ob' }), null);
  // 顯卡低於 RTX 5070（例如 RTX 5050）-> 不命中
  assert.equal(checkLaptop({ name: 'LG gram Pro Max RTX 5050 Gaming Laptop', price: 1338, ref: 2199, kind: 'ob' }), null);
  // 全新品不適用 Open-Box / 整新折扣規則
  assert.equal(checkLaptop({ name: 'Acer Predator Triton 14.5 OLED RTX 5070 Gaming Laptop', price: 1399, ref: 2299, kind: 'new', cond: 'New' }), null);
});
