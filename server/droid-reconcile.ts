import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { TurnRecord } from "../shared/ledger.ts";
import type { Observation } from "../shared/aggregate.ts";

/**
 * Factory Droid usage reconciliation.
 *
 * Droid's ACP transport (`droid exec --output-format acp-daemon`) reports no
 * usage at all: the prompt response carries only `stopReason` (probed
 * 2026-10-08, @factory/cli 0.235.0: `{ stopReason: "end_turn" }`) and no
 * `usage_update` session updates are emitted, so Paseo's ACP adapter has
 * nothing to forward and every factory-droid turn would settle as
 * `source: "none"` / `quality: "unavailable"`.
 *
 * Droid does, however, persist a session-cumulative `tokenUsage` to
 * `~/.factory/sessions/<workspace-slug>/<sessionId>.settings.json` on every
 * turn. The ledger record already carries the provider `sessionId`, so a
 * closed turn's exact usage is the delta between the cumulative snapshot read
 * now and the previous one. The baseline lives in the tracker's
 * `state.lastObservation`, which is never otherwise populated for this
 * provider (no usage ever arrives over ACP).
 *
 * Known omission: Droid also reports `thinkingTokens`, which has no ledger
 * field; those tokens stay uncounted here rather than being folded into a
 * wrong column. Cost is left to the read-time estimator (pricing.ts) so the
 * cost source stays honest — this module only fills token facts.
 */

export const DROID_RECONCILE_SOURCE = "droid_settings_reconcile";

export type DroidCumulative = {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
};

/** Mirrors the sync parser's environment overrides for the sessions root. */
function droidSessionsRoots(): string[] {
  const env = process.env;
  if (typeof env.DROID_SESSIONS_DIR === "string" && env.DROID_SESSIONS_DIR.trim()) {
    return env.DROID_SESSIONS_DIR.split(",").map((dir) => dir.trim()).filter(Boolean);
  }
  if (typeof env.FACTORY_DIR === "string" && env.FACTORY_DIR.trim()) {
    return [path.join(env.FACTORY_DIR.trim(), "sessions")];
  }
  return [path.join(homedir(), ".factory", "sessions")];
}

// The sessions root is scanned once per reconciled turn; cache the
// sessionId → settings.json map briefly so a burst of closing turns costs
// one walk. Only the map is cached — file contents are always read fresh.
let scanCache: { at: number; map: Map<string, string> } | null = null;
const SCAN_CACHE_TTL_MS = 5000;

function scanDroidSettingsFiles(): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".settings.json")) {
        const sessionId = entry.name.slice(0, -".settings.json".length);
        // The same session id can appear under more than one workspace slug;
        // first hit wins (any copy carries the same cumulative totals).
        if (!map.has(sessionId)) map.set(sessionId, full);
      }
    }
  };
  for (const root of droidSessionsRoots()) walk(root);
  return map;
}

/** Reads the session-cumulative tokenUsage, or null when unavailable. */
export function readDroidCumulative(sessionId: string | null | undefined): DroidCumulative | null {
  if (typeof sessionId !== "string" || sessionId.length < 8) return null;
  const now = Date.now();
  if (!scanCache || now - scanCache.at > SCAN_CACHE_TTL_MS) {
    scanCache = { at: now, map: scanDroidSettingsFiles() };
  }
  // The sessionId is only ever used as a map key resolved from the directory
  // scan — never concatenated into a path — so a hostile ledger value cannot
  // escape the sessions root.
  const file = scanCache.map.get(sessionId);
  if (!file) return null;
  try {
    const settings = JSON.parse(readFileSync(file, "utf8"));
    const usage = settings && typeof settings === "object" ? settings.tokenUsage : null;
    if (!usage || typeof usage !== "object") return null;
    const count = (value: unknown): number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
    return {
      input: count(usage.inputTokens),
      cached: count(usage.cacheReadTokens),
      cacheWrite: count(usage.cacheCreationTokens),
      output: count(usage.outputTokens),
    };
  } catch {
    return null;
  }
}

function totalOf(cumulative: DroidCumulative): number {
  return cumulative.input + cumulative.cached + cumulative.cacheWrite + cumulative.output;
}

/**
 * Fills a closed factory-droid record's token totals from the cumulative
 * settings snapshot. Returns the baseline the tracker should store going
 * forward (the fresh cumulative), or the unchanged input baseline when
 * nothing was reconciled. Mutates `record` in place — it is still queued and
 * journal-write-ahead makes a crash-retry safe (re-enrichment is skipped by
 * source, and an un-enriched retry against the old baseline yields the same
 * delta).
 */
export function reconcileDroidRecord(
  record: TurnRecord,
  baseline: Observation | null,
  cumulative: DroidCumulative | null = readDroidCumulative(record.sessionId),
): Observation | null {
  if (record.source === DROID_RECONCILE_SOURCE) return baseline;
  if (record.provider !== "factory-droid") return baseline;
  if (!record.sessionId) return baseline;
  // Usage arrived through another channel; never second-guess it.
  if (record.input !== null || record.cached !== null || record.output !== null) return baseline;
  if (!cumulative) return baseline;

  const baseTotal = baseline
    ? (baseline.input ?? 0) + (baseline.cached ?? 0) + (baseline.cacheWrite ?? 0) + (baseline.output ?? 0)
    : 0;
  const current = totalOf(cumulative);
  // Droid rewrites tokenUsage from zero when a session is reused; a shrinking
  // cumulative is that reset, so the fresh total is the turn's usage and the
  // baseline restarts from it.
  const shrank = baseline !== null && current < baseTotal;
  const delta = (value: number, previous: number | null | undefined): number =>
    Math.max(0, value - (shrank ? 0 : (previous ?? 0)));

  record.input = delta(cumulative.input, baseline?.input);
  record.cached = delta(cumulative.cached, baseline?.cached);
  record.cacheWrite = delta(cumulative.cacheWrite, baseline?.cacheWrite);
  record.output = delta(cumulative.output, baseline?.output);

  const total = totalOf({
    input: record.input,
    cached: record.cached,
    cacheWrite: record.cacheWrite,
    output: record.output,
  });
  if (total <= 0) {
    // The cumulative snapshot has not advanced since the last read — the
    // settings file likely has not flushed yet. Leave the record untouched
    // (still source "none") and keep the old baseline so the lagging usage
    // lands on the next turn instead of being lost or double-counted.
    record.input = null;
    record.cached = null;
    record.cacheWrite = undefined;
    record.output = null;
    return baseline;
  }

  record.modelCalls = Math.max(record.modelCalls, 1);
  // The delta is Droid's own session accounting, exact between two observed
  // snapshots; a delivery gap may hide intervening turns, which downgrades it.
  record.quality = record.usageGap ? "partial" : "exact";
  record.source = DROID_RECONCILE_SOURCE;
  return {
    input: cumulative.input,
    cached: cumulative.cached,
    cacheWrite: cumulative.cacheWrite,
    output: cumulative.output,
    cost: null,
  };
}
