import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Minimal .env loader so the project needs no dependencies.
try {
  for (const line of readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {
  // No .env file: that's fine, defaults apply.
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || '127.0.0.1',
  apiKey: process.env.BPTF_API_KEY || '',
  // backpack.tf rate-limits the price endpoint, so never refresh faster than every 5 minutes.
  refreshMinutes: Math.max(Number(process.env.REFRESH_MINUTES) || 10, 5),
  usdPerRefOverride: Number(process.env.USD_PER_REF) || null,
};

// Without an API key the app serves clearly-labelled sample data.
config.demo = !config.apiKey;
