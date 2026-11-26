// Best Buy：走官網前端用的 GraphQL gateway（GET），一次請求拿到整頁商品與每個 open-box 成色的價格。
import { get, Blocked, RequestError, requireSuccess } from './http.mjs';

const PRODUCT_FIELDS = 'skuId dotComDisplayStatus condition{type}name{short}whatItIs url{pdp}seller{classification}price(input:$price){customerPrice displayableRegularPrice}buyingOptions{type pdpUrl product{skuId openBoxCondition price(input:$price){customerPrice}}}';
const SEARCH_QUERY = `query S($input:SearchInput!$pagination:SearchPagination!$filter:SearchFilter$sort:SearchSort$price:ProductItemPriceInput!){search(input:$input pagination:$pagination filter:$filter sort:$sort){numFound documents{...on SearchProduct{product{${PRODUCT_FIELDS}}}}}}`;
const PRODUCT_QUERY = `query P($id:String!$price:ProductItemPriceInput!){productBySkuId(skuId:$id){${PRODUCT_FIELDS}}}`;

const PRICE_INPUT = { salesChannel: 'LargeView', context: 'plp', displayLocation: 'medium-plp' };

// open-box 的 listing_id 就是成色代碼：2=Excellent 1=Good 0=Fair
export const cartUrl = (sku, obCode) =>
  `https://api.bestbuy.com/click/-/${sku}/cart${obCode == null ? '' : `?seller_id=BBY_OB&listing_id=${obCode}`}`;

export const CHECKOUT_URL = 'https://www.bestbuy.com/checkout/r/fast-track';

export function openBoxUrl(pdp, condition) {
  const url = new URL(pdp, 'https://www.bestbuy.com');
  if (!url.pathname.replace(/\/$/, '').endsWith('/openbox')) url.pathname = `${url.pathname.replace(/\/$/, '')}/openbox`;
  url.searchParams.set('condition', condition.toLowerCase());
  return url.href;
}

async function gql(query, variables, httpOptions) {
  const url = `https://www.bestbuy.com/gateway/graphql?query=${encodeURIComponent(query)}&variables=${encodeURIComponent(JSON.stringify(variables))}`;
  const response = await get('bb', url, httpOptions);
  requireSuccess('Best Buy', response);
  const { body } = response;
  if (/Robot or human\?|<title[^>]*>\s*Access Denied/i.test(body)) throw new Blocked('Best Buy 要求驗證或拒絕存取');
  try {
    const json = JSON.parse(body);
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error();
    return json;
  } catch { throw new RequestError('Best Buy 回應格式不符（預期 JSON 物件）', 'format'); }
}

// condition: 'Open-Box' | 'Refurbished' | 'New' | null(不限)
// onlyOpenBox: true 時不帶 condition_facet，直接從一般搜尋的 buyingOptions 抽出 Open-Box（補抓被 facet 漏掉的商品）
export async function search({ query, condition = null, page = 1, size = 100, sort = '', zip = '', onlyOpenBox = false }, httpOptions) {
  const json = await gql(SEARCH_QUERY, {
    input: { site: 'WWW', queryType: 'SEARCH', query },
    pagination: { pageNumber: page, offset: size },
    filter: {
      enableMarketplace: true,
      facets: condition ? [{ facetField: 'condition_facet', value: condition }] : [],
      deviceClass: 'l',
      removeCombos: false,
      collapse: true,
      autoFacet: true,
      ...(zip && { availability: { enableDeliveryFacet: false, zipCode: zip, preferredStore: '', availableStoresList: '' } }),
    },
    sort: { sort },
    price: PRICE_INPUT,
  }, httpOptions);
  const result = json.data?.search;
  // 個別商品的欄位錯誤會以 partial error 回來，有 documents 就照用；查無結果時 documents 是 null
  if (result?.documents == null) {
    if (json.errors?.length && !json.errors.every(e => e.extensions?.code === 'NOT_FOUND')) throw new RequestError('Best Buy GraphQL 查詢失敗', 'upstream');
    if (result?.documents === null || json.errors?.length) return { total: 0, items: [] };
    throw new RequestError('Best Buy 回應缺少 data.search.documents', 'format');
  }
  if (!Array.isArray(result.documents)) throw new RequestError('Best Buy documents 格式不符', 'format');
  return { total: result.numFound ?? 0, items: result.documents.flatMap(d => normalize(d.product, onlyOpenBox ? 'Open-Box' : condition)) };
}

// 直接用 SKU 查單一商品。回傳它目前所有買得到的形式：本身（全新或整新），以及有的話 open-box
export async function product(sku) {
  const p = (await gql(PRODUCT_QUERY, { id: String(sku), price: PRICE_INPUT })).data?.productBySkuId;
  if (!p?.skuId) return [];
  return [...normalize(p, 'Open-Box'), ...normalize(p, null)];
}

