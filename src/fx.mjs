// 美金匯率。eBay 依連線的國家顯示當地幣別，頁面上沒有原始美金價；撿漏標準和 MSRP 都是美金，要換算才能比。
// 來源是 ExchangeRate-API 的免費端點（不用金鑰，每天更新）。更新失敗就沿用舊的，從來沒抓到過才報錯，不能把當地幣別當美金。
import { get, requireSuccess, RequestError } from './http.mjs';

const ENDPOINT = 'https://open.er-api.com/v6/latest/USD';
const TTL = 24 * 36e5;

let cache = null; // { t, rates }
let job = null; // 進行中的抓取

// 測試用：直接指定匯率（null = 清掉）
export function setRates(rates) {
  cache = rates ? { t: Date.now(), rates } : null;
  job = null;
}

function refresh(httpOptions) {
  return job ??= get('fx', ENDPOINT, httpOptions).then(response => {
    requireSuccess('匯率來源', response);
    let rates;
    try { rates = JSON.parse(response.body ?? '').rates; } catch {}
    if (!(rates?.USD > 0)) throw new RequestError('匯率來源格式改變', 'format');
    cache = { t: Date.now(), rates };
  }).finally(() => { job = null; });
}

// 1 美金等於多少 code
export async function usdRate(code, httpOptions) {
  if (code === 'USD') return 1;
  if (!cache || Date.now() - cache.t >= TTL) {
    try { await refresh(httpOptions); } catch (err) { if (!cache) throw err; }
  }
  const rate = cache.rates[code];
  if (!(rate > 0)) throw new RequestError(`沒有 ${code} 的匯率`, 'format');
  return rate;
}
