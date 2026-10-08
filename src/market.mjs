// 「市售便宜價」與撿漏判斷。
// 市價來源：Best Buy 全新品目錄裡 CPU / 顯卡 / 記憶體 / SSD 的最低價，加上掃描時看到的全新零件。
import * as bestbuy from './bestbuy.mjs';
import { parseSpecs, parseRamKit, gpuScore } from './specs.mjs';

// 'r7 9800X3D' -> '9800X3D'；只有系列沒有型號（例如 'u9'）就不算
export const cpuKey = cpu => { const model = (cpu ?? '').split(' ').pop(); return /\d{3}/.test(model) ? model : ''; };

const diskGB = disk => { const m = /^([\d.]+)([TG])$/.exec(disk ?? ''); return m ? (m[2] === 'T' ? m[1] * 1000 : +m[1]) : 0; };

// 桌機條與筆電條（SODIMM）價差大，分開算
function ramKey(name) {
  const kit = parseRamKit(name);
  if (!kit?.ddr || /server|\becc\b|rdimm|registered/i.test(name)) return '';
  const sodimm = /so-?dimm|laptop|notebook|262-pin/i.test(name);
  return `ram:${kit.ddr}:${kit.total}${sodimm ? ':so' : ''}`;
}

function ssdKey(name) {
  if (!/ssd|nvme|solid state/i.test(name) || /external|portable|enclosure/i.test(name)) return '';
  const m = name.match(/\b(\d+)\s*(TB|GB)\b/i);
  return m ? `ssd:${m[2].toUpperCase() === 'TB' ? m[1] * 1000 : +m[1]}` : '';
}

const PROBES = [
  { query: 'processor', type: /processor/i, key: i => { const k = cpuKey(parseSpecs(i.name).cpu); return k && `cpu:${k}`; } },
  { query: 'graphics card', type: /graphics card/i, key: i => { const g = parseSpecs(i.name).gpu; return g && `gpu:${g}`; } },
  { query: 'ddr5 memory', type: /memory/i, key: i => ramKey(i.name) },
  { query: 'ddr4 memory', type: /memory/i, key: i => ramKey(i.name) },
  { query: 'nvme ssd internal', type: /drive/i, key: i => ssdKey(i.name) },
];

// 掃描到的全新零件對應到哪個市價 key（不是零件或不是全新品就回傳空字串）
function observe(item) {
  if (item.kind !== 'new') return '';
  if (item.cat === 'cpu') { const k = cpuKey(item.specs.cpu); return k && `cpu:${k}`; }
  if (item.cat === 'gpu') return item.specs.gpu && `gpu:${item.specs.gpu}`;
  if (item.cat === 'ram') return ramKey(item.name);
  return '';
}

const TRUSTED = /^(BestBuy|Walmart\.com)$/;

// 取最低價，但丟掉低於中位數一半的離群值（多半是標錯或假貨）。
// 只有單一第三方賣家在賣的型號不算有「市價」，回傳 undefined。
function robustMin(listings) {
  if (!listings.length || (listings.length < 2 && !listings.some(l => l.trusted))) return undefined;
  const sorted = [...listings].sort((a, b) => a.price - b.price);
  const median = sorted[Math.floor(sorted.length / 2)].price;
  return sorted.find(l => l.trusted || l.price >= median * 0.5).price;
}

// 從 Best Buy 全新品目錄重建市價表。掃描到的行情由 makePricer / foldMarket 另外併入。
export async function buildMarket() {
  const seen = {};
  const add = (key, item) => { if (key && item.price > 0) (seen[key] ??= []).push({ price: item.price, trusted: TRUSTED.test(item.seller) }); };
  const results = await Promise.all(PROBES.flatMap(probe => [1, 2].map(async page => {
    const { items } = await bestbuy.search({ query: probe.query, condition: 'New', size: 100, page });
    return items.filter(i => probe.type.test(i.type)).map(i => [probe.key(i), i]);
  })));
  for (const [key, item] of results.flat()) add(key, item);
  const prices = {};
  for (const [key, listings] of Object.entries(seen)) { const p = robustMin(listings); if (p) prices[key] = p; }
  return { t: Date.now(), prices };
}

