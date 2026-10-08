import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const MAX_POINTS = 1500; // about 10 days at the default 10-minute refresh

/** Keeps a small time series of each item's value in refined metal, saved as JSON on disk. */
export class History {
  constructor(file) {
    this.file = file;
    this.series = {}; // id -> [[timestampMs, ref], ...]
  }

  async load() {
    try {
      this.series = JSON.parse(await readFile(this.file, 'utf8'));
    } catch {
      this.series = {};
    }
  }

  async save() {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.series));
  }

  record(snapshot) {
    for (const item of snapshot.items) {
      if (!item.value) continue;
      const points = (this.series[item.id] ??= []);
      points.push([snapshot.updatedAt, item.value.ref]);
      if (points.length > MAX_POINTS) points.splice(0, points.length - MAX_POINTS);
    }
  }

  get(id) {
    return this.series[id] ?? [];
  }

  spark(id, count = 48) {
    return this.get(id).slice(-count).map((p) => p[1]);
  }

  /** Percent change versus 24 hours ago (or since tracking began, if that's more recent). */
  change(id) {
    const points = this.get(id);
    if (points.length < 2) return null;
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const old = points.find((p) => p[0] >= cutoff) ?? points[0];
    const latest = points[points.length - 1];
    if (old === latest || old[1] === 0) return null;
    return { pct: Math.round(((latest[1] - old[1]) / old[1]) * 1000) / 10, since: old[0] };
  }
}
