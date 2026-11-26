// 用「你自己已登入的瀏覽器」開加入購物車連結，再跳結帳頁。腳本不會送出訂單。
import { spawn } from 'node:child_process';
import { CHECKOUT_URL } from './bestbuy.mjs';

export function openUrl(url, browser) {
  const [cmd, args] = browser ? [browser, [url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', e => console.error(`開啟瀏覽器失敗: ${e.message}`)).unref();
}

export function addToCart(item, { browser, goCheckout = true, checkoutDelayMs = 3500, opener = openUrl } = {}) {
  if (item.store === 'wm') {
    // Walmart 的 buynow 連結會加入購物車後直接往結帳走（未登入時停在購物車頁）
    opener(goCheckout ? item.cartUrl.replace('/cart/addToCart?', '/cart/buynow?') : item.cartUrl, browser);
    return Promise.resolve();
  }
  if (item.store === 'bb') {
    // Best Buy：先開加入購物車連結，等它完成後再開結帳頁
    opener(item.cartUrl, browser);
    if (!goCheckout) return Promise.resolve();
    return new Promise(resolve => setTimeout(() => { opener(CHECKOUT_URL, browser); resolve(); }, checkoutDelayMs));
  }
  // Newegg 自營等其他有 cartUrl 的店家：僅開加購物車頁，不導向 Best Buy 結帳頁
  opener(item.cartUrl, browser);
  return Promise.resolve();
}
