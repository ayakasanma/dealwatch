// 每家要用瀏覽器的店各一個分頁：驗證頁和 hold 不受別家影響。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Browser, storeTabs } from '../src/browser.mjs';
import * as ebay from '../src/ebay.mjs';
import * as microcenter from '../src/microcenter.mjs';

const options = { cdpUrl: 'http://127.0.0.1:9222' };
const ebayHtml = fs.readFileSync(fileURLToPath(new URL('./fixtures/ebay-search.html', import.meta.url)), 'utf8');

test('第一家用主分頁，其他共用同一個瀏覽器、各開一個分頁', () => {
  const tabs = storeTabs(options, ['wm', 'ne', 'eb', 'mc']);
  assert.equal(tabs.wm.parent, null);
  for (const code of ['ne', 'eb', 'mc']) assert.equal(tabs[code].parent, tabs.wm);
  assert.equal(new Set(Object.values(tabs)).size, 4);
});

test('Micro Center 等人驗證時，eBay 載入成功不會蓋掉驗證頁，也不會放掉 hold', async t => {
  const tabs = storeTabs(options, ['wm', 'eb', 'mc']);
  const visits = { eb: [], mc: [] };
  const blocked = '<html><head><title>Just a moment...</title></head></html>';
  tabs.mc.html = async url => { visits.mc.push(String(url)); return blocked; };
  tabs.mc.currentHtml = async () => blocked;
  tabs.mc.focus = async () => {};
  tabs.eb.html = async url => { visits.eb.push(String(url)); return ebayHtml; };
  microcenter.configure({ browser: tabs.mc, gapMs: 0, recheckMs: [0, 0] });
  ebay.configure({ browser: tabs.eb, gapMs: 0 });
  t.after(() => { microcenter.configure({ browser: null }); ebay.configure({ browser: null }); });

  await assert.rejects(microcenter.search({ query: 'rtx 5080' }), /人機驗證/);
  assert.equal(tabs.mc.hold, true);
  await ebay.search({ query: 'rtx 5080' });
  assert.equal(tabs.mc.hold, true, 'eBay 成功不能放掉 Micro Center 的 hold');
  assert.equal(tabs.eb.hold, false);
  assert.ok(visits.eb.length > 0);
  assert.ok(visits.mc.every(url => url.includes('microcenter.com')), 'Micro Center 的分頁不能被別家載入');
});

test('結束時各店分頁沒有在等驗證就關掉，等驗證的留著；驗證過的 keepOpen 不算', async () => {
  for (const [hold, closes] of [[false, 1], [true, 0]]) {
    const tab = new Browser({ ...options, parent: new Browser(options) });
    const sent = [];
    Object.assign(tab, { hold, keepOpen: true, starting: Promise.resolve(), targetId: 't', send: async method => { sent.push(method); }, ws: { close() {} } });
    await tab.dispose();
    assert.equal(sent.filter(method => method === 'Target.closeTarget').length, closes);
  }
});
