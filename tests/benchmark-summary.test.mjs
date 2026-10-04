import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { summarize, report } from '../docs/benchmarks/summarize.mjs';

test('fast failure pays the deadline and is excluded from conditional latency', () => {
  const stats = summarize([
    { passed: true, elapsed_ms: 1000, deadline_seconds: 120 },
    { passed: false, elapsed_ms: 10, deadline_seconds: 120 },
  ]);
  assert.equal(stats.deadline_penalized_mean_ms, 60500);
  assert.equal(stats.success_p50_ms, 1000);
  assert.equal(stats.passed, 1);
});

test('late completion and malformed timing are rejected', () => {
  assert.throws(() => summarize([{ passed: true, elapsed_ms: 120001, deadline_seconds: 120 }]));
  assert.throws(() => summarize([{ passed: false, elapsed_ms: -1, deadline_seconds: 120 }]));
});

test('public data retains model failures and exact overlap arithmetic', () => {
  const data = JSON.parse(readFileSync(new URL('../docs/benchmarks/pilot-2026-10-04.json', import.meta.url), 'utf8'));
  const result = report(data);
  assert.equal(data.episodes.length, 65);
  assert.equal(result.populations['text/gpt-6.1-sol'].passed, 9);
  for (const model of ['gpt-6-astra', 'gpt-6-luna', 'gpt-6.1-sol']) {
    assert.equal(result.populations[`vision/${model}`].passed, 2);
    assert.equal(result.populations[`vision/${model}`].episodes, 4);
  }
  assert.equal(result.exploratory_overlap.official.observed_mean_ms, 35029);
  assert.equal(result.exploratory_overlap.tabora['text/jev-latest'].observed_mean_ms, 5311);
  data.episodes.push(data.episodes[0]);
  assert.throws(() => report(data), /Duplicate/);
});
