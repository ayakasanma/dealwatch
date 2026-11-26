// 店家清單：代號、顯示名稱、表格縮寫、config.categories[*].queries 裡用的鍵名。
// 新增店家時在這裡加一筆，再到 src/monitor.mjs 的 storeSearch / storeProduct 接上搜尋與單品查詢。
export const STORES = {
  bb: { name: 'Best Buy', short: 'BB', queries: 'bestbuy' },
  wm: { name: 'Walmart', short: 'WM', queries: 'walmart' },
  wt: { name: 'Woot', short: 'WT', queries: 'woot' },
  ne: { name: 'Newegg', short: 'NE', queries: 'newegg' },
  // eBay 只看直購（Buy It Now）；seller 是 eBay 賣家帳號
  eb: { name: 'eBay', short: 'EB', queries: 'ebay' },
  mc: { name: 'Micro Center', short: 'MC', queries: 'microcenter' },
  // 社群回報的 deal：商品實際在別家店賣，表格的「賣家」欄是那家店
  sd: { name: 'Slickdeals', short: 'SD', queries: 'slickdeals' },
  rd: { name: 'r/buildapcsales', short: 'RD', queries: 'reddit' },
};

export const storeName = code => STORES[code]?.name ?? code;
export const storeShort = code => STORES[code]?.short ?? String(code).toUpperCase();
