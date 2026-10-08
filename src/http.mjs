// 共用 HTTP 層：每個站台各自限流、逾時、重試一次。零依賴，使用 Node 22 內建 fetch。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const HEADERS = {
  bb: {
    'user-agent': UA,
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
    'sec-ch-ua': '"Chromium";v="141", "Google Chrome";v="141", "Not?A_Brand";v="8"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    referer: 'https://www.bestbuy.com/',
  },
  // Walmart 用最精簡的標頭即可；多送 sec-* 反而會被導到驗證頁
  wm: {
    'user-agent': UA,
    accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
  },
};

// 被站台擋下（驗證頁 / 403 / 429）。呼叫端應退避，不要硬闖。
export class Blocked extends Error {}

function limiter(max, gapMs) {
  let active = 0, nextSlot = 0;
  const queue = [];
  const pump = () => {
    while (active < max && queue.length) {
      active++;
      const job = queue.shift();
      const wait = Math.max(0, nextSlot - Date.now());
      nextSlot = Date.now() + wait + gapMs * (0.7 + Math.random() * 0.6);
      setTimeout(() => job().finally(() => { active--; pump(); }), wait);
    }
  };
  return fn => new Promise((resolve, reject) => { queue.push(() => fn().then(resolve, reject)); pump(); });
}

// Walmart 對密集請求很敏感，預設就放慢；間隔可由 config.walmart.gapMs 調整
const limits = { bb: limiter(10, 0), wm: limiter(2, 1200) };

export function setPace(host, max, gapMs) { limits[host] = limiter(max, gapMs); }

export function get(host, url, { timeout = 12000, retries = 1 } = {}) {
  return limits[host](async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, { headers: HEADERS[host], signal: AbortSignal.timeout(timeout) });
        return { status: res.status, body: await res.text() };
      } catch (err) {
        if (attempt >= retries) throw new Error(`${host} ${err.name === 'TimeoutError' ? '逾時' : err.cause?.code || err.message}`);
      }
    }
  });
}
