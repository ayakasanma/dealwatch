// 從商品標題抽出 CPU / GPU / RAM / 硬碟，並判斷商品是否符合某個分類的條件。

// 粗略效能排名，只用來比較「是否達到 minGpu」
const GPU_SCORE = {
  '5090': 100, '4090': 88, '5080': 80, '4080': 74, '5070 ti': 70, '3090 ti': 66, '4070 ti': 62, '3090': 62,
  '5070': 58, '3080 ti': 58, '4070': 52, '3080': 52, '5060 ti': 46, '3070 ti': 44, '4060 ti': 42, '3070': 42,
  '5060': 40, '4060': 36, '3060 ti': 36, '5050': 32, '3060': 30, '4050': 28, '3050 ti': 22, '3050': 20,
  'rx 7900 xtx': 72, 'rx 9070 xt': 68, 'rx 7900 xt': 62, 'rx 9070': 60, 'rx 7800 xt': 50, 'rx 9060 xt': 42,
  'rx 7700 xt': 42, 'rx 7600 xt': 32, 'rx 7600': 30,
};

export function parseGpu(text) {
  let m = text.match(/(?:RTX|GTX)[\s™®-]*(\d{4})[\s-]*(Ti\b)?[\s-]*(SUPER\b)?/i)
    ?? text.match(/\b([345]0[5-9]0)[\s-]*(Ti\b)[\s-]*(SUPER\b)?/i);
  if (m) {
    const base = m[1] + (m[2] ? ' ti' : '');
    if (!(base in GPU_SCORE)) return null;
    return { gpu: `${m[1]}${m[2] ? ' Ti' : ''}${m[3] ? ' S' : ''}`, score: GPU_SCORE[base] + (m[3] ? 3 : 0) };
  }
  m = text.match(/\bRX[\s-]*(\d{4})[\s-]*(XTX|XT)?\b/i);
  if (m) {
    const base = `rx ${m[1]}${m[2] ? ' ' + m[2].toLowerCase() : ''}`;
    if (base in GPU_SCORE) return { gpu: `RX ${m[1]}${m[2] ? ' ' + m[2].toUpperCase() : ''}`, score: GPU_SCORE[base] };
  }
  return null;
}

export const gpuScore = name => parseGpu(/rtx|gtx|rx/i.test(name) ? name : `RTX ${name}`)?.score ?? Infinity;

export function parseCpu(text) {
  let m;
  if ((m = text.match(/\bi([3579])[\s-]*(\d{4,5}[A-Z]{0,2})\b/i))) return `i${m[1]} ${m[2].toUpperCase()}`;
  if ((m = text.match(/\bU(?:ltra)?[\s-]*([3579])[\s-]+(?:Series\s+\d\s+)?(\d{3}[A-Z]{0,2})\b/i))) return `u${m[1]} ${m[2].toUpperCase()}`;
  if ((m = text.match(/\bCore\s+([3579])[\s-]+(\d{3}[A-Z]{0,2})\b/i))) return `c${m[1]} ${m[2].toUpperCase()}`;
  if ((m = text.match(/Ryzen[\s™]+AI[\s-]+Max\+?[\s-]+(?:PRO[\s-]+)?(\d{3})/i))) return `AI Max ${m[1]}`;
  if ((m = text.match(/Ryzen[\s™]+(?:AI[\s-]+)?([3579])[\s-]+(?:(HX|PRO)[\s-]+)?(\d{3,4}[A-Z0-9]*)/i))) return `r${m[1]} ${m[2] ? m[2].toUpperCase() + ' ' : ''}${m[3].toUpperCase()}`;
  if ((m = text.match(/\bR([3579])[\s-]+(\d{3,4}[A-Z0-9]*)/i))) return `r${m[1]} ${m[2].toUpperCase()}`;
  if ((m = text.match(/\b(\d{4}X3D|\d{4}X)\b/i))) return m[1].toUpperCase();
  // 標題沒寫型號時至少給出系列
  if ((m = text.match(/Core\s+Ultra\s+([3579])(?:\s+(HX|H|U|V|K)\b)?/i))) return `u${m[1]}${m[2] ? ' ' + m[2].toUpperCase() : ''}`;
  if ((m = text.match(/Ryzen[\s™]+(?:AI[\s-]+)?([3579])(?:\s+(HX|HS)\b)?/i))) return `r${m[1]}${m[2] ? ' ' + m[2].toUpperCase() : ''}`;
  if ((m = text.match(/Core\s+i([3579])(?:\s+(HX|H)\b)?/i))) return `i${m[1]}${m[2] ? ' ' + m[2].toUpperCase() : ''}`;
  if ((m = text.match(/\bM([1-5])\s*(Pro|Max)?\b/))) return `M${m[1]}${m[2] ? ' ' + m[2] : ''}`;
  return '';
}

