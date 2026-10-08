// Best Buy：走官網前端用的 GraphQL gateway（GET），一次請求拿到整頁商品與每個 open-box 成色的價格。
import { get, Blocked } from './http.mjs';

const QUERY = 'query S($input:SearchInput!$pagination:SearchPagination!$filter:SearchFilter$sort:SearchSort$price:ProductItemPriceInput!){search(input:$input pagination:$pagination filter:$filter sort:$sort){numFound documents{...on SearchProduct{product{skuId condition{type}name{short}whatItIs url{pdp}seller{classification}price(input:$price){customerPrice displayableRegularPrice}buyingOptions{type pdpUrl product{skuId openBoxCondition price(input:$price){customerPrice}}}}}}}}';

const PRICE_INPUT = { salesChannel: 'LargeView', context: 'plp', displayLocation: 'medium-plp' };

// open-box 的 listing_id 就是成色代碼：2=Excellent 1=Good 0=Fair
export const cartUrl = (sku, obCode) =>
  `https://api.bestbuy.com/click/-/${sku}/cart${obCode == null ? '' : `?seller_id=BBY_OB&listing_id=${obCode}`}`;

export const CHECKOUT_URL = 'https://www.bestbuy.com/checkout/r/fast-track';

// condition: 'Open-Box' | 'Refurbished' | 'New' | null(不限)
export async function search({ query, condition = null, page = 1, size = 100, sort = '', zip = '' }) {
  const variables = {
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
  };
  const url = `https://www.bestbuy.com/gateway/graphql?query=${encodeURIComponent(QUERY)}&variables=${encodeURIComponent(JSON.stringify(variables))}`;
  const { status, body } = await get('bb', url);
  if (status === 403 || status === 429) throw new Blocked(`Best Buy 回應 HTTP ${status}`);
  let json;
  try { json = JSON.parse(body); } catch { throw new Blocked(`Best Buy 回應非 JSON (HTTP ${status})`); }
  const result = json.data?.search;
  // 個別商品的欄位錯誤會以 partial error 回來，有 documents 就照用；查無結果有時會回 NOT_FOUND
  if (!result?.documents) {
    if (json.errors?.length && json.errors.every(e => e.extensions?.code === 'NOT_FOUND')) return { total: 0, items: [] };
    throw new Error(`Best Buy 查詢失敗: ${JSON.stringify(json.errors ?? json).slice(0, 200)}`);
  }
  return { total: result.numFound ?? 0, items: result.documents.flatMap(d => normalize(d.product, condition)) };
}

function normalize(p, condition) {
  if (!p?.skuId || !p.name?.short) return [];
  const base = {
    store: 'bb',
    id: p.skuId,
    name: p.name.short,
    type: (p.whatItIs ?? []).join(' '),
    seller: p.seller?.classification === '3P' ? '3P賣家' : 'BestBuy',
    inStock: true,
  };
  const newPrice = p.price?.customerPrice;

  if (condition === 'Open-Box') {
    const offers = (p.buyingOptions ?? [])
      .filter(b => b.product?.openBoxCondition != null && b.product.price?.customerPrice > 0)
      .map(b => ({ cond: b.type, code: b.product.openBoxCondition, price: b.product.price.customerPrice, pdp: b.pdpUrl }))
      .sort((a, b) => a.price - b.price);
    if (!offers.length) return [];
    const best = offers[0];
    return [{
      ...base,
      kind: 'ob',
      key: `bb:${p.skuId}:ob`,
      cond: `OB ${best.cond}`,
      price: best.price,
      ref: newPrice > best.price ? newPrice : p.price?.displayableRegularPrice,
      offers,
      url: `${best.pdp ?? p.url?.pdp}/openbox?condition=${best.cond.toLowerCase()}`,
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
    url: p.url?.pdp,
    cartUrl: cartUrl(p.skuId),
  }];
}
