// Pure laptop RAM evidence and notification policy. Never infer factory installation from capacity alone.
const gb = value => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n >= 4 && n <= 256 ? n : null;
};

export function laptopRamEvidence(item) {
  const title = String(item?.name ?? '');
  // Prefer explicitly labelled system memory. Avoid GPU VRAM and maximum supported RAM.
  const cleaned = title.replace(/\b(?:up to|supports?|maximum|max(?:imum)? supported)\s+\d+\s*GB\s*(?:RAM|memory|DDR[45])?/gi, ' ');
  const explicit = [
    ...cleaned.matchAll(/\b(\d{1,3})\s*GB\s*(?:RAM|system memory|DDR[45X]?|LPDDR\w*|SODIMM|installed memory)\b/gi),
    ...cleaned.matchAll(/\b(?:RAM|system memory|installed memory|DDR[45X]?|LPDDR\w*)\s*[:\-]?\s*(\d{1,3})\s*GB\b/gi),
  ].map(m => gb(m[1])).filter(Boolean);
  const kits = [...cleaned.matchAll(/\b([124])\s*[x×]\s*(\d{1,3})\s*GB\b/gi)]
    .map(m => gb(+m[1] * +m[2])).filter(Boolean);
  const values = [...explicit, ...kits];
  const parsed = gb(item?.specs?.ram);
  // Incomplete/mismatched listings should not qualify as verified factory memory.
  const conflict = new Set(values).size > 1 || (values.length && parsed && !values.includes(parsed));
  const amount = conflict ? null : (values[0] ?? parsed);
  const upgraded = /\b(?:seller|professionally|custom|manually|aftermarket)\s*(?:installed|upgraded|upgrade|added)|\bupgrad(?:ed|e)\s*(?:to|with)\s*\d+\s*GB|\b\d+\s*GB\s*(?:upgrad(?:ed|e)|aftermarket)\b/i.test(title);
  const factory = /\b(?:factory[\s-]*installed|factory[\s-]*configured|original\s+(?:factory|manufacturer)\s+configuration|stock\s+configuration)\b/i.test(title);
  const source = conflict ? 'conflict' : upgraded ? 'upgraded' : factory && amount ? 'factory' : amount ? 'unverified' : 'unknown';
  const priority = source === 'factory' && amount >= 32 ? 'high'
    : source === 'unverified' && amount >= 32 ? 'medium' : 'low';
  const labels = {
    factory: '原廠配置明確標示',
    upgraded: '疑似後續升級，原廠容量未證實',
    unverified: '容量已標示，原廠配置未證實',
    unknown: 'RAM 規格未知',
    conflict: 'RAM 容量標示衝突',
  };
  return { gb: amount, source, priority, label: labels[source] };
}

export const alertPriorityScore = p => ({ high: 3, medium: 2, low: 1 }[p] ?? 1);

// A watchlist target explicitly requests a notification independent of RAM policy.
export function shouldNotifyDeal(item, minPriority = 'medium') {
  if (!item?.deal?.steal) return false;
  if (item.watch?.maxPrice != null && item.price <= item.watch.maxPrice) return true;
  return alertPriorityScore(item.deal.priority ?? 'high') >= alertPriorityScore(minPriority);
}

export function sortAlertsByPriority(alerts) {
  return [...alerts].sort((a, b) =>
    alertPriorityScore(b.item?.deal?.priority ?? 'high') - alertPriorityScore(a.item?.deal?.priority ?? 'high'));
}