// 逐一看每個「數字+GB/TB」後面跟的字來分辨是 RAM、硬碟還是顯存
export function parseMemDisk(text) {
  let ram = '', disk = '';
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(GB|TB|G)\b/gi)) {
    const n = +m[1], unit = m[2].toUpperCase();
    const next = (text.slice(m.index + m[0].length).match(/^(?:\s*\([^)]*\))?[\s-]*(?:of\s+)?([A-Za-z0-9.]+)/i)?.[1] ?? '').toUpperCase();
    if (/^GDDR|^VRAM|^GRAPHIC|^VIDEO/.test(next)) continue;
    if (unit === 'TB' || /^(SSD|STORAGE|HDD|EMMC|NVME|PCIE|M\.2|UFS|SOLID)/.test(next)) { disk ||= unit === 'TB' ? `${n}T` : `${n}G`; continue; }
    if (/^(RAM|MEMORY|DDR|LPDDR|UNIFIED|SODIMM)/.test(next) && n <= 256) { ram ||= `${n}G`; continue; }
    // 沒有單位說明、又緊跟在顯卡型號後面的是顯存，不是 RAM
    if (/(?:RTX|GTX|RX)[\s™®-]*\d{4}\s*(?:Ti|XTX|XT|SUPER)?[\s,-]*$/i.test(text.slice(0, m.index))) continue;
    if (unit !== 'G' && !ram && n >= 4 && n <= 192 && !/^(GPU|CARD)/.test(next)) ram = `${n}G`;
    else if (unit !== 'G' && ram && !disk && n >= 64) disk = `${n}G`;
  }
  return { ram, disk };
}

// 記憶體套件：回傳 { sticks, per, total, ddr }；看不出條數時視為單條
export function parseRamKit(text) {
  const ddr = +(text.match(/DDR\s*(\d)/i)?.[1] ?? 0);
  let m = text.match(/(\d)\s*x\s*(\d{1,3})\s*GB?\b/i);
  if (m) return { sticks: +m[1], per: +m[2], total: m[1] * m[2], ddr };
  m = text.match(/(\d{1,3})\s*GB\s*x\s*(\d)\b/i);
  if (m) return { sticks: +m[2], per: +m[1], total: m[1] * m[2], ddr };
  m = text.match(/(\d{1,3})\s*GB/i);
  if (!m) return null;
  const total = +m[1];
  const sticks = /\b(kit|dual|2[\s-]*pack|2pc|2 pcs)\b/i.test(text) ? 2 : 1;
  return { sticks, per: total / sticks, total, ddr };
}

export function parseSpecs(text) {
  const g = parseGpu(text);
  return { cpu: parseCpu(text), gpu: g?.gpu ?? '', gpuScore: g?.score ?? 0, ...parseMemDisk(text) };
}

// 符合分類條件就回傳 specs，否則回傳 null
export function evaluate(cat, item) {
  const text = item.name;
  // 站台有給商品類型就只比類型，沒有才退回比標題
  if (cat.type && !cat.type.test(item.type || text)) return null;
  if (cat.include && !cat.include.test(text)) return null;
  if (cat.exclude?.test(text)) return null;
  if (cat.minPrice && item.price < cat.minPrice) return null;
  if (cat.maxPrice && item.price > cat.maxPrice) return null;
  const specs = parseSpecs(text);
  if (cat.minGpu && specs.gpuScore < gpuScore(cat.minGpu)) return null;
  if (cat.minStickGB) {
    const kit = parseRamKit(text);
    if (!kit || kit.per < cat.minStickGB) return null;
    if (cat.ddr && kit.ddr && !cat.ddr.includes(kit.ddr)) return null;
    specs.ram = `${kit.sticks}x${kit.per}G${kit.ddr ? ' D' + kit.ddr : ''}`;
  }
  // 零組件分類只留有意義的欄位，免得把顯存誤標成 RAM
  if (cat.show) for (const k of ['cpu', 'gpu', 'ram', 'disk']) if (!cat.show.includes(k)) specs[k] = '';
  return specs;
}
