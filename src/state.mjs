// 已見商品與價格歷史，存成一個 JSON 檔。用來判斷「上新」與「降價」。
import fs from 'node:fs';
import path from 'node:path';

const HIST_MAX = 6;
const LINES_MAX_BYTES = 50 * 1024 * 1024;

export class State {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    fs.mkdirSync(dir, { recursive: true });
    try { Object.assign(this, { items: {}, seeded: {}, pushDay: {} }, JSON.parse(fs.readFileSync(this.file, 'utf8'))); }
    catch { this.items = {}; this.seeded = {}; this.pushDay = {}; }
  }

  // 回傳這次掃描產生的提醒；同時把價格歷史掛到 item.hist 上
  // 某家店的某個分類第一次掃到時只建立基準，不發「上新」
  isSeeded(store, cat) { return !!this.seeded[`${store}:${cat}`]; }

  update(store, items, catNames, { dropPct = 3, alertNew = true } = {}) {
    const now = Date.now(), alerts = [];
    for (const item of items) {
      const rec = this.items[item.key];
      if (!rec) {
        this.items[item.key] = { first: now, last: now, hist: [item.price] };
        if (alertNew && this.isSeeded(store, item.cat)) alerts.push({ why: 'NEW', item });
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

  // 移除無效商品紀錄（例如複驗後確認為競標、多規格或已結束）
  remove(key) {
    if (!this.items[key]) return false;
    delete this.items[key];
    return true;
  }

  // 更正最後一筆誤報價；若與前一筆相同則直接退回前價，避免留下假波動紀錄
  replaceLastPrice(key, price) {
    const rec = this.items[key];
    if (!rec?.hist?.length) return false;
    if (rec.hist.length > 1 && rec.hist.at(-2) === price) rec.hist.pop();
    else rec.hist[rec.hist.length - 1] = price;
    return true;
  }

  // 撿漏只通知一次；之後要比通知時再便宜 dropPct 以上才會再通知
  needsNotify(item, dropPct = 3) {
    const told = this.items[item.key]?.told;
    return told == null || item.price <= told * (1 - dropPct / 100);
  }

  markNotified(item) { if (this.items[item.key]) this.items[item.key].told = item.price; }

  // 上新 / 降價推過之後，要比推過的價格再便宜 dropPct 以上才會再推，價格來回跳時不會重複推
  needsPush(item, dropPct = 3) {
    const rec = this.items[item.key];
    return item.price <= Math.min(rec?.told ?? Infinity, rec?.pushed ?? Infinity) * (1 - dropPct / 100);
  }

  // 從 plain 挑出今天額度內的上新 / 降價，記下推播價。撿漏（stealCount 則）算進當天則數，但不會被擋
  takePushQuota(plain, stealCount = 0, dailyMax = Infinity) {
    const day = new Date().toDateString();
    const used = (this.pushDay.day === day ? this.pushDay.n : 0) + stealCount;
    const kept = plain.slice(0, Math.max(0, dailyMax - used));
    this.pushDay = { day, n: used + kept.length };
    for (const { item } of kept) if (this.items[item.key]) this.items[item.key].pushed = item.price;
    return kept;
  }

  save() {
    // 超過 30 天沒再出現的紀錄清掉，之後重新上架會再被當成上新
    const cutoff = Date.now() - 30 * 864e5;
    for (const [k, v] of Object.entries(this.items)) if (v.last < cutoff) delete this.items[k];
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ items: this.items, seeded: this.seeded, pushDay: this.pushDay }));
    fs.renameSync(tmp, this.file);
  }

  writeJson(name, data) { fs.writeFileSync(path.join(this.dir, name), JSON.stringify(data, null, 1)); }
  readJson(name) { try { return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')); } catch { return null; } }

  // 只附加的紀錄檔（alerts.jsonl）超過上限就只留較新的一半，免得一直長下去
  appendLine(name, obj, maxBytes = LINES_MAX_BYTES) {
    const file = path.join(this.dir, name);
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
    if (fs.statSync(file).size <= maxBytes) return;
    const text = fs.readFileSync(file, 'utf8');
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, text.slice(text.indexOf('\n', text.length / 2) + 1));
    fs.renameSync(tmp, file);
  }
}
