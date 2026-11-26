// Slickdeals / Reddit 共用的解析：標題清理、價格、店名、類型、新舊品。
// 這兩個來源都是網友回報的 deal，商品實際在別家店賣，seller 是那家店。

// XML / HTML 實體只解一輪，避免 &amp;lt; 被解成 <
export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, name) => {
    const key = name.toLowerCase();
    if (key[0] === '#') {
      const code = key[1] === 'x' ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[key] ?? whole;
  });
}

// 商標符號會讓後面的規格解析失敗（Ryzen™ 7 9800X3D），一律換成空白
export function cleanText(text) {
  return decodeEntities(text).replace(/[™®©]/g, ' ').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

// 取 XML 標籤內容，支援 CDATA
export function xmlTag(xml, name) {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i').exec(xml);
  if (!match) return '';
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(match[1]);
  return cdata ? cdata[1] : match[1];
}

// 討論串網址上的 utm_* 追蹤參數對使用者沒用，去掉
export function stripUtm(href) {
  const url = decodeEntities(href).trim();
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) if (/^utm_/i.test(key)) parsed.searchParams.delete(key);
    return parsed.toString();
  } catch {
    return url;
  }
}

export function isoDate(value) {
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

const PRICE = /\$\s*(\d[\d,]*(?:\.\d{1,2})?)/g;
const toNumber = s => +String(s).replace(/,/g, '');

function amounts(text) {
  return [...String(text).matchAll(PRICE)].map(m => toNumber(m[1]));
}

// Slickdeals：`$1,799.99 | 標題` 取直線前那個；沒有直線就取第一個 $X。
export function slickdealsPrice(title) {
  const text = String(title);
  const bar = text.indexOf('|');
  const before = amounts(bar >= 0 ? text.slice(0, bar) : text);
  return before[0] ?? amounts(text)[0];
}

// Reddit：先看括號外的「 - $X」（取最後一個），沒有就取第一個 $X。
// 括號裡的東西多半是原價或折價（`($2,499.99 - $500)`），不當售價；
// 但 `($79 after rebate)` 這種是最終價，取較低的那個。
export function redditPrice(title) {
  const text = String(title);
  const outside = text.replace(/\([^)]*\)/g, ' ');
  const dashed = [...outside.matchAll(/[-–—]\s*\$\s*(\d[\d,]*(?:\.\d{1,2})?)/g)];
  const base = dashed.length ? toNumber(dashed.at(-1)[1]) : amounts(outside)[0] ?? amounts(text)[0];
  if (base == null) return undefined;
  if (!/after\s+rebate/i.test(text)) return base;
  const rebate = [...text.matchAll(/\(([^)]*after\s+rebate[^)]*)\)/gi)].flatMap(m => amounts(m[1]));
  return rebate.length ? Math.min(base, ...rebate) : base;
}

// 標題裡寫的原價／MSRP，只有比售價高才算
export function originalPrice(title, price) {
  if (!(price > 0)) return undefined;
  const text = String(title);
  const patterns = [
    /\b(?:was|orig(?:inally)?|regular(?:ly)?|list(?:\s+price)?|msrp|retail(?:\s+price)?)\s*:?\s*\$\s*(\d[\d,]*(?:\.\d{1,2})?)/gi,
    /\(\s*\$\s*(\d[\d,]*(?:\.\d{1,2})?)\s*[-–—]\s*\$\s*[\d.,]+\s*\)/g,
    /\$\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(?:->|→)\s*\$\s*[\d.,]+/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = toNumber(match[1]);
      if (value > price) return value;
    }
  }
  return undefined;
}

// 開頭的方括號（Reddit 的分類或店名）
export function bracketOf(title) {
  const match = /^\s*\[([^\]]+)\]/.exec(String(title));
  return match ? cleanText(match[1]) : '';
}

// 這些方括號是分類，不是店名
const CATEGORIES = new Set([
  'gpu', 'graphics card', 'video card', 'cpu', 'processor', 'ram', 'memory', 'ddr4', 'ddr5',
  'prebuilt', 'pre-built', 'desktop', 'pc', 'laptop', 'notebook', 'monitor', 'keyboard', 'mouse',
  'headphones', 'headset', 'controller', 'console', 'case', 'casse', 'cable', 'bundle', 'combo',
  'other', 'tracker', 'microphone', 'speaker', 'tablet', 'ssd', 'hdd', 'storage', 'psu',
  'motherboard', 'mobo', 'cooler', 'fan', 'webcam', 'chair', 'desk', 'dock', 'hub', 'router',
  'software', 'game', 'tv', 'projector', 'printer', 'charger', 'accessories', 'airtag', 'deal',
]);
export const isCategory = bracket => CATEGORIES.has(String(bracket ?? '').toLowerCase().trim());