// 回傳查價函式 (零件 key, 自己的 item key) -> 市售便宜價。
// 市價表之外，也把目前掃到的其他全新品算進來，而且「不跟自己比」：
// 十個賣家都標 $6500 的東西不是撿漏，比其他所有人都便宜一截的那一件才是。
export function makePricer(market, liveItems = [], override = {}) {
  const live = {};
  for (const item of liveItems) { const key = observe(item); if (key && item.price > 0) (live[key] ??= []).push(item); }
  return (key, selfKey) => {
    if (override[key] != null) return override[key];
    const base = market?.prices[key];
    const others = (live[key] ?? []).filter(i => i.key !== selfKey).map(i => i.price).sort((a, b) => a - b);
    if (base != null) return Math.min(base, ...others.filter(p => p >= base * 0.5));
    // 市價表沒有這個型號時就看其他賣家；三家以上才有辦法丟掉離群的超低價
    if (!others.length) return undefined;
    return others.length < 3 ? others[0] : others.find(p => p >= others[Math.floor(others.length / 2)] * 0.5);
  };
}

// 把這一輪看到的更低行情併進市價表，回傳有沒有變動。要在判斷完撿漏之後才呼叫。
export function foldMarket(market, items) {
  const seen = {};
  for (const item of items) { const key = observe(item); if (key && item.price > 0) (seen[key] ??= []).push({ price: item.price, trusted: TRUSTED.test(item.seller) }); }
  let changed = false;
  for (const [key, listings] of Object.entries(seen)) {
    const base = market.prices[key];
    const low = robustMin(base ? listings.filter(l => l.price >= base * 0.5) : listings);
    if (low && (base == null || low < base)) { market.prices[key] = low; changed = true; }
  }
  return changed;
}

// 查 MSRP 表。key 跟市價表同一套：cpu:9800X3D / gpu:5080 / ram:<DDR>:<GB>[:so] / ssd:<GB>
export function msrpOf(key, table) {
  if (!table) return undefined;
  const [kind, a, b] = key.split(':');
  if (kind === 'cpu' || kind === 'gpu') return table[kind]?.[a];
  if (kind === 'ram') return table.ramPerGB?.[a] != null && +b > 0 ? Math.round(table.ramPerGB[a] * b) : undefined;
  if (kind === 'ssd') return table.ssdPerTB != null && +a > 0 ? Math.round(table.ssdPerTB * a / 1000) : undefined;
  return undefined;
}

