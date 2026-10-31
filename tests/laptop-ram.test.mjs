import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import config from '../config.mjs';
import { parseSpecs } from '../src/specs.mjs';
import { laptopRamEvidence, shouldNotifyDeal, sortAlertsByPriority } from '../src/laptop-ram.mjs';
import { matchRule, judge } from '../src/market.mjs';
import { State } from '../src/state.mjs';

const item = (name, gpu = '5070 Ti', price = 1399) => ({
  name: `Gaming Laptop RTX ${gpu} ${name}`, cat: 'laptop', store: 'wm',
  kind: 'new', price, key: 'wm:sample', specs: parseSpecs(`RTX ${gpu} ${name}`),
});

test('16/32/64 GB and missing RAM are distinguished from factory verification', () => {
  for (const [title, expectedGb, source, priority] of [
    ['16GB RAM', 16, 'unverified', 'low'],
    ['32GB DDR5 factory-installed', 32, 'factory', 'high'],
    ['64GB LPDDR5 factory configuration', 64, 'factory', 'high'],
    ['32GB RAM', 32, 'unverified', 'medium'],
    ['64GB RAM seller upgraded', 64, 'upgraded', 'low'],
    ['', null, 'unknown', 'low'],
    ['supports up to 64GB RAM', null, 'unknown', 'low'],
    ['16GB RAM 32GB RAM', null, 'conflict', 'low'],
  ]) {
    const ram = laptopRamEvidence(item(title));
    assert.equal(ram.gb, expectedGb, title);
    assert.equal(ram.source, source, title);
    assert.equal(ram.priority, priority, title);
  }
});

test('GPU 16GB VRAM alone is not assumed to be system RAM', () => {
  const sample = item('16GB GDDR7 graphics memory');
  assert.equal(laptopRamEvidence(sample).gb, null);
});

test('all matching RAM tiers remain deals, but notifications are configurable', () => {
  const threshold = config.steals.minLaptopNotifyPriority;
  for (const [title, priority] of [
    ['16GB RAM', 'low'],
    ['32GB RAM', 'medium'],
    ['64GB RAM factory-installed', 'high'],
    ['', 'low'],
  ]) {
    const i = item(title);
    i.deal = judge(i, () => undefined, config.steals);
    assert.equal(i.deal.steal, true, title);
    assert.equal(i.deal.priority, priority, title);
    assert.equal(shouldNotifyDeal(i, threshold), priority !== 'low', title);
    assert.equal(shouldNotifyDeal(i, 'low'), true, title);
  }
});

test('overlapping laptop rules still honor price, store and GPU, without duplicate alerts', () => {
  const i = item('ROG Zephyrus 32GB RAM', '5070 Ti', 1399);
  const matches = config.steals.rules.filter(r => (!r.store || r.store === i.store) &&
    (!r.cat || r.cat === i.cat) && (!r.match || r.match.test(i.name)) &&
    (!r.gpu || r.gpu.test(i.specs.gpu)) && (!r.maxPrice || i.price <= r.maxPrice));
  assert.ok(matches.length > 1);
  assert.equal(matchRule(i, config.steals.rules).name, 'RTX 5070 Ti 筆電低於 $1450');
  assert.equal(judge(i, () => undefined, config.steals).priority, 'medium');
  assert.equal(judge(item('32GB RAM', '5080', 1999), () => undefined, config.steals).steal, false,
    'Best Buy-only 5080 rule must not match Walmart');
  const bb = { ...item('32GB RAM', '5080', 1999), store: 'bb' };
  assert.equal(judge(bb, () => undefined, config.steals).priority, 'medium');
});

test('priority sorting and explicit watchlist target exemption', () => {
  const alerts = ['low', 'high', 'medium'].map(priority => ({
    item: { deal: { steal: true, priority }, price: 1300 },
  }));
  assert.deepEqual(sortAlertsByPriority(alerts).map(a => a.item.deal.priority), ['high', 'medium', 'low']);
  const low = { ...item('16GB RAM'), deal: { steal: true, priority: 'low' }, watch: { maxPrice: 1450 } };
  assert.equal(shouldNotifyDeal(low, 'high'), true);
});

test('a newly verified factory configuration can notify again at the same price', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dealwatch-test-'));
  try {
    const state = new State(dir);
    const i = { ...item('32GB RAM'), deal: { steal: true, priority: 'medium' } };
    state.update('wm', [i], ['laptop']);
    state.markNotified(i);
    assert.equal(state.needsNotify(i), false);
    i.deal.priority = 'high';
    assert.equal(state.needsNotify(i), true);
    state.markNotified(i);
    assert.equal(state.needsNotify(i), false);
    state.save();
    assert.equal(new State(dir).needsNotify(i), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
