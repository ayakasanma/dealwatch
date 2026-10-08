// 已見商品與價格歷史，存成一個 JSON 檔。用來判斷「上新」與「降價」。
import fs from 'node:fs';
import path from 'node:path';

const HIST_MAX = 6;

export class State {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    fs.mkdirSync(dir, { recursive: true });
    try { Object.assign(this, { items: {}, seeded: {} }, JSON.parse(fs.readFileSync(this.file, 'utf8'))); }
    catch { this.items = {}; this.seeded = {}; }
  }

  // 回傳這次掃描產生的提醒；同時把價格歷史掛到 item.hist 上
  // 某家店的某個分類第一次掃到時只建立基準，不發「上新」
  isSeeded(store, cat) { return !!this.seeded[`${store}:${cat}`]; }

  update(store, items, catNames, { dropPct = 3 } = {}) {
    const now = Date.now(), alerts = [];
    for (const item of items) {
      const rec = this.items[item.key];
      if (!rec) {
        this.items[item.key] = { first: now, last: now, hist: [item.price] };
        if (this.isSeeded(store, item.cat)) alerts.push({ why: 'NEW', item });
      } else {
        const prev = rec.hist.at(-1);
        rec.last = now;
        if (item.price !== prev) {
          rec.hist.push(item.price);
          if (rec.hist.length > HIST_MAX) rec.hist.splice(1, rec.hist.length - HIST_MAX);
          if (item.price <= prev * (1 - dropPct / 100)) alerts.push({ why: 'DROP', item, prev });
        }
      }
      item.hist = this.items[item.key].hist;
    }
    for (const cat of catNames) this.seeded[`${store}:${cat}`] = true;
    return alerts;
  }

  // 撿漏只通知一次；之後要比通知時再便宜 dropPct 以上才會再通知
  needsNotify(item, dropPct = 3) {
    const told = this.items[item.key]?.told;
    return told == null || item.price <= told * (1 - dropPct / 100);
  }

  markNotified(item) { if (this.items[item.key]) this.items[item.key].told = item.price; }

  save() {
    // 超過 30 天沒再出現的紀錄清掉，之後重新上架會再被當成上新
    const cutoff = Date.now() - 30 * 864e5;
    for (const [k, v] of Object.entries(this.items)) if (v.last < cutoff) delete this.items[k];
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ items: this.items, seeded: this.seeded }));
    fs.renameSync(tmp, this.file);
  }

  writeJson(name, data) { fs.writeFileSync(path.join(this.dir, name), JSON.stringify(data, null, 1)); }
  readJson(name) { try { return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')); } catch { return null; } }
  appendLine(name, obj) { fs.appendFileSync(path.join(this.dir, name), JSON.stringify(obj) + '\n'); }
}
