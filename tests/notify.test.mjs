import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { alertText, failWatch, push, worthPush } from '../src/notify.mjs';
import { State } from '../src/state.mjs';

const rule = { minDropPct: 10, maxOverPct: 30, newMaxOverPct: 10, dailyMax: 3 };
const drop = (price, prev, below) => ({ why: 'DROP', prev, item: { key: 'a', price, deal: below == null ? {} : { below } } });
const added = (price, below) => ({ why: 'NEW', item: { key: 'a', price, deal: below == null ? null : { below } } });

function freshState(t, keys = ['a', 'b', 'c', 'd']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dealwatch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = new State(dir);
  for (const key of keys) state.items[key] = { hist: [1000] };
  return state;
}

test('查詢失敗：偶爾一次不提醒，連續超過上限才提醒，同一段只提醒一次', () => {
  const watch = failWatch({ window: 100, maxFails: 20, maxStreak: 2 });
  assert.equal(watch(true), null);
  assert.equal(watch(false), null);
  assert.equal(watch(true), null);
  assert.equal(watch(true), null);
  assert.equal(watch(true), '連續失敗 3 次');
  assert.equal(watch(true), null);
  assert.equal(watch(false), null); // 恢復後重新計算
  assert.equal(watch(true), null);
  assert.equal(watch(true), null);
  assert.equal(watch(true), '連續失敗 3 次');
});

test('查詢失敗：最近幾輪失敗超過上限才提醒，舊的失敗滑出視窗後才會再提醒', () => {
  const watch = failWatch({ window: 10, maxFails: 2, maxStreak: 99 });
  const round = failed => watch(failed);
  assert.equal(round(true), null);
  assert.equal(round(false), null);
  assert.equal(round(true), null);
  assert.equal(round(false), null);
  assert.equal(round(true), '最近 5 輪失敗 3 次');
  assert.equal(round(true), null); // 還在同一段問題裡
  for (let i = 0; i < 10; i++) assert.equal(round(false), null); // 全部滑出視窗
  assert.equal(round(true), null);
  assert.equal(round(true), null);
  assert.equal(round(true), '最近 10 輪失敗 3 次');
});

test('紀錄檔超過上限時只留較新的一半，留下的行要完整而且連續', t => {
  const state = freshState(t, []);
  for (let i = 0; i < 100; i++) state.appendLine('log.jsonl', { i }, 500);
  const file = path.join(state.dir, 'log.jsonl');
  const kept = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line).i);
  assert.equal(kept.at(-1), 99);
  assert.ok(kept.length < 100);
  assert.ok(fs.statSync(file).size <= 500);
  kept.forEach((n, k) => { if (k) assert.equal(n, kept[k - 1] + 1); });
});

test('降價要夠多，而且不能比撿漏估值貴太多', () => {
  assert.equal(worthPush(drop(1849, 2159.97), rule), true);    // 筆電沒有估值，只看降幅
  assert.equal(worthPush(drop(2400, 2499.99), rule), false);   // 只降 4%
  assert.equal(worthPush(drop(1179.99, 1699.99, -26), rule), true);
  assert.equal(worthPush(drop(1099.99, 1369.99, -330), rule), false); // 降很多但還是貴
});

test('上新只推有估值而且接近估值的', () => {
  assert.equal(worthPush(added(1799, -9), rule), true);
  assert.equal(worthPush(added(8449, -105), rule), false);
  assert.equal(worthPush(added(1296), rule), false); // 筆電估不出價
});

test('同一件推過之後，要比推過的價格再便宜才會再推', t => {
  const state = freshState(t);
  const item = { key: 'a', price: 1000 };
  assert.equal(state.needsPush(item), true);
  state.takePushQuota([{ item }], 0, 15);
  assert.equal(state.needsPush({ key: 'a', price: 1000 }), false);
  assert.equal(state.needsPush({ key: 'a', price: 980 }), false);
  assert.equal(state.needsPush({ key: 'a', price: 970 }), true);
});

test('撿漏通知過的價格也算推過', t => {
  const state = freshState(t);
  state.markNotified({ key: 'a', price: 1000 });
  assert.equal(state.needsPush({ key: 'a', price: 1000 }), false);
  assert.equal(state.needsPush({ key: 'a', price: 950 }), true);
});

test('一天推滿上限就不再加，超過的之後還能再推', t => {
  const state = freshState(t);
  const alerts = ['a', 'b', 'c', 'd'].map(key => ({ item: { key, price: 1000 } }));
  // 額度 3，撿漏佔 1，只留 2 則
  assert.deepEqual(state.takePushQuota(alerts, 1, 3).map(a => a.item.key), ['a', 'b']);
  assert.deepEqual(state.takePushQuota(alerts.slice(2), 0, 3), []);
  assert.equal(state.needsPush({ key: 'c', price: 1000 }), true);
});

test('當天則數存檔後還在，隔天歸零', t => {
  const state = freshState(t);
  state.takePushQuota([{ item: { key: 'a', price: 1000 } }], 0, 3);
  state.save();
  const reloaded = new State(state.dir);
  assert.equal(reloaded.pushDay.n, 1);
  reloaded.pushDay.day = 'Thu Jan 01 2026';
  assert.equal(reloaded.takePushQuota([{ item: { key: 'a', price: 900 } }], 0, 3).length, 1);
  assert.equal(reloaded.pushDay.n, 1);
});

test('Discord 一則一則送，降價訊息有降幅和估值說明', async () => {
  const got = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { got.push({ t: Date.now(), content: JSON.parse(body).content }); res.end(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const item = { key: 'a', store: 'wm', cond: 'New', name: 'RTX 5070 Ti *OC*', price: 1179.99, seller: 'Newegg', url: 'http://x', deal: { below: -26, reason: '撿漏價 $936（MSRP $749），售價 $1179.99' } };
    const ok = await push({ discordWebhook: `http://127.0.0.1:${server.address().port}/hook` }, [{ why: 'DROP', prev: 1699.99, item }, { why: 'DROP', prev: 1699.99, item }]);
    assert.equal(ok, true);
    assert.equal(got.length, 2);
    assert.ok(got[1].t - got[0].t >= 400, '兩則之間要有間隔');
    assert.match(got[0].content, /降價 \$1699\.99 → \$1179\.99（-31%）/);
    assert.match(got[0].content, /撿漏價 \$936/);
    assert.ok(got[0].content.includes('\n**RTX 5070 Ti \\*OC\\***\n'), 'Discord 的商品名是粗體，名稱裡的星號要跳脫');
    assert.ok(alertText({ why: 'DROP', prev: 1699.99, item }).includes('\nRTX 5070 Ti *OC*\n'), '其他管道不加星號');
  } finally { server.close(); }
});
