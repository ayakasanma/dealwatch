import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Browser } from '../src/browser.mjs';
import { startUi } from '../src/ui.mjs';
import { pageStock } from '../src/bestbuy.mjs';

test('缺少 WebSocket 時在啟動瀏覽器／建立 profile 之前清楚失敗', async t => {
  const old = globalThis.WebSocket;
  t.after(() => { globalThis.WebSocket = old; });
  globalThis.WebSocket = undefined;
  const browser = new Browser({ path: 'does-not-exist', profileDir: 'must-not-create' });
  browser.version = () => assert.fail('不應發起 CDP 連線');
  await assert.rejects(browser.ready(), /Node.js 22/);
  assert.equal(browser.spawned, false);
});

test('CDP 指令無回覆會逾時並清除 pending', async () => {
  const browser = new Browser({ commandTimeout: 25 });
  browser.ws = { send() {} };
  await assert.rejects(browser.send('Target.getTargets'), /逾時/);
  assert.equal(browser.pending.size, 0);
});

test('CDP 已回覆與 send 同步失敗都清除 pending', async () => {
  const browser = new Browser({ commandTimeout: 25 });
  browser.ws = { send(text) { browser.onMessage({ id: JSON.parse(text).id, result: { ok: true } }); } };
  assert.deepEqual(await browser.send('Example'), { ok: true });
  browser.ws = { send() { throw new Error('closed'); } };
  await assert.rejects(browser.send('Example'), /closed/);
  assert.equal(browser.pending.size, 0);
});

// 不連真的瀏覽器：把 navigate / run 換成記錄呼叫的假函式
function fakeBrowser(idleMs) {
  const browser = new Browser({ idleMs });
  const visits = [];
  Object.assign(browser, { starting: Promise.resolve(), session: 's', navigate: async url => { visits.push(url); }, run: async () => '<html></html>' });
  return { browser, visits };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('載入都做完並閒置後換成空白頁；連續載入之間不換', async () => {
  const { browser, visits } = fakeBrowser(40);
  await browser.html('https://a.example/');
  await sleep(10);
  await browser.html('https://b.example/');
  await sleep(80);
  assert.deepEqual(visits, ['https://a.example/', 'https://b.example/', 'about:blank']);
  await sleep(80);
  assert.equal(visits.length, 3, '換成空白頁本身不會再排下一次');
});

test('hold 時保留目前頁面（等人處理驗證）；idleMs 為 0 時不換', async () => {
  const held = fakeBrowser(20);
  held.browser.hold = true;
  await held.browser.html('https://captcha.example/');
  await sleep(60);
  assert.deepEqual(held.visits, ['https://captcha.example/']);

  const off = fakeBrowser(0);
  await off.browser.html('https://a.example/');
  await sleep(40);
  assert.deepEqual(off.visits, ['https://a.example/']);
});

test('等人處理驗證時，Best Buy 庫存確認不借用分頁', async () => {
  const { browser, visits } = fakeBrowser(0);
  browser.hold = true;
  assert.equal(await pageStock(browser, 'https://www.bestbuy.com/site/x/1.p'), null);
  assert.deepEqual(visits, []);
});

test('一次性指令結束時，接到別處的瀏覽器換回空白頁；hold 時保留', async () => {
  for (const [hold, expected] of [[false, ['about:blank']], [true, []]]) {
    const browser = new Browser({ cdpUrl: 'http://127.0.0.1:9222', idleMs: 30000 });
    const visits = [];
    Object.assign(browser, { hold, starting: Promise.resolve(), session: 's', navigate: async url => { visits.push(url); }, ws: { close() {} } });
    await browser.dispose();
    assert.deepEqual(visits, expected);
  }
});

test('公開監聽缺少密碼時拒絕啟動', () => {
  assert.throws(() => startUi({ port: 0, host: '0.0.0.0' }), /UI_PASSWORD/);
});

test('healthz 只表示存活；內容及控制端點仍需密碼與自訂標頭', async t => {
  let rescans = 0;
  const server = await startUi({ port: 0, password: 'test-password', getState: () => ({ stores: { bb: { error: 'blocked' } } }), getLog: () => [], rescan: () => rescans++ });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  const headers = { authorization: `Basic ${Buffer.from('any:test-password').toString('base64')}` };
  assert.equal((await fetch(`${base}/api/state`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/api/rescan`, { method: 'POST', headers })).status, 404);
  assert.equal(rescans, 0);
  assert.equal((await fetch(`${base}/api/rescan`, { method: 'POST', headers: { ...headers, 'x-dealwatch': '1' } })).status, 200);
  assert.equal(rescans, 1);
});

test('ui.html 不寫死 Walmart 人機驗證且僅對 Best Buy 跳轉 Best Buy 結帳頁', () => {
  const html = fs.readFileSync(new URL('../src/ui.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /Walmart 要求人機驗證/);
  assert.match(html, /humanStores\.join/);
  assert.match(html, /if\s*\(\s*store\s*===\s*'bb'\s*\)/);
});
