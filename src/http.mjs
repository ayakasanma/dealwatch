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
  // Woot：AppSync GraphQL，要帶官網頁面裡公開的 x-api-key（由 src/woot.mjs 加）
  wt: {
    'user-agent': UA,
    accept: 'application/json, text/html;q=0.9, */*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    origin: 'https://www.woot.com',
    referer: 'https://www.woot.com/',
  },
  ne: {
    'user-agent': UA,
    accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
  },
  // RSS 來源：Reddit 要求有辨識度的 User-Agent，用一般瀏覽器 UA 也可以
  sd: { 'user-agent': UA, accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8' },
  rd: { 'user-agent': UA, accept: 'application/atom+xml, application/xml;q=0.9, */*;q=0.8' },
  // Walmart 用最精簡的標頭即可；多送 sec-* 反而會被導到驗證頁
  wm: {
    'user-agent': UA,
    accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
  },
};

// 被站台擋下（驗證頁 / 403 / 429）。呼叫端應退避，不要硬闖。
export class RequestError extends Error {
  constructor(message, code, { status, cause } = {}) {
    super(message, { cause });
    this.name = 'RequestError';
    this.code = code;
    this.status = status;
  }
}

export class Blocked extends RequestError {
  constructor(message, status) { super(message, 'blocked', { status }); this.name = 'Blocked'; }
}

export function requireSuccess(store, { status }) {
  if ([403, 412, 429].includes(status)) throw new Blocked(`${store} 拒絕請求 (HTTP ${status})，請退避或手動檢查驗證頁`, status);
  if (status < 200 || status >= 300) throw new RequestError(`${store} 回應 HTTP ${status}`, 'http', { status });
}

function connectionCode(err) {
  const codes = [err.code, err.cause?.code, ...(err.cause?.errors ?? []).map(e => e.code)];
  if (err.name === 'TimeoutError' || codes.some(c => /TIMEOUT|TIMEDOUT/.test(c ?? ''))) return 'timeout';
  if (codes.some(c => /ENOTFOUND|EAI_AGAIN/.test(c ?? ''))) return 'dns';
  if (codes.some(c => /CERT|TLS|SSL/.test(c ?? ''))) return 'tls';
  return 'network';
}

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
const limits = { bb: limiter(10, 0), wm: limiter(2, 1200), wt: limiter(4, 250), ne: limiter(2, 1500), sd: limiter(2, 1000), rd: limiter(1, 2000), fx: limiter(1, 0) };

export function setPace(host, max, gapMs) { limits[host] = limiter(max, gapMs); }

export function get(host, url, { timeout = 12000, retries = 1, headers, fetchImpl = globalThis.fetch } = {}) {
  return limits[host](async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetchImpl(url, { headers: { ...HEADERS[host], ...headers }, signal: AbortSignal.timeout(timeout) });
        return { status: res.status, body: await res.text() };
      } catch (err) {
        if (attempt >= retries) {
          const code = connectionCode(err);
          const labels = { timeout: '請求逾時', dns: 'DNS 解析失敗', tls: 'TLS／憑證驗證失敗', network: '網路連線失敗' };
          throw new RequestError(`${host} ${labels[code]}`, code, { cause: err });
        }
      }
    }
  });
}
