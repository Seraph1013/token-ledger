import assert from "node:assert/strict";
import { test } from "node:test";
import { freshInput, usageSemantics } from "./semantics.ts";

test("semantics lookup matches provider first, then model, else null", () => {
  assert.deepEqual(usageSemantics("claude-tokenrouter", null), { inputIncludesCached: false });
  assert.deepEqual(usageSemantics("codex-tokenrouter", null), { inputIncludesCached: true });
  assert.deepEqual(usageSemantics(null, "gpt-5.6-sol"), { inputIncludesCached: true });
  assert.deepEqual(usageSemantics("some-router", "claude-fable-5"), { inputIncludesCached: false });
  assert.equal(usageSemantics("mystery-provider", "mystery-model"), null);
  assert.equal(usageSemantics(null, null), null);
});

test("freshInput subtracts cache reads for inclusive-input providers", () => {
  const codex = usageSemantics("codex-tokenrouter", null);
  // Real gpt-5.6-sol turn: inputTokens counts the whole prompt, cache hits included.
  assert.equal(freshInput(codex, 213818, 213252), 566);
  assert.equal(freshInput(codex, 100, null), 100);
  assert.equal(freshInput(codex, null, 5000), null);
  // Clamped rather than negative if a provider ever over-reports cache reads.
  assert.equal(freshInput(codex, 100, 150), 0);
});

test("freshInput passes through for exclusive-input and unknown providers", () => {
  const claude = usageSemantics("claude-tokenrouter", null);
  assert.equal(freshInput(claude, 78, 2_974_078), 78);
  assert.equal(freshInput(null, 78, 2_974_078), 78);
  assert.equal(freshInput(null, null, null), null);
});

test('cache writes are separate from fresh input only for inclusive providers', () => {
  assert.equal(freshInput(usageSemantics('codex', null), 100, 60, 30), 10);
  assert.equal(freshInput(usageSemantics('claude', null), 10, 60, 30), 10);
  assert.equal(freshInput(null, 100, 60, 30), 100);
});

test('factory-droid reports fresh input separate from cache reads (verified 2026-10-08)', () => {
  // Two same-session ACP turns of droid exec: turn 2 delta was input 387,
  // cached 10539 — Anthropic-style, cache reads never inside input.
  assert.deepEqual(usageSemantics('factory-droid', 'gpt-6.1-sol'), { inputIncludesCached: false });
  const droid = usageSemantics('factory-droid', null);
  assert.equal(freshInput(droid, 387, 10539, 0), 387);
  assert.equal(freshInput(droid, 10542, null, null), 10542);
});
