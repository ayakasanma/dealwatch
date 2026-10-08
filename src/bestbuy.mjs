// Best Buy：走官網前端用的 GraphQL gateway（GET），一次請求拿到整頁商品與每個 open-box 成色的價格。
import { get, Blocked } from './http.mjs';

const PRODUCT_FIELDS = 'skuId condition{type}name{short}whatItIs url{pdp}seller{classification}price(input:$price){customerPrice displayableRegularPrice}buyingOptions{type pdpUrl product{skuId openBoxCondition price(input:$price){customerPrice}}}';
const SEARCH_QUERY = `query S($input:SearchInput!$pagination:SearchPagination!$filter:SearchFilter$sort:SearchSort$price:ProductItemPriceInput!){search(input:$input pagination:$pagination filter:$filter sort:$sort){numFound documents{...on SearchProduct{product{${PRODUCT_FIELDS}}}}}}`;
const PRODUCT_QUERY = `query P($id:String!$price:ProductItemPriceInput!){productBySkuId(skuId:$id){${PRODUCT_FIELDS}}}`;

const PRICE_INPUT = { salesChannel: 'LargeView', context: 'plp', displayLocation: 'medium-plp' };

// open-box 的 listing_id 就是成色代碼：2=Excellent 1=Good 0=Fair
export const cartUrl = (sku, obCode) =>
  `https://api.bestbuy.com/click/-/${sku}/cart${obCode == null ? '' : `?seller_id=BBY_OB&listing_id=${obCode}`}`;

export const CHECKOUT_URL = 'https://www.bestbuy.com/checkout/r/fast-track';

async function gql(query, variables) {
  const url = `https://www.bestbuy.com/gateway/graphql?query=${encodeURIComponent(query)}&variables=${encodeURIComponent(JSON.stringify(variables))}`;
  const { status, body } = await get('bb', url);
  if (status === 403 || status === 429) throw new Blocked(`Best Buy 回應 HTTP ${status}`);
  try { return JSON.parse(body); } catch { throw new Blocked(`Best Buy 回應非 JSON (HTTP ${status})`); }
}

// condition: 'Open-Box' | 'Refurbished' | 'New' | null(不限)
export async function search({ query, condition = null, page = 1, size = 100, sort = '', zip = '' }) {
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
  });
  const result = json.data?.search;
  // 個別商品的欄位錯誤會以 partial error 回來，有 documents 就照用；查無結果時 documents 是 null
  if (!result?.documents) {
    if (!json.errors?.length || json.errors.every(e => e.extensions?.code === 'NOT_FOUND')) return { total: 0, items: [] };
    throw new Error(`Best Buy 查詢失敗: ${JSON.stringify(json.errors).slice(0, 200)}`);
  }
  return { total: result.numFound ?? 0, items: result.documents.flatMap(d => normalize(d.product, condition)) };
}

// 直接用 SKU 查單一商品。回傳它目前所有買得到的形式：本身（全新或整新），以及有的話 open-box
export async function product(sku) {
  const p = (await gql(PRODUCT_QUERY, { id: String(sku), price: PRICE_INPUT })).data?.productBySkuId;
  if (!p?.skuId) return [];
  return [...normalize(p, 'Open-Box'), ...normalize(p, null)];
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
