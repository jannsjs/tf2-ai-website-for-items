const BASE = 'https://backpack.tf/api';

/** Fetch the full TF2 price schema from backpack.tf (IGetPrices v4). */
export async function fetchPrices(apiKey) {
  const res = await fetch(`${BASE}/IGetPrices/v4?key=${encodeURIComponent(apiKey)}`, {
    headers: { 'User-Agent': 'tf2-hv-tracker', Accept: 'application/json' },
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 429) throw new Error('backpack.tf rate limit hit; try a longer REFRESH_MINUTES');
  if (!res.ok) throw new Error(`backpack.tf responded with HTTP ${res.status}`);

  const body = await res.json();
  if (!body.response?.success) {
    throw new Error(body.response?.message || 'backpack.tf returned an error (is BPTF_API_KEY valid?)');
  }
  return body.response;
}