// 估值。估不出來回傳 null。
// 參考價：你在 override 指定的最優先；否則 MSRP 與市價取低者。
// 被炒高的零件（顯卡、記憶體）由 MSRP 把關，本來就賣得比 MSRP 便宜的（舊款 CPU）由市價把關。
export function appraise(item, priceOf, { margin = 0.1, msrpMargin = 0, tooGood = 0.5, override = {}, msrp, desktopMinGpu } = {}, ownPrice) {
  // 完全沒有別人在賣的零件，就拿它自己原本的價格當行情，不然只此一家的東西會永遠被拿去跟 MSRP 比
  const street = (key, self) => priceOf(key, item.key) ?? (self ? ownPrice : undefined);
  const ref = (key, self = false) => {
    if (override[key] != null) return { value: override[key], by: 'override' };
    const m = msrpOf(key, msrp), s = street(key, self);
    // 市價明顯高於 MSRP（被炒高）時，回到 MSRP 才算數；市價本來就在 MSRP 附近或更低時，照市價的規則走
    if (m != null && (s == null || s > m * 1.1)) return { value: m, by: 'msrp' };
    return s != null ? { value: Math.min(s, m ?? Infinity), by: 'street' } : null;
  };
  const parts = [];
  let label, useMargin;

  if (item.cat === 'desktop') {
    const cpuName = cpuKey(item.specs.cpu), cpuK = `cpu:${cpuName}`, gpuK = `gpu:${item.specs.gpu}`;
    const cpu = ref(cpuK), gpu = ref(gpuK);
    if (!cpu || !gpu) return null;
    parts.push([`CPU ${cpuName}`, cpu.value], [`GPU ${item.specs.gpu}`, gpu.value]);
    const ramGB = parseInt(item.specs.ram) || 0;
    // AM5 與 Core Ultra 平台只吃 DDR5；其他平台標題沒寫 DDR5 就當成較便宜的 DDR4，寧可低估
    const ddr = /DDR5/i.test(item.name) || /^[789]\d{3}|^2\d{2}/.test(cpuName) ? 5 : 4;
    const ram = ramGB ? ref(`ram:${ddr}:${ramGB}`)?.value : 0;
    if (ram) parts.push([`RAM ${ramGB}G DDR${ddr}`, ram]);
    const gb = diskGB(item.specs.disk);
    const ssd = gb ? ref(`ssd:${gb}`)?.value : 0;
    if (ssd) parts.push([`SSD ${item.specs.disk}`, ssd]);
    // CPU 和顯卡在 MSRP 表裡都查得到時，用「照這些價格自己組一台要多少」來比，所以把其餘零件也算進去。
    // 查不到的型號只能跟市價比，就維持保守：不加其餘零件，而且要低於估值 margin 以上
    const known = k => override[k] != null || msrpOf(k, msrp) != null;
    if (known(cpuK) && known(gpuK)) {
      if (msrp?.buildAllowance) parts.push(['主機板/電源/機殼等', msrp.buildAllowance]);
      label = '自組估值';
      useMargin = msrpMargin;
    } else { label = '零件市價'; useMargin = margin; }
  } else {
    const key = item.cat === 'cpu' ? `cpu:${cpuKey(item.specs.cpu)}` : item.cat === 'gpu' ? `gpu:${item.specs.gpu}` : item.cat === 'ram' ? ramKey(item.name) : '';
    const r = key && ref(key, true);
    if (!r) return null;
    // 參考價是 MSRP（或你指定的撿漏價）：售價到那個價就算，不看別人賣多少
    if (r.by !== 'street') {
      const steal = Math.floor(item.price) <= r.value * (1 - msrpMargin) && item.price >= r.value * tooGood;
      return { sum: r.value, below: Math.round((1 - item.price / r.value) * 100), steal, reason: `${r.by === 'override' ? '你設定的撿漏價' : 'MSRP'} $${r.value}，售價 $${item.price}` };
    }
    // 參考價是市價：這件商品自己原本的價格（ownPrice）也算行情，
    // 一直都賣這個價的最低價賣家不是撿漏，新上架或剛降價、而且比別人便宜 margin 以上的才是
    parts.push(['市價', Math.min(r.value, ownPrice ?? Infinity)]);
    label = '市售便宜價';
    useMargin = margin;
  }

  const sum = Math.round(parts.reduce((s, [, p]) => s + p, 0));
  const below = Math.round((1 - item.price / sum) * 100);
  // 整機只看高階顯卡的：低階主機的其餘零件沒那麼值錢，用同一個加總會太寬鬆
  const tierOk = item.cat !== 'desktop' || !desktopMinGpu || item.specs.gpuScore >= gpuScore(desktopMinGpu);
  // 低於估值一半通常是假貨或標題解析錯誤，不當成撿漏
  const steal = tierOk && Math.floor(item.price) <= sum * (1 - useMargin) && item.price >= sum * tooGood;
  const reason = `${label} $${sum}${parts.length > 1 ? ' = ' + parts.map(([n, p]) => `${n} ${Math.round(p)}`).join(' + ') : ''}，售價${below >= 0 ? '低' : '高'} ${Math.abs(below)}%`;
  return { sum, below, steal, reason };
}


// 手動規則（主要給估不出零件價的筆電用）。命中第一條就回傳。
export function matchRule(item, rules = []) {
  for (const rule of rules) {
    if (rule.store && rule.store !== item.store) continue;
    if (rule.cat && rule.cat !== item.cat) continue;
    if (rule.match && !rule.match.test(item.name)) continue;
    if (rule.gpu && !rule.gpu.test(item.specs.gpu)) continue;
    if (rule.minGpu && item.specs.gpuScore < gpuScore(rule.minGpu)) continue;
    if (rule.maxPrice && item.price > rule.maxPrice) continue;
    return rule;
  }
  return null;
}

// 回傳 item.deal：{ steal, reason, sum?, below? }
export function judge(item, priceOf, cfg = {}, ownPrice) {
  const value = appraise(item, priceOf, cfg, ownPrice);
  if (value?.steal) return value;
  const rule = matchRule(item, cfg.rules);
  if (rule) return { ...value, steal: true, reason: `符合規則「${rule.name}」` };
  return value;
}