const BRACKET_TYPE = {
  gpu: 'graphics card gpu', 'graphics card': 'graphics card gpu', 'video card': 'graphics card gpu',
  cpu: 'processor cpu', processor: 'processor cpu',
  ram: 'memory ram', memory: 'memory ram', ddr4: 'memory ram', ddr5: 'memory ram',
  prebuilt: 'desktop gaming pc', 'pre-built': 'desktop gaming pc', desktop: 'desktop gaming pc', pc: 'desktop gaming pc',
  laptop: 'laptop notebook', notebook: 'laptop notebook',
};

// 分類用的 type 字串（讓 config.categories[*].type 比對得到）
export function typeOf(name, bracket = '') {
  const tag = String(bracket ?? '').toLowerCase().trim();
  // 螢幕、鍵盤、組合包…不要被標題裡的零件字樣帶偏
  if (isCategory(tag) && !BRACKET_TYPE[tag]) return tag;
  const text = String(name ?? '');
  // 只認完整機器的字樣；"Desktop Processor"、"Desktop Upgrade RAM" 不是整機
  const laptop = /\blaptops?\b|notebooks?/i.test(text);
  const desktop = /\bgaming pcs?\b|\bdesktop pcs?\b|\bgaming desktops?\b|\bdesktop computers?\b|\btowers?\b|\bmini pcs?\b|all-in-one|\bimac\b|prebuilt\b/i.test(text);
  // 「Gaming Desktop Upgrade RAM」這種記憶體標題含 desktop 但不是整機：沒有 CPU／顯卡型號又同時有 DDR 與 RAM 就當記憶體
  const memoryKit = /\bddr[45]\b/i.test(text) && /\b(ram|memory|kit|dimm|sodimm)\b/i.test(text)
    && !/\b(?:ryzen|core\s+(?:i\d|ultra)|rtx|gtx|geforce|radeon|rx\s*\d)/i.test(text);
  const computer = !memoryKit && (laptop || desktop);
  const hasMobo = /\b(?:motherboard|mobo|(?:X870E|X670E|B650E|X870|X670|B850|B650|Z890|Z790|B860|B760)(?:[MIS](?![A-Za-z0-9])|(?![A-Za-z0-9])))\b/i.test(text);
  const bundle = !computer && hasMobo && (
    /\b(?:bundle|combo|kit)\b/i.test(text)
    || /\b(?:ryzen|core\s+(?:i\d|ultra)|\d{4}x3d|\d{4}x|2[468]5kf?)\b/i.test(text)
  );
  const hints = [];
  if (bundle) hints.push('bundle combo');
  if (!computer && !bundle && /(?:geforce|radeon|arc)\b|\b(?:rtx|gtx|rx)[\s-]*\d{3,4}/i.test(text)) hints.push('graphics card gpu');
  if (!computer && !bundle && (memoryKit || (/\bddr[45]\b/i.test(text) && /\b(ram|memory|kit|dimm|sodimm)\b/i.test(text)))) hints.push('memory ram');
  if (!computer && !bundle && /\b(?:processor|cpu)\b/i.test(text) && !/food processor/i.test(text)) hints.push('processor cpu');
  if (computer && laptop) hints.push('laptop notebook');
  else if (computer && desktop) hints.push('desktop gaming pc');
  const words = [BRACKET_TYPE[tag] ?? '', ...hints].join(' ').split(/\s+/).filter(Boolean);
  return [...new Set(words)].join(' ');
}

export function kindOf(text) {
  const s = String(text ?? '').toLowerCase();
  if (/open[\s-]*box/.test(s)) return { kind: 'ob', cond: 'Open-Box' };
  if (/refurb|renewed|recertified|reconditioned|\bused\b|\brestored\b|pre-owned/.test(s)) return { kind: 'refurb', cond: 'Refurb' };
  return { kind: 'new', cond: 'New' };
}

// 售完／過期的字樣
export function inStockOf(text) {
  return !/\bexpired\b|\[OOS\]|out of stock|sold out|\bdead\b/i.test(String(text ?? ''));
}

const STORE_ALIASES = {
  amazon: 'Amazon', walmart: 'Walmart', newegg: 'Newegg', bestbuy: 'Best Buy', 'best-buy': 'Best Buy',
  microcenter: 'Micro Center', 'micro-center': 'Micro Center', samsclub: "Sam's Club", 'sams-club': "Sam's Club",
  costco: 'Costco', target: 'Target', bhphotovideo: 'B&H', bhphoto: 'B&H', 'b&h': 'B&H', adorama: 'Adorama',
  woot: 'Woot', staples: 'Staples', ebay: 'eBay', lenovo: 'Lenovo', dell: 'Dell', hp: 'HP', msi: 'MSI',
  centralcomputer: 'Central Computers', 'central-computers': 'Central Computers', bjs: "BJ's",
};

