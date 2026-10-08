// Pure pricing logic: no network, no filesystem, easy to test.
// All values are normalised to refined metal ("ref") first, then expressed as ref, keys and USD.

export const QUALITIES = {
  0: 'Normal', 1: 'Genuine', 3: 'Vintage', 5: 'Unusual', 6: 'Unique',
  11: 'Strange', 13: 'Haunted', 14: "Collector's", 15: 'Decorated',
};

const KEY = 'Mann Co. Supply Crate Key';
const REF = 'Refined Metal';
const BUD = 'Earbuds';

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
export const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export const itemId = (e) => `${slugify(e.name)}-${e.quality ?? 6}-${e.priceindex ?? 0}`;

/** Find one price entry in an IGetPrices v4 response. Returns null if the item isn't priced. */
export function findPrice(response, e) {
  return (
    response?.items?.[e.name]?.prices?.[String(e.quality ?? 6)]
      ?.[e.tradable ?? 'Tradable']?.[e.craftable ?? 'Craftable']?.[String(e.priceindex ?? 0)] ?? null
  );
}

/** Round refined metal to the nearest scrap (1/9 ref), the smallest unit trades use: x.00, x.11 ... x.88 */
export function roundMetal(ref) {
  const scraps = Math.round(Math.max(0, ref) * 9);
  return Math.floor(scraps / 9) + Math.round((scraps % 9) * 11) / 100;
}

/** Work out how many ref one key is worth, and how many USD one ref is worth. */
export function getRates(response, usdPerRefOverride = null) {
  const key = findPrice(response, { name: KEY });
  const ref = findPrice(response, { name: REF });
  const bud = findPrice(response, { name: BUD });

  if (!key || key.currency !== 'metal') throw new Error('Could not find the key price in refined metal');
  const keyRef = key.value_high > key.value ? (key.value + key.value_high) / 2 : key.value;

  let usdPerRef = usdPerRefOverride ?? (ref?.currency === 'usd' ? ref.value : null) ?? response.raw_usd_value;
  if (!(usdPerRef > 0)) throw new Error('Could not work out the USD value of refined metal; set USD_PER_REF');
  // 1 ref is only a few cents. A bigger number means the source gave USD per key instead.
  if (usdPerRefOverride == null && usdPerRef > 0.5) usdPerRef /= keyRef;

  return {
    keyRef: round(keyRef, 2),
    usdPerRef: round(usdPerRef, 5),
    keyUsd: round(keyRef * usdPerRef, 2),
    budKeys: bud?.currency === 'keys' ? bud.value : null,
  };
}

/** Convert one backpack.tf price amount into refined metal. Returns null for unsupported currencies. */
function toRef(value, currency, rates) {
  switch (currency) {
    case 'metal': return value;
    case 'keys': return value * rates.keyRef;
    case 'usd': return value / rates.usdPerRef;
    case 'earbuds':
    case 'buds': return rates.budKeys ? value * rates.budKeys * rates.keyRef : null;
    default: return null;
  }
}

/** Express an amount of refined metal as ref, keys and USD, plus a trader-style string. */
export function describe(ref, rates) {
  if (ref == null || !Number.isFinite(ref)) return null;
  const wholeKeys = Math.floor(ref / rates.keyRef + 1e-9);
  const rest = roundMetal(ref - wholeKeys * rates.keyRef);

  const parts = [];
  if (wholeKeys > 0) parts.push(`${wholeKeys} key${wholeKeys === 1 ? '' : 's'}`);
  if (rest > 0 || wholeKeys === 0) parts.push(`${rest.toFixed(2)} ref`);

  return {
    ref: roundMetal(ref),
    keys: round(ref / rates.keyRef, 2),
    usd: round(ref * rates.usdPerRef, 2),
    pretty: parts.join(', '),
  };
}

/** Convert an amount in "ref", "keys" or "usd" into all three. */
export function convert(amount, from, rates) {
  if (!Number.isFinite(amount) || amount < 0) return null;
  const ref = { ref: amount, keys: amount * rates.keyRef, usd: amount / rates.usdPerRef }[from];
  return ref == null ? null : describe(ref, rates);
}

/** Build the tracker's view of the market from a price response and a watchlist. */
export function buildSnapshot(response, watchlist, { source = 'backpack.tf', usdPerRefOverride = null } = {}) {
  const rates = getRates(response, usdPerRefOverride);

  const items = watchlist.map((entry) => {
    const quality = entry.quality ?? 6;
    const base = {
      id: itemId(entry),
      name: entry.name,
      label: entry.effect ? `${entry.effect} ${entry.name}` : entry.name,
      quality,
      qualityName: QUALITIES[quality] ?? 'Unknown',
      priceindex: entry.priceindex ?? 0,
    };

    const node = findPrice(response, entry);
    if (!node) return { ...base, found: false, currency: null, value: null, low: null, high: null, lastUpdate: null };

    const low = toRef(node.value, node.currency, rates);
    const high = node.value_high > node.value ? toRef(node.value_high, node.currency, rates) : null;
    const mid = low != null && high != null ? (low + high) / 2 : low;

    return {
      ...base,
      found: true,
      currency: node.currency,
      value: describe(mid, rates),
      low: describe(low, rates),
      high: describe(high, rates),
      lastUpdate: node.last_update ? node.last_update * 1000 : null,
    };
  });

  return { updatedAt: Date.now(), source, rates, items };
}