function normalize(p, condition) {
  if (!p?.skuId || !p.name?.short) return [];
  const thirdParty = p.seller?.classification === '3P';
  const base = {
    store: 'bb',
    id: p.skuId,
    name: p.name.short,
    type: (p.whatItIs ?? []).join(' '),
    seller: thirdParty ? '3P賣家' : 'BestBuy',
    inStock: p.dotComDisplayStatus !== 'inactive',
    stockKnown: false, // 僅表示此商品有可追蹤的價格，尚未確認所在地庫存；markStock 查到結果後才改成 true
  };
  const newPrice = p.price?.customerPrice;

  if (condition === 'Open-Box') {
    const offers = (p.buyingOptions ?? [])
      .filter(b => b.product?.openBoxCondition != null && b.product.price?.customerPrice > 0)
      .map(b => ({ cond: b.type, code: b.product.openBoxCondition, price: b.product.price.customerPrice, pdp: b.pdpUrl }))
      .sort((a, b) => a.price - b.price);
    if (!offers.length) return [];
    const best = offers[0];
    const refPrice = newPrice > best.price ? newPrice
      : p.price?.displayableRegularPrice > best.price ? p.price.displayableRegularPrice : undefined;
    return [{
      ...base,
      // 新品已停產下架（dotComDisplayStatus === 'inactive'）時，buyingOptions 仍可能有清倉 Open-Box 可買
      inStock: true,
      kind: 'ob',
      key: `bb:${p.skuId}:ob`,
      cond: `OB ${best.cond}`,
      price: best.price,
      ref: refPrice,
      offers,
      url: openBoxUrl(best.pdp ?? p.url?.pdp, best.cond),
      cartUrl: cartUrl(p.skuId, best.code),
    }];
  }

  if (!(newPrice > 0)) return [];
  // 第三方賣家的整新品 condition.type 不一定是 refurbished，所以連標題一起看
  const refurb = condition === 'Refurbished' || /refurb|pre-owned/i.test(`${p.condition?.type} ${p.name.short}`);
  const grade = p.name.short.match(/Refurbished (Excellent|Good|Fair)/i)?.[1];
  return [{
    ...base,
    kind: refurb ? 'refurb' : 'new',
    key: `bb:${p.skuId}:${refurb ? 'refurb' : 'new'}`,
    cond: refurb ? `Refurb${grade ? ' ' + grade : ''}` : 'New',
    price: newPrice,
    ref: p.price?.displayableRegularPrice,
    // 帶 /sku/ 的網址才會開到這個賣家的這一件；只有共用頁網址時可能開到同款的全新品
    url: p.buyingOptions?.find(b => b.product?.skuId === p.skuId && b.product.openBoxCondition == null)?.pdpUrl ?? p.url?.pdp,
    // Best Buy 的加入購物車連結不支援 Marketplace 第三方賣家的商品，只能到商品頁按
    cartUrl: thirdParty ? null : cartUrl(p.skuId),
  }];
}

// 自營商品（Best Buy 自己出貨的全新 / 整新品）有沒有貨：可配送或可門市取貨就算有。
// 查不到或回應異常回傳 null（未知）。第三方賣家的商品這個端點一律回不可配送，不能用，要靠 pageStock。
export async function available(sku, zip) {
  const url = `https://www.bestbuy.com/fulfillment/shipping/api/v1/fulfillment/sku;skuId=${sku};postalCode=${zip || '55423'};deliveryDateOption=EARLIEST_AVAILABLE_DATE`;
  try {
    const { status, body } = await get('bb', url, { timeout: 8000, retries: 0, headers: { 'x-client-id': 'FRV' } });
    const info = status === 200 ? JSON.parse(body).responseInfos?.[0] : null;
    return info ? !!(info.shippingEligible || info.pickupEligible) : null;
  } catch { return null; }
}

// 用真正的瀏覽器開商品頁，看主要的購買按鈕是「Add to cart」還是「Sold Out」之類。
// 頁面上第一顆購買類按鈕就是主按鈕，後面的是推薦商品的。回傳 true / false，判斷不出來回傳 null。
const BUY_BUTTON = `(() => {
  const texts = [...document.querySelectorAll('button')].map(b => b.innerText.trim());
  const main = texts.find(t => /^(add to cart|pre-?order|sold out|notify me|coming soon|unavailable|check stores|find a store)/i.test(t));
  return main ?? '';
})()`;

export async function pageStock(browser, url) {
  // 分頁正停在人機驗證頁等人處理時不要換走，當作判斷不出來
  if (!browser || browser.hold) return null;
  try {
    const text = await browser.evaluate(url, BUY_BUTTON, { until: v => v !== '', timeout: 12000 });
    if (!text) return null;
    return /^(add to cart|pre-?order)/i.test(text);
  } catch { return null; }
}
