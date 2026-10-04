import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function summarize(episodes) {
  if (!episodes.length) throw new Error('No episodes');
  for (const e of episodes) {
    if (typeof e.passed !== 'boolean' || !Number.isFinite(e.elapsed_ms) || e.elapsed_ms < 0 ||
        !Number.isFinite(e.deadline_seconds) || e.deadline_seconds <= 0 ||
        (e.passed && e.elapsed_ms > e.deadline_seconds * 1000)) {
      throw new Error('Invalid episode or success beyond deadline');
    }
  }
  const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
  const successful = episodes.filter(e => e.passed).map(e => e.elapsed_ms).sort((a, b) => a - b);
  const percentile = q => {
    if (!successful.length) return null;
    const position = (successful.length - 1) * q;
    const lo = Math.floor(position), hi = Math.ceil(position);
    return successful[lo] + (successful[hi] - successful[lo]) * (position - lo);
  };
  return {
    episodes: episodes.length, passed: successful.length,
    observed_mean_ms: mean(episodes.map(e => e.elapsed_ms)),
    deadline_penalized_mean_ms: mean(episodes.map(e => e.passed ? e.elapsed_ms : e.deadline_seconds * 1000)),
    success_p50_ms: percentile(0.5), success_p95_ms: percentile(0.95),
  };
}

export function report(data) {
  const groups = new Map();
  for (const e of data.episodes) {
    const key = `${e.lane}/${e.configuration}`;
    if (!groups.has(key)) groups.set(key, []);
    const group = groups.get(key);
    if (group.some(x => x.id === e.id && x.seed === e.seed)) throw new Error('Duplicate task/seed');
    group.push(e);
  }
  const populations = Object.fromEntries([...groups].map(([key, es]) => [key, summarize(es)]));
  const official = data.episodes.filter(e => e.lane === 'official-overlap');
  const keys = new Set(official.map(e => `${e.id}/${e.seed}`));
  const overlap = {};
  for (const [key, es] of groups) {
    if (!key.startsWith('text/')) continue;
    const shared = es.filter(e => keys.has(`${e.id}/${e.seed}`));
    if (shared.length !== keys.size) throw new Error('Incomplete overlap');
    overlap[key] = summarize(shared);
  }
  return { warning: 'Exploratory cross-run descriptive comparison; not matched product evaluation.', populations,
    exploratory_overlap: { official: summarize(official), tabora: overlap } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2] ?? fileURLToPath(new URL('./pilot-2026-10-04.json', import.meta.url));
  console.log(JSON.stringify(report(JSON.parse(readFileSync(path, 'utf8'))), null, 2));
}