function storeKey(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9&-]/g, '');
}

// 已知店名或 slug → 顯示名稱；不認得的 slug 就把字首大寫
export function canonicalStore(name) {
  const key = storeKey(name);
  return STORE_ALIASES[key] ?? String(name ?? '').replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
}

const DOMAINS = [
  ['amazon.com', 'Amazon'], ['walmart.com', 'Walmart'], ['newegg.com', 'Newegg'], ['bestbuy.com', 'Best Buy'],
  ['microcenter.com', 'Micro Center'], ['samsclub.com', "Sam's Club"], ['costco.com', 'Costco'], ['target.com', 'Target'],
  ['bhphotovideo.com', 'B&H'], ['adorama.com', 'Adorama'], ['woot.com', 'Woot'], ['staples.com', 'Staples'],
  ['ebay.com', 'eBay'], ['lenovo.com', 'Lenovo'], ['dell.com', 'Dell'], ['hp.com', 'HP'], ['msi.com', 'MSI'],
  ['centralcomputer.com', 'Central Computers'], ['bjs.com', "BJ's"],
];

export function storeFromDomain(host) {
  const h = String(host ?? '').toLowerCase().replace(/^www\./, '');
  for (const [domain, name] of DOMAINS) if (h === domain || h.endsWith(`.${domain}`)) return name;
  return h;
}

export function storeFromSlug(slug) {
  return slug ? canonicalStore(slug) : '';
}

const KNOWN_STORES = /best\s*buy|micro\s*center|sam'?s\s*club|b&h|newegg|amazon|walmart|woot|costco|target|staples|adorama|ebay|lenovo|dell/i;

// 標題裡的「at Amazon」／「@ Walmart」。先認已知店名，免得把「Best Buy YMMV」整串當店名。
export function sellerFromTitle(title) {
  const text = cleanText(title);
  let found = '';
  for (const match of text.matchAll(/\b(?:at|@)\s+([^|,;]+)/gi)) {
    const hit = KNOWN_STORES.exec(match[1]);
    if (hit) found = canonicalStore(hit[0]);
  }
  if (found) return found;
  const generic = [...text.matchAll(/\b(?:at|@)\s+([A-Z][A-Za-z0-9&.'’\-]*(?:\s+[A-Z][A-Za-z0-9&.'’\-]*){0,3})/g)].at(-1);
  if (!generic) return '';
  return generic[1].replace(/\s+\b(?:ymmv|in[\s-]?store|only|pickup|shipping|free)\b.*$/i, '').trim();
}

const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 商品名稱：去掉開頭的價格與方括號、商標符號，以及重複的店名結尾
export function cleanName(title, seller = '') {
  let s = cleanText(title);
  while (/^\[[^\]]*\]\s*/.test(s)) s = s.replace(/^\[[^\]]*\]\s*/, '');
  s = s.replace(/^\$\s*[\d,]+(?:\.\d{1,2})?\s*[*+]?\s*(?:[|,:\-–—]\s*)?/, '');
  s = s.replace(/^[|,:\-–—]\s*/, '');
  if (seller) {
    s = s.replace(new RegExp(`^${escapeRe(seller)}\\s*[,:—-]\\s*`, 'i'), '');
    s = s.replace(new RegExp(`\\s+(?:at|@)\\s+${escapeRe(seller)}\\b`, 'ig'), '');
  }
  s = s.replace(/\s+\b(?:ymmv|b&m|in[\s-]?store(?:\s+only)?)\b\s*$/i, '');
  return s.replace(/\s+/g, ' ').replace(/[\s,;|]+$/, '').trim();
}

// 從一段文字（Slickdeals 的 description）推店名
export function sellerFromText(text) {
  const s = decodeEntities(text);
  const domain = /\[([a-z0-9.-]+\.[a-z]{2,})\]/i.exec(s)?.[1];
  if (domain) return storeFromDomain(domain);
  const has = /\b([A-Z][A-Za-z0-9&.'’\-]*(?:\s+[A-Z][A-Za-z0-9&.'’\-]*){0,2})\s+has\b/.exec(s);
  if (has && !/^(this|it|the|there|she|he|who|what|everything|everyone)$/i.test(has[1])) return canonicalStore(has[1]);
  return '';
}
