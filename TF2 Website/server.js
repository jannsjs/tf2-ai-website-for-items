import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config, ROOT } from './src/config.js';
import { fetchPrices } from './src/bptf.js';
import { buildSnapshot, convert, QUALITIES } from './src/pricing.js';
import { History } from './src/history.js';

const DATA = path.join(ROOT, 'data');
const PUBLIC = path.join(ROOT, 'public');
const mode = config.demo ? 'demo' : 'live';
const intervalMs = config.refreshMinutes * 60_000;
const history = new History(path.join(DATA, `history.${mode}.json`));
const CACHE = path.join(DATA, `cache.${mode}.json`);

let snapshot = null;
let lastError = null;

// ---------- Price refresh ----------

const CURRENCY_ITEMS = new Set(['Mann Co. Supply Crate Key', 'Refined Metal', 'Earbuds']);

/** Demo mode: nudge sample prices by up to +/-1.5% so history and trends have something to show. */
function jitter(response) {
  for (const [name, item] of Object.entries(response.items)) {
    if (CURRENCY_ITEMS.has(name)) continue;
    for (const byTrade of Object.values(item.prices))
      for (const byCraft of Object.values(byTrade))
        for (const byIndex of Object.values(byCraft))
          for (const node of Object.values(byIndex)) {
            const f = 1 + (Math.random() - 0.5) * 0.03;
            node.value = Math.round(node.value * f * 100) / 100;
            if (node.value_high) node.value_high = Math.round(node.value_high * f * 100) / 100;
          }
  }
  return response;
}

async function loadResponse() {
  if (!config.demo) return fetchPrices(config.apiKey);
  return jitter(JSON.parse(await readFile(path.join(DATA, 'sample-prices.json'), 'utf8')));
}

async function refresh() {
  try {
    // The watchlist is re-read on every refresh, so edits apply without a restart.
    const watchlist = JSON.parse(await readFile(path.join(DATA, 'watchlist.json'), 'utf8'));
    snapshot = buildSnapshot(await loadResponse(), watchlist, {
      source: config.demo ? 'demo' : 'backpack.tf',
      usdPerRefOverride: config.usdPerRefOverride,
    });
    lastError = null;
    history.record(snapshot);
    await history.save();
    await writeFile(CACHE, JSON.stringify(snapshot));
    console.log(`[refresh] ${snapshot.items.length} items, 1 key = ${snapshot.rates.keyRef} ref`);
  } catch (err) {
    lastError = err.message;
    console.error(`[refresh] failed: ${err.message}`);
  }
}

// ---------- API ----------

const SORTS = {
  value: (a, b) => (b.value?.ref ?? -1) - (a.value?.ref ?? -1),
  name: (a, b) => a.label.localeCompare(b.label),
  change: (a, b) => (b.change?.pct ?? -Infinity) - (a.change?.pct ?? -Infinity),
};

const enrich = (item) => ({ ...item, change: history.change(item.id), spark: history.spark(item.id) });
const meta = () => ({
  source: snapshot.source,
  demo: config.demo,
  updatedAt: snapshot.updatedAt,
  rates: snapshot.rates,
  lastError,
});

function qualityNumber(value) {
  if (/^\d+$/.test(value)) return Number(value);
  return Number(Object.keys(QUALITIES).find((k) => QUALITIES[k].toLowerCase() === value.toLowerCase()));
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  });
  res.end(JSON.stringify(body));
}

function handleApi(url, res) {
  const p = url.pathname.replace(/\/+$/, '');

  if (p === '/api/health') {
    return json(res, 200, { ok: true, mode, hasData: !!snapshot, updatedAt: snapshot?.updatedAt ?? null, lastError });
  }
  if (!snapshot) {
    return json(res, 503, { error: lastError ?? 'Prices are still loading. Try again in a few seconds.' });
  }

  if (p === '/api/currencies') return json(res, 200, meta());

  if (p === '/api/items') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const quality = url.searchParams.get('quality');
    const sort = SORTS[url.searchParams.get('sort')] ?? SORTS.value;
    let items = snapshot.items.map(enrich);
    if (q) items = items.filter((i) => i.label.toLowerCase().includes(q));
    if (quality) items = items.filter((i) => i.quality === qualityNumber(quality));
    items.sort(sort);
    const limit = Number(url.searchParams.get('limit'));
    if (limit > 0) items = items.slice(0, limit);
    return json(res, 200, { ...meta(), count: items.length, items });
  }

  if (p.startsWith('/api/items/')) {
    const id = decodeURIComponent(p.slice('/api/items/'.length));
    const item = snapshot.items.find((i) => i.id === id);
    if (!item) return json(res, 404, { error: `No tracked item with id "${id}"` });
    const points = history.get(id).map(([t, ref]) => ({ t, ref }));
    return json(res, 200, { ...meta(), item: { ...enrich(item), history: points } });
  }

  if (p === '/api/convert') {
    const amount = Number(url.searchParams.get('amount') ?? 1);
    const from = url.searchParams.get('from') ?? 'keys';
    const result = convert(amount, from, snapshot.rates);
    if (!result) return json(res, 400, { error: 'Use ?amount=<number>&from=keys|ref|usd' });
    return json(res, 200, { amount, from, ...result, rates: snapshot.rates });
  }

  return json(res, 404, { error: 'Unknown API route' });
}

// ---------- Static files ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

async function serveStatic(url, res) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

// ---------- Start ----------

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return handleApi(url, res);
    await serveStatic(url, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: 'Internal server error' });
  }
});

await history.load();
try {
  snapshot = JSON.parse(await readFile(CACHE, 'utf8')); // serve last known prices immediately after a restart
} catch {
  /* no cache yet */
}

server.listen(config.port, config.host, () => {
  console.log(`TF2 High-Value Ledger running at http://${config.host}:${config.port} (${mode} mode)`);
  if (config.demo) console.log('No BPTF_API_KEY set: serving sample data. See README to switch to live prices.');
});

if (!snapshot || Date.now() - snapshot.updatedAt > intervalMs) refresh();
setInterval(refresh, intervalMs);
