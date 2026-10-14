import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DROID_RECONCILE_SOURCE, reconcileDroidRecord, readDroidCumulative } from './droid-reconcile.ts';
import type { TurnRecord } from '../shared/ledger.ts';
import type { Observation } from '../shared/aggregate.ts';

const endedAt = '2026-10-08T06:00:00.000Z';
const droidRecord = (overrides: Partial<TurnRecord> = {}): TurnRecord => ({
  v: 1,
  id: 'agent1:t1:' + endedAt,
  agentId: 'agent1',
  turnId: 't1',
  provider: 'factory-droid',
  model: 'glm-5.3-flash',
  sessionId: 'd7385c43-44e6-4ec5-ab5c-0a7453b8d909',
  startedAt: '2026-10-08T05:59:00.000Z',
  endedAt,
  durationMs: 1000,
  status: 'completed',
  input: null,
  cached: null,
  output: null,
  costUsd: null,
  sessionCostUsd: null,
  costScope: 'unknown',
  modelCalls: 0,
  quality: 'unavailable',
  source: 'none',
  ...overrides,
});

const cumulative = (input: number, cached: number, cacheWrite: number, output: number) => ({ input, cached, cacheWrite, output });

test('first reconciled turn takes the full cumulative snapshot', () => {
  const record = droidRecord();
  const baseline = reconcileDroidRecord(record, null, cumulative(1200, 50000, 300, 800))!;
  assert.equal(record.input, 1200);
  assert.equal(record.cached, 50000);
  assert.equal(record.cacheWrite, 300);
  assert.equal(record.output, 800);
  assert.equal(record.source, DROID_RECONCILE_SOURCE);
  assert.equal(record.quality, 'exact');
  assert.equal(record.modelCalls, 1);
  assert.equal(record.costUsd, null); // cost stays read-time estimated
  assert.deepEqual(baseline, { input: 1200, cached: 50000, cacheWrite: 300, output: 800, cost: null });
});

test('second turn bills only the delta against the baseline', () => {
  const baseline: Observation = { input: 1200, cached: 50000, cacheWrite: 300, output: 800, cost: null };
  const record = droidRecord();
  const next = reconcileDroidRecord(record, baseline, cumulative(1500, 60000, 300, 1100))!;
  assert.equal(record.input, 300);
  assert.equal(record.cached, 10000);
  assert.equal(record.cacheWrite, 0);
  assert.equal(record.output, 300);
  assert.deepEqual(next, { input: 1500, cached: 60000, cacheWrite: 300, output: 1100, cost: null });
});

test('unchanged cumulative leaves the record untouched and keeps the baseline', () => {
  const baseline: Observation = { input: 1200, cached: 50000, cacheWrite: 300, output: 800, cost: null };
  const record = droidRecord();
  const next = reconcileDroidRecord(record, baseline, cumulative(1200, 50000, 300, 800));
  assert.equal(record.source, 'none');
  assert.equal(record.quality, 'unavailable');
  assert.equal(record.input, null);
  assert.equal(next, baseline);
});

test('shrinking cumulative is a session reset and re-bills from zero', () => {
  const baseline: Observation = { input: 1200, cached: 50000, cacheWrite: 300, output: 800, cost: null };
  const record = droidRecord();
  const next = reconcileDroidRecord(record, baseline, cumulative(100, 2000, 0, 50))!;
  assert.equal(record.input, 100);
  assert.equal(record.cached, 2000);
  assert.equal(record.output, 50);
  assert.deepEqual(next, { input: 100, cached: 2000, cacheWrite: 0, output: 50, cost: null });
});

test('delivery gaps downgrade quality to partial', () => {
  const record = droidRecord({ usageGap: true });
  reconcileDroidRecord(record, null, cumulative(10, 0, 0, 5));
  assert.equal(record.quality, 'partial');
});

test('usage that arrived through another channel is never second-guessed', () => {
  const record = droidRecord({ input: 42, cached: 0, output: 7, source: 'turn_usage', quality: 'exact', modelCalls: 1 });
  const next = reconcileDroidRecord(record, null, cumulative(999, 999, 999, 999));
  assert.equal(record.input, 42);
  assert.equal(next, null);
});

test('already reconciled records are idempotent', () => {
  const baseline: Observation = { input: 1500, cached: 60000, cacheWrite: 300, output: 1100, cost: null };
  const record = droidRecord({ input: 300, cached: 10000, output: 300, source: DROID_RECONCILE_SOURCE, quality: 'exact', modelCalls: 1 });
  const next = reconcileDroidRecord(record, baseline, cumulative(9999, 9999, 9999, 9999));
  assert.equal(record.input, 300);
  assert.equal(next, baseline);
});

test('non-droid providers and missing sessions pass through', () => {
  const codex = droidRecord({ provider: 'codex' });
  assert.equal(reconcileDroidRecord(codex, null, cumulative(1, 1, 1, 1)), null);
  assert.equal(codex.source, 'none');
  const noSession = droidRecord({ sessionId: null });
  assert.equal(reconcileDroidRecord(noSession, null, cumulative(1, 1, 1, 1)), null);
  const noData = droidRecord();
  assert.equal(reconcileDroidRecord(noData, null, null), null);
  assert.equal(noData.source, 'none');
});

test('readDroidCumulative rejects short or malformed session ids', () => {
  assert.equal(readDroidCumulative(''), null);
  assert.equal(readDroidCumulative(undefined), null);
});
