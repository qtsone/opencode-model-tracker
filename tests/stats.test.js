// model-tracker/tests/stats.test.js
import { strict as assert } from "assert";
import { test } from "node:test";
import {
  buildBillableRuns,
  estimateRecordCostUsd,
} from "../src/ledger.js";
import {
  applyFilters,
  computeFilterOptions,
  computeStats,
  computePerAgentModelStats,
  computeSessionStats,
  buildStatsResponse,
  buildParentSessionDashboardRows,
  buildParentSessionChildren,
  buildRequestRowsForSession,
  buildAgentDashboardRows,
  buildAgentModelRows,
  buildAgentModelSessionRows,
  buildDashboardChildRows,
} from "../src/stats.js";

const RECORDS = [
  {
    agent: "backend-engineer",
    session_id: "s1",
    model_id: "github-copilot/claude-sonnet-4.6",
    duration_ms: 30000,
    cost_usd: 0.0,
    timestamp: "2026-04-27T10:00:00Z",
    scores: { composite: 0.8, effective_quality: 4 },
  },
  {
    agent: "qa",
    session_id: "s2",
    model_id: "github-copilot/claude-sonnet-4.6",
    duration_ms: 20000,
    cost_usd: 0.0,
    timestamp: "2026-04-27T11:00:00Z",
    scores: { composite: 0.7, effective_quality: 3 },
  },
  {
    agent: "backend-engineer",
    session_id: "s1",
    model_id: "openai/gpt-5.3-codex",
    duration_ms: 15000,
    cost_usd: 0.0,
    timestamp: "2026-04-27T09:00:00Z",
    scores: { composite: 0.65, effective_quality: 3 },
  },
];

const REGISTRY = {
  models: {
    "github-copilot/claude-sonnet-4.6": {
      cost: { input_per_1m: "free", output_per_1m: "free" },
    },
    "openai/gpt-5.3-codex": {
      cost: { input_per_1m: 2, cache_read_per_1m: 0.2, cache_write_per_1m: 2, output_per_1m: 30 },
    },
  },
};

test("applyFilters: no filters returns all records", () => {
  assert.equal(applyFilters(RECORDS, null, null, null).length, 3);
});

test("applyFilters: agent filter works", () => {
  const r = applyFilters(RECORDS, "qa", null, null);
  assert.equal(r.length, 1);
  assert.equal(r[0].agent, "qa");
});

test("applyFilters: model_id filter works", () => {
  const r = applyFilters(RECORDS, null, null, "openai/gpt-5.3-codex");
  assert.equal(r.length, 1);
});

test("computeFilterOptions returns sorted unique values", () => {
  const opts = computeFilterOptions(RECORDS);
  assert.deepStrictEqual(opts.agents, ["backend-engineer", "qa"]);
  assert.ok(opts.model_ids.includes("openai/gpt-5.3-codex"));
});

test("computeStats returns correct total and averages", () => {
  const stats = computeStats(RECORDS);
  assert.equal(stats.total_records, 3);
  assert.ok(typeof stats.avg_duration_ms === "number");
  assert.equal(stats.total_cost_usd, 0.0);
  assert.ok(Array.isArray(stats.top_agents));
  assert.ok(Array.isArray(stats.top_models));
  assert.ok(Array.isArray(stats.recent_records));
});

test("computeStats with empty records returns zero totals", () => {
  const stats = computeStats([]);
  assert.equal(stats.total_records, 0);
  assert.equal(stats.avg_duration_ms, null);
});

test("computePerAgentModelStats groups correctly", () => {
  const rows = computePerAgentModelStats(RECORDS);
  assert.equal(rows.length, 3); // (backend-engineer,claude), (qa,claude), (backend-engineer,gpt)
  const beRow = rows.find(r => r.agent === "backend-engineer" && r.model_id === "github-copilot/claude-sonnet-4.6");
  assert.ok(beRow);
  assert.equal(beRow.runs, 1);
});

test("computePerAgentModelStats sorts by avg_composite desc by default", () => {
  const rows = computePerAgentModelStats(RECORDS, "avg_composite", "desc");
  assert.ok(rows[0].avg_composite >= rows[rows.length - 1].avg_composite);
});

test("buildStatsResponse returns full response object", () => {
  const resp = buildStatsResponse(RECORDS, {}, REGISTRY);
  assert.ok(resp.total_records >= 0);
  assert.ok(resp.filter_options);
  assert.ok(resp.per_agent_model_stats);
  assert.ok(resp.per_session_stats);
  assert.ok(resp.filters_applied);
  assert.ok(resp.last_updated);
});

test("estimateRecordCostUsd uses per-1M registry rates", () => {
  const record = {
    model_id: "openai/gpt-5.3-codex",
    tokens: { input: 1000, cache_read: 2000, cache_write: 3000, output: 4000 },
    cost_usd: 0,
  };
  const cost = estimateRecordCostUsd(record, REGISTRY);
  assert.equal(cost, 0.1284);
});

test("estimateRecordCostUsd resolves provider-prefixed registry key from short model_id + provider_id", () => {
  const record = {
    model_id: "gpt-5.3-codex",
    provider_id: "openai",
    tokens: { input: 1000, cache_read: 2000, cache_write: 3000, output: 4000 },
    cost_usd: 0,
  };
  const cost = estimateRecordCostUsd(record, REGISTRY);
  assert.equal(cost, 0.1284);
});

test("estimateRecordCostUsd defaults cache_read_per_1m to 10% of input_per_1m when missing", () => {
  const registry = {
    models: {
      "openai/test-default-cache-read": {
        cost: { input_per_1m: 2, output_per_1m: 0 },
      },
    },
  };
  const record = {
    model_id: "openai/test-default-cache-read",
    tokens: { input: 0, cache_read: 1_000_000, cache_write: 0, output: 0 },
  };

  const cost = estimateRecordCostUsd(record, registry);
  assert.equal(cost, 0.2);
});

test("estimateRecordCostUsd defaults cache_write_per_1m to input_per_1m when missing", () => {
  const registry = {
    models: {
      "openai/test-default-cache-write": {
        cost: { input_per_1m: 5, cache_read_per_1m: 0.5, output_per_1m: 0 },
      },
    },
  };
  const record = {
    model_id: "openai/test-default-cache-write",
    tokens: { input: 0, cache_read: 1_000_000, cache_write: 1_000_000, output: 0 },
  };

  const cost = estimateRecordCostUsd(record, registry);
  assert.equal(cost, 5.5);
});

test("computeStats falls back to estimated cost when reported cost is zero", () => {
  const records = [
    {
      agent: "main",
      source: "main",
      session_id: "s1",
      model_id: "openai/gpt-5.3-codex",
      duration_ms: 1000,
      cost_usd: 0,
      timestamp: "2026-04-27T12:00:00Z",
      tokens: { input: 1000, cache_read: 0, cache_write: 0, output: 1000 },
      scores: { composite: 0.5, effective_quality: 4 },
    },
  ];
  const stats = computeStats(records, REGISTRY);
  assert.equal(stats.total_cost_usd, 0.032);
  assert.equal(stats.recent_records[0].estimated_cost_usd, 0.032);
  assert.equal(stats.recent_records[0].effective_cost_usd, 0.032);
});

test("computeSessionStats groups total cost and source counts per session", () => {
  const records = [
    {
      agent: "main",
      source: "main",
      session_id: "s1",
      model_id: "openai/gpt-5.3-codex",
      duration_ms: 1000,
      cost_usd: 0,
      timestamp: "2026-04-27T12:00:00Z",
      tokens: { input: 1000, cache_read: 0, cache_write: 0, output: 1000 },
    },
    {
      agent: "backend-engineer",
      source: "subagent",
      session_id: "s1",
      model_id: "openai/gpt-5.3-codex",
      duration_ms: 2000,
      cost_usd: 0,
      timestamp: "2026-04-27T12:01:00Z",
      tokens: { input: 0, cache_read: 0, cache_write: 0, output: 1000 },
    },
  ];
  const rows = computeSessionStats(records, REGISTRY);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_id, "s1");
  assert.equal(rows[0].runs, 2);
  assert.equal(rows[0].main_runs, 1);
  assert.equal(rows[0].subagent_runs, 1);
  assert.equal(rows[0].total_cost_usd, 0.062);
});

test("computeStats returns aggregate token totals and recent record tokens", () => {
  const records = [
    {
      agent: "main",
      source: "main",
      session_id: "s-token-1",
      model_id: "openai/gpt-5.3-codex",
      duration_ms: 1000,
      cost_usd: 0,
      timestamp: "2026-04-27T12:00:00Z",
      tokens: { input: 100, cache_read: 20, cache_write: 30, output: 40, effective_input: 150 },
      scores: { composite: 0.5, effective_quality: 4 },
    },
    {
      agent: "qa",
      source: "subagent",
      session_id: "s-token-2",
      model_id: "openai/gpt-5.3-codex",
      duration_ms: 2000,
      cost_usd: 0,
      timestamp: "2026-04-27T12:01:00Z",
      tokens: { input: 10, cache_read: 2, cache_write: 3, output: 4 },
      scores: { composite: 0.6, effective_quality: 5 },
    },
  ];

  const stats = computeStats(records, REGISTRY);
  assert.deepEqual(stats.tokens, {
    input_tokens: 110,
    output_tokens: 44,
    cache_read_tokens: 22,
    cache_write_tokens: 33,
    effective_input_tokens: 165,
    total_tokens: 209,
  });
  assert.equal(stats.recent_records[0].input_tokens, 10);
  assert.equal(stats.recent_records[0].effective_input_tokens, 15);
  assert.equal(stats.recent_records[0].total_tokens, 19);
});

test("computeStats treats missing token values as zero", () => {
  const stats = computeStats([{ agent: "main", model_id: "m", timestamp: "2026-04-27T12:00:00Z" }]);
  assert.deepEqual(stats.tokens, {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    effective_input_tokens: 0,
    total_tokens: 0,
  });
});

test("per-agent/model and per-session stats include token totals", () => {
  const records = [
    {
      agent: "backend-engineer",
      source: "subagent",
      session_id: "s-token-group",
      model_id: "openai/gpt-5.3-codex",
      timestamp: "2026-04-27T12:00:00Z",
      duration_ms: 1000,
      tokens: { input: 1000, cache_read: 100, cache_write: 50, output: 500 },
      scores: { composite: 0.5, effective_quality: 4 },
    },
    {
      agent: "backend-engineer",
      source: "subagent",
      session_id: "s-token-group",
      model_id: "openai/gpt-5.3-codex",
      timestamp: "2026-04-27T12:01:00Z",
      duration_ms: 2000,
      tokens: { input: 2000, cache_read: 200, cache_write: 100, output: 700, effective_input: 2300 },
      scores: { composite: 0.6, effective_quality: 5 },
    },
  ];

  const pam = computePerAgentModelStats(records, "avg_composite", "desc", REGISTRY);
  assert.equal(pam[0].input_tokens, 3000);
  assert.equal(pam[0].effective_input_tokens, 3450);
  assert.equal(pam[0].total_tokens, 4650);

  const sessions = computeSessionStats(records, REGISTRY);
  assert.equal(sessions[0].input_tokens, 3000);
  assert.equal(sessions[0].effective_input_tokens, 3450);
  assert.equal(sessions[0].total_tokens, 4650);
});

test("buildStatsResponse dedupes shared telemetry/message tokens while preserving attributed totals", () => {
  const records = [
    {
      agent: "main",
      source: "main",
      session_id: "child-session",
      telemetry_session_id: "telemetry-shared-1",
      message_id: "message-shared-1",
      model_id: "openai/gpt-5.3-codex",
      timestamp: "2026-04-27T13:00:00Z",
      duration_ms: 1200,
      tokens: { input: 100, cache_read: 10, cache_write: 10, output: 50 },
      scores: { composite: 0.7, effective_quality: 5 },
    },
    {
      agent: "backend-engineer",
      source: "subagent",
      session_id: "parent-session",
      telemetry_session_id: "telemetry-shared-1",
      message_id: "message-shared-1",
      model_id: "openai/gpt-5.3-codex",
      timestamp: "2026-04-27T13:00:01Z",
      duration_ms: 1300,
      tokens: { input: 100, cache_read: 10, cache_write: 10, output: 50 },
      scores: { composite: 0.6, effective_quality: 4 },
    },
    {
      agent: "backend-engineer",
      source: "subagent",
      session_id: "parent-session",
      telemetry_session_id: "telemetry-parent-only-1",
      message_id: "message-parent-only-1",
      model_id: "openai/gpt-5.3-codex",
      timestamp: "2026-04-27T13:00:02Z",
      duration_ms: 1400,
      tokens: { input: 10, cache_read: 0, cache_write: 0, output: 5 },
      scores: { composite: 0.5, effective_quality: 4 },
    },
  ];

  const resp = buildStatsResponse(records, {}, REGISTRY);

  assert.equal(resp.tokens.total_tokens, 185);
  assert.equal(resp.attributed_tokens.total_tokens, 355);

  const childSession = resp.per_session_stats.find(row => row.session_id === "child-session");
  const parentSession = resp.per_session_stats.find(row => row.session_id === "parent-session");

  assert.ok(childSession);
  assert.ok(parentSession);

  assert.equal(childSession.total_tokens, 170);
  assert.equal(childSession.attributed_total_tokens, 170);

  assert.equal(parentSession.total_tokens, 15);
  assert.equal(parentSession.attributed_total_tokens, 185);
});

// ---------------------------------------------------------------------------
// Parent-grouped session aggregation tests (Slice 2)
// Bridge record structure:
//   - subagent rows: session_id = parent_session, telemetry_session_id = child_session
//   - child main rows: session_id = child_session, telemetry_session_id = child_session
// Derived map: child telemetry_session_id -> parent session_id
// ---------------------------------------------------------------------------

const BRIDGE_RECORDS = [
  // Parent main row (the orchestrator itself ran in parent session)
  {
    agent: "technical-lead",
    source: "main",
    session_id: "parent-sess",
    telemetry_session_id: "parent-sess",
    message_id: "msg-parent-1",
    model_id: "openai/gpt-5.3-codex",
    timestamp: "2026-04-27T12:00:00Z",
    duration_ms: 1000,
    cost_usd: 0,
    tokens: { input: 10, cache_read: 0, cache_write: 0, output: 5 },
  },
  // Subagent bridge row: parent session dispatched child-sess
  {
    agent: "backend-engineer",
    source: "subagent",
    session_id: "parent-sess",
    telemetry_session_id: "child-sess",
    message_id: "msg-bridge-1",
    model_id: "openai/gpt-5.3-codex",
    timestamp: "2026-04-27T12:01:00Z",
    duration_ms: 2000,
    cost_usd: 0,
    tokens: { input: 100, cache_read: 0, cache_write: 0, output: 50 },
  },
  // Child main row (same logical message as bridge row — shared telemetry)
  {
    agent: "backend-engineer",
    source: "main",
    session_id: "child-sess",
    telemetry_session_id: "child-sess",
    message_id: "msg-bridge-1",
    model_id: "openai/gpt-5.3-codex",
    timestamp: "2026-04-27T12:01:01Z",
    duration_ms: 1800,
    cost_usd: 0,
    tokens: { input: 100, cache_read: 0, cache_write: 0, output: 50 },
  },
  // Another child-only unique row
  {
    agent: "backend-engineer",
    source: "main",
    session_id: "child-sess",
    telemetry_session_id: "child-sess",
    message_id: "msg-child-2",
    model_id: "openai/gpt-5.3-codex",
    timestamp: "2026-04-27T12:02:00Z",
    duration_ms: 800,
    cost_usd: 0,
    tokens: { input: 20, cache_read: 0, cache_write: 0, output: 10 },
  },
  // Unmapped child session (no bridge row in this dataset)
  {
    agent: "qa",
    source: "main",
    session_id: "orphan-sess",
    telemetry_session_id: "orphan-sess",
    message_id: "msg-orphan-1",
    model_id: "openai/gpt-5.3-codex",
    timestamp: "2026-04-27T12:03:00Z",
    duration_ms: 500,
    cost_usd: 0,
    tokens: { input: 5, cache_read: 0, cache_write: 0, output: 3 },
  },
];

test("computeSessionStats raw mode returns separate parent and child sessions for bridge data", () => {
  // Default (raw) mode must preserve current grouping by session_id.
  // parent-sess, child-sess, orphan-sess all appear separately.
  const rows = computeSessionStats(BRIDGE_RECORDS, REGISTRY);
  const ids = rows.map(r => r.session_id);
  assert.ok(ids.includes("parent-sess"), "parent-sess must appear in raw mode");
  assert.ok(ids.includes("child-sess"), "child-sess must appear in raw mode");
  assert.ok(ids.includes("orphan-sess"), "orphan-sess must appear in raw mode");
  assert.equal(rows.length, 3, "raw mode must return 3 separate session rows");
});

test("computeSessionStats parent mode merges child activity under parent session", () => {
  // parent mode: child-sess is mapped to parent-sess, so child main rows appear under parent-sess.
  const rows = computeSessionStats(BRIDGE_RECORDS, REGISTRY, { groupSessionBy: "parent" });
  const parentRow = rows.find(r => r.session_id === "parent-sess");
  // child-sess should not appear as a separate session
  const childRow = rows.find(r => r.session_id === "child-sess");
  assert.ok(parentRow, "parent-sess must appear in parent mode");
  assert.equal(childRow, undefined, "child-sess must NOT appear as separate session in parent mode");
  // parent row should include activity from child
  assert.ok(parentRow.runs > 1, "parent session runs must include child activity");
});

test("computeSessionStats parent mode leaves unmapped sessions separate", () => {
  const rows = computeSessionStats(BRIDGE_RECORDS, REGISTRY, { groupSessionBy: "parent" });
  const orphanRow = rows.find(r => r.session_id === "orphan-sess");
  assert.ok(orphanRow, "orphan-sess with no parent mapping must remain as a separate session");
});

test("computeSessionStats parent mode does not double-count shared main/subagent logical messages", () => {
  // msg-bridge-1 appears as source:subagent in parent-sess and source:main in child-sess.
  // canonical dedupe should count that logical record once.
  // parent-sess unique token total: msg-parent-1(15) + msg-bridge-1(150) + msg-child-2(30) = 195 total tokens
  // subagent bridge row for msg-bridge-1 should not add a second count.
  const rows = computeSessionStats(BRIDGE_RECORDS, REGISTRY, { groupSessionBy: "parent" });
  const parentRow = rows.find(r => r.session_id === "parent-sess");
  assert.ok(parentRow, "parent-sess must exist");
  // The canonical unique record for msg-bridge-1 is the main row (priority over subagent).
  // unique tokens = msg-parent-1 (10+5=15) + msg-bridge-1 main (100+50=150) + msg-child-2 (20+10=30) = 195
  assert.equal(parentRow.total_tokens, 195, "parent session must not double-count shared logical message tokens");
});

// ---------------------------------------------------------------------------
// Per-session pagination tests (Slice 3)
// ---------------------------------------------------------------------------

function makeSessionRecords(count) {
  var records = [];
  for (var i = 0; i < count; i++) {
    records.push({
      agent: "agent-" + i,
      source: "main",
      session_id: "sess-" + String(i).padStart(4, "0"),
      model_id: "openai/gpt-5.3-codex",
      timestamp: "2026-04-27T10:" + String(i % 60).padStart(2, "0") + ":00Z",
      duration_ms: 1000 + i * 10,
      cost_usd: 0,
      tokens: { input: 100 + i, cache_read: 0, cache_write: 0, output: 50 + i },
    });
  }
  return records;
}

test("buildStatsResponse returns per_session_pagination metadata on default page", () => {
  const records = makeSessionRecords(120);
  const resp = buildStatsResponse(records, {}, null);
  assert.ok(resp.per_session_pagination, "per_session_pagination must be present");
  const pag = resp.per_session_pagination;
  assert.equal(pag.page, 1, "default page is 1");
  assert.equal(pag.page_size, 50, "default page_size is 50");
  assert.equal(pag.total_sessions, 120, "total_sessions reflects all sessions after filtering");
  assert.equal(pag.total_pages, 3, "ceil(120/50) = 3");
  assert.equal(pag.has_previous, false, "page 1 has no previous");
  assert.equal(pag.has_next, true, "page 1 has next when more pages exist");
});

test("buildStatsResponse returns only page rows in per_session_stats", () => {
  const records = makeSessionRecords(120);
  const resp = buildStatsResponse(records, {}, null);
  assert.equal(resp.per_session_stats.length, 50, "page 1 must have exactly 50 rows");
});

test("buildStatsResponse page 2 returns correct slice and pagination metadata", () => {
  const records = makeSessionRecords(120);
  const resp = buildStatsResponse(records, { session_page: 2, session_page_size: 50 }, null);
  const pag = resp.per_session_pagination;
  assert.equal(pag.page, 2);
  assert.equal(pag.has_previous, true);
  assert.equal(pag.has_next, true);
  assert.equal(resp.per_session_stats.length, 50);
});

test("buildStatsResponse last page returns partial rows and has_next=false", () => {
  const records = makeSessionRecords(120);
  const resp = buildStatsResponse(records, { session_page: 3, session_page_size: 50 }, null);
  const pag = resp.per_session_pagination;
  assert.equal(pag.page, 3);
  assert.equal(pag.has_next, false);
  assert.equal(pag.has_previous, true);
  assert.equal(resp.per_session_stats.length, 20, "last page has remainder rows (120 - 2*50 = 20)");
});

test("buildStatsResponse pagination is deterministic: page 1 and page 2 rows do not overlap", () => {
  const records = makeSessionRecords(120);
  const page1 = buildStatsResponse(records, { session_page: 1, session_page_size: 50 }, null);
  const page2 = buildStatsResponse(records, { session_page: 2, session_page_size: 50 }, null);
  const ids1 = new Set(page1.per_session_stats.map(r => r.session_id));
  const ids2 = new Set(page2.per_session_stats.map(r => r.session_id));
  for (const id of ids2) {
    assert.ok(!ids1.has(id), `session_id ${id} appears on both page 1 and page 2`);
  }
});

test("buildStatsResponse normalizes session_page_size at maximum 200", () => {
  const records = makeSessionRecords(10);
  const resp = buildStatsResponse(records, { session_page: 1, session_page_size: 9999 }, null);
  assert.equal(resp.per_session_pagination.page_size, 200);
});

test("buildStatsResponse normalizes session_page_size below 1 to 1", () => {
  const records = makeSessionRecords(10);
  const resp = buildStatsResponse(records, { session_page: 1, session_page_size: 0 }, null);
  assert.ok(resp.per_session_pagination.page_size >= 1, "page_size must be at least 1");
});

test("buildStatsResponse out-of-range page clamps to last page", () => {
  const records = makeSessionRecords(10);
  const resp = buildStatsResponse(records, { session_page: 999, session_page_size: 50 }, null);
  const pag = resp.per_session_pagination;
  assert.equal(pag.page, 1, "out-of-range page clamps to page 1 (only 1 page exists)");
  assert.equal(resp.per_session_stats.length, 10);
});

test("buildStatsResponse filters_applied includes normalized session_page and session_page_size", () => {
  const records = makeSessionRecords(5);
  const resp = buildStatsResponse(records, { session_page: 2, session_page_size: 25 }, null);
  assert.equal(resp.filters_applied.session_page, 1, "clamped page (only 1 page for 5 sessions/25 page_size)");
  assert.equal(resp.filters_applied.session_page_size, 25);
  assert.equal(resp.filters_applied.group_session_by, "raw");
});

test("buildStatsResponse with group_session_by=parent includes normalized value in filters_applied", () => {
  const records = makeSessionRecords(5);
  const resp = buildStatsResponse(records, { group_session_by: "parent" }, null);
  assert.equal(resp.filters_applied.group_session_by, "parent");
});

test("computeSessionStats parent mode attributed_total_tokens equals sum of attributed token totals", () => {
  // Asserts that parent-mode attributed groups are intentionally not deduped
  // (all raw records contribute to attributed totals within the merged bucket).
  const rows = computeSessionStats(BRIDGE_RECORDS, REGISTRY, { groupSessionBy: "parent" });
  const parentRow = rows.find(r => r.session_id === "parent-sess");
  assert.ok(parentRow, "parent-sess must exist");
  // attributed_total_tokens = sum of all raw records in the bucket (not deduped)
  // parent-sess attributed bucket: parent-main(15) + bridge-subagent(150) + child-main(150) + child-2(30) = 345
  assert.ok(
    typeof parentRow.attributed_total_tokens === "number",
    "attributed_total_tokens must be a number in parent mode"
  );
  assert.ok(parentRow.attributed_total_tokens > 0, "parent attributed_total_tokens must be positive");
});

// ─── Issue 2: group_session_by normalization ──────────────────────────────────

test("buildStatsResponse normalizes invalid group_session_by to 'raw'", () => {
  const records = makeSessionRecords(3);
  const resp = buildStatsResponse(records, { group_session_by: "garbage" }, null);
  assert.equal(
    resp.filters_applied.group_session_by,
    "raw",
    `'garbage' must normalize to 'raw', got '${resp.filters_applied.group_session_by}'`
  );
});

test("buildStatsResponse normalizes empty string group_session_by to 'raw'", () => {
  const records = makeSessionRecords(3);
  const resp = buildStatsResponse(records, { group_session_by: "" }, null);
  assert.equal(resp.filters_applied.group_session_by, "raw");
});

test("buildStatsResponse accepts 'raw' group_session_by unchanged", () => {
  const records = makeSessionRecords(3);
  const resp = buildStatsResponse(records, { group_session_by: "raw" }, null);
  assert.equal(resp.filters_applied.group_session_by, "raw");
});

test("buildStatsResponse accepts 'parent' group_session_by unchanged", () => {
  const records = makeSessionRecords(3);
  const resp = buildStatsResponse(records, { group_session_by: "parent" }, null);
  assert.equal(resp.filters_applied.group_session_by, "parent");
});

// ---------------------------------------------------------------------------
// Task 1: buildBillableRuns — canonical run ledger and cost buckets
// ---------------------------------------------------------------------------

test("buildBillableRuns dedupes bridge and child main records by provider/model/session/message", () => {
  const records = [
    {
      id: "parent:call-1",
      agent: "backend-engineer",
      source: "subagent",
      session_id: "parent-session",
      telemetry_session_id: "child-session",
      message_id: "msg-child-1",
      provider_id: "openai",
      model_id: "gpt-5.3-codex",
      timestamp: "2026-05-02T10:00:00Z",
      cost_usd: 0,
      tokens: { input: 1000, cache_read: 2000, cache_write: 3000, output: 4000 },
      scores: { composite: 0.4, effective_quality: 4 },
    },
    {
      id: "child:msg-child-1",
      agent: "backend-engineer",
      source: "main",
      session_id: "child-session",
      telemetry_session_id: "child-session",
      message_id: "msg-child-1",
      provider_id: "openai",
      model_id: "gpt-5.3-codex",
      timestamp: "2026-05-02T10:00:01Z",
      cost_usd: 0,
      tokens: { input: 1000, cache_read: 2000, cache_write: 3000, output: 4000 },
      scores: { composite: 0.7, effective_quality: 5 },
    },
  ];

  const runs = buildBillableRuns(records, REGISTRY);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].canonical_record.source, "main");
  assert.equal(runs[0].raw_record_count, 2);
  assert.equal(runs[0].bridge_record_count, 1);
  assert.equal(runs[0].fresh_input_tokens, 1000);
  assert.equal(runs[0].cached_input_tokens, 2000);
  assert.equal(runs[0].cache_write_tokens, 3000);
  assert.equal(runs[0].output_tokens, 4000);
  assert.equal(runs[0].total_tokens, 10000);
  assert.equal(runs[0].fresh_input_cost_usd, 0.002);
  assert.equal(runs[0].cached_input_cost_usd, 0.0004);
  assert.equal(runs[0].cache_write_cost_usd, 0.006);
  assert.equal(runs[0].output_cost_usd, 0.12);
  assert.equal(runs[0].total_cost_usd, 0.1284);
  assert.equal(runs[0].cost_source, "estimated");
});

test("buildBillableRuns deduplicates same session+message even when provider and model differ", () => {
  // Two main records sharing (session, message_id) collapse to one run regardless of
  // provider or model_id differences — the canonical record (first, by reduce logic)
  // supplies authoritative provider/model information.
  const records = [
    {
      id: "run-gpt",
      agent: "technical-lead",
      source: "main",
      session_id: "arena-session",
      telemetry_session_id: "arena-session",
      message_id: "msg-arena-1",
      provider_id: "openai",
      model_id: "gpt-5.3-codex",
      timestamp: "2026-05-02T10:00:00Z",
      tokens: { input: 1, cache_read: 0, cache_write: 0, output: 1 },
    },
    {
      id: "run-sonnet",
      agent: "technical-lead",
      source: "main",
      session_id: "arena-session",
      telemetry_session_id: "arena-session",
      message_id: "msg-arena-1",
      provider_id: "github-copilot",
      model_id: "claude-sonnet-4.6",
      timestamp: "2026-05-02T10:00:01Z",
      tokens: { input: 1, cache_read: 0, cache_write: 0, output: 1 },
    },
  ];

  const runs = buildBillableRuns(records, REGISTRY);
  assert.equal(runs.length, 1, "same (session, message_id) must deduplicate regardless of provider/model");
  assert.equal(runs[0].raw_record_count, 2);
});

test("billableRunKey deduplicates bridge+child records with mismatched model_id format", () => {
  // A bridge record and a child main record for the same inference call,
  // where model_id strings differ in format (e.g. dash vs dot separator).
  const records = [
    {
      id: "bridge-1",
      record_id: "bridge-1",
      source: "subagent",
      session_id: "parent-sess",
      telemetry_session_id: "child-sess",
      message_id: "msg-001",
      provider_id: "anthropic",
      model_id: "claude-sonnet-4-5",   // dash format from task metadata
      input_tokens: 100,
      output_tokens: 10,
      timestamp: "2025-01-01T00:00:00Z",
    },
    {
      id: "child-1",
      record_id: "child-1",
      source: "main",
      session_id: "child-sess",
      telemetry_session_id: "child-sess",
      message_id: "msg-001",
      provider_id: "anthropic",
      model_id: "claude-sonnet-4.5",   // dot format from message API
      input_tokens: 100,
      output_tokens: 10,
      timestamp: "2025-01-01T00:00:00Z",
    },
  ];

  const runs = buildBillableRuns(records, null);

  assert.equal(runs.length, 1, "bridge and child records with mismatched model_id must deduplicate to 1 run");
  assert.equal(runs[0].raw_record_count, 2, "deduplicated run must show raw_record_count of 2");
});

test("buildBillableRuns does not collapse unknown message ids", () => {
  const records = [
    {
      id: "unknown-1",
      agent: "qa",
      source: "main",
      session_id: "same-session",
      telemetry_session_id: "same-session",
      message_id: "unknown",
      model_id: "openai/gpt-5.3-codex",
      timestamp: "2026-05-02T10:00:00Z",
      tokens: { input: 1, cache_read: 0, cache_write: 0, output: 1 },
    },
    {
      id: "unknown-2",
      agent: "qa",
      source: "main",
      session_id: "same-session",
      telemetry_session_id: "same-session",
      message_id: "unknown",
      model_id: "openai/gpt-5.3-codex",
      timestamp: "2026-05-02T10:00:01Z",
      tokens: { input: 2, cache_read: 0, cache_write: 0, output: 2 },
    },
  ];

  assert.equal(buildBillableRuns(records, REGISTRY).length, 2);
});

test("buildBillableRuns uses positive provider cost over calculated estimate", () => {
  const records = [{
    id: "provider-cost-run",
    agent: "technical-lead",
    source: "main",
    session_id: "provider-session",
    telemetry_session_id: "provider-session",
    message_id: "msg-provider-cost",
    model_id: "openai/gpt-5.3-codex",
    cost_usd: 0.5,
    timestamp: "2026-05-02T10:00:00Z",
    tokens: { input: 1000, cache_read: 0, cache_write: 0, output: 1000 },
  }];

  const [run] = buildBillableRuns(records, REGISTRY);
  assert.equal(run.total_cost_usd, 0.5);
  assert.equal(run.cost_source, "provider");
});

test("buildStatsResponse does not collapse records with blank message identity", () => {
  const records = [
    {
      agent: "main",
      source: "main",
      session_id: "blank-message-session-1",
      telemetry_session_id: "shared-telemetry-with-blank-message",
      message_id: "",
      model_id: "openai/gpt-5.3-codex",
      timestamp: "2026-04-27T14:00:00Z",
      tokens: { input: 0, cache_read: 0, cache_write: 0, output: 1 },
      scores: { composite: 0.7, effective_quality: 5 },
    },
    {
      agent: "backend-engineer",
      source: "subagent",
      session_id: "blank-message-session-2",
      telemetry_session_id: "shared-telemetry-with-blank-message",
      message_id: "",
      model_id: "openai/gpt-5.3-codex",
      timestamp: "2026-04-27T14:00:01Z",
      tokens: { input: 0, cache_read: 0, cache_write: 0, output: 2 },
      scores: { composite: 0.6, effective_quality: 4 },
    },
  ];

  const resp = buildStatsResponse(records, {}, REGISTRY);

  assert.equal(resp.tokens.total_tokens, 3);
  assert.equal(resp.attributed_tokens.total_tokens, 3);
});

// ---------------------------------------------------------------------------
// Task 2: buildParentSessionDashboardRows, buildParentSessionChildren,
//         buildRequestRowsForSession — parent session dashboard views
// ---------------------------------------------------------------------------

test("buildParentSessionDashboardRows rolls child sessions into parent without bridge double-count", () => {
  const rows = buildParentSessionDashboardRows(BRIDGE_RECORDS, REGISTRY, { page: 1, pageSize: 50 });
  const parent = rows.rows.find(r => r.id === "parent-sess");
  assert.ok(parent, "parent-sess row must exist");
  assert.equal(parent.row_type, "parent_session");
  assert.equal(parent.child_session_count, 1);
  assert.equal(parent.run_count, 3);
  assert.equal(parent.total_tokens, 195);
  assert.equal(parent.has_children, true);
  assert.equal(parent.agent, "technical-lead");
  assert.equal(parent.model_id, "openai/gpt-5.3-codex");
  assert.equal(parent.sub_agents, undefined, "parent row must not expose sub_agents");
  assert.equal(parent.sub_models, undefined, "parent row must not expose sub_models");
  // spec-review required fields
  assert.equal(parent.label, "2026-04-27 12:00 (parent-s\u2026)", "parent row label must be human-readable with timestamp prefix");
  assert.equal(parent.id, "parent-sess", "parent row id must be the full session id");
  assert.equal(parent.session_count, 2, "parent session_count must be 1 (root) + 1 (child)");
  assert.ok(typeof parent.cost_source_summary === "string" && parent.cost_source_summary.length > 0, "parent must have truthy cost_source_summary");
});

test("buildParentSessionDashboardRows applies parent filter after run ledger construction", () => {
  const rows = buildParentSessionDashboardRows(BRIDGE_RECORDS, REGISTRY, { page: 1, pageSize: 50, parentSessionId: "parent-sess" });
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].id, "parent-sess");
  assert.equal(rows.rows[0].total_tokens, 195);
});

test("buildParentSessionChildren returns parent's own request rows followed by child session rows", () => {
  const children = buildParentSessionChildren(BRIDGE_RECORDS, REGISTRY, "parent-sess");
  // BRIDGE_RECORDS has 1 parent own message (msg-parent-1) and 1 child session (child-sess)
  assert.equal(children.length, 2, "must return 1 request row + 1 child session row");
  // First: parent's own request row
  assert.equal(children[0].row_type, "request", "first row must be the parent's own request");
  assert.equal(children[0].message_id, "msg-parent-1", "first row must be msg-parent-1");
  assert.ok(typeof children[0].label === "string" && children[0].label.length > 0, "request row must have a non-empty label");
  assert.ok(typeof children[0].cost_source_summary === "string" && children[0].cost_source_summary.length > 0, "request row must have cost_source_summary");
  // Second: child session row
  assert.equal(children[1].row_type, "child_session", "second row must be child_session");
  assert.equal(children[1].id, "child-sess", "child session id must be child-sess");
  assert.equal(children[1].label, "child-sess", "child row label must match its id");
  assert.equal(children[1].session_count, 1, "child row session_count must be 1");
  assert.ok(typeof children[1].cost_source_summary === "string", "child row must have cost_source_summary");
  assert.ok(typeof children[1].agent === "string" && children[1].agent.length > 0, "child_session row must have a non-empty agent field");
  assert.ok(typeof children[1].model_id === "string" && children[1].model_id.length > 0, "child_session row must have a non-empty model_id field");
});

test("buildRequestRowsForSession returns canonical message rows, not bridge duplicates", () => {
  const rows = buildRequestRowsForSession(BRIDGE_RECORDS, REGISTRY, { sessionId: "child-sess", parentSessionId: "parent-sess" });
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.row_type === "request"), "all rows must have row_type request");
  assert.ok(rows.some(r => r.message_id === "msg-bridge-1"), "msg-bridge-1 must appear");
  assert.ok(rows.every(r => r.bridge_record_count <= r.raw_record_count), "bridge_record_count must not exceed raw_record_count");
  // spec-review required fields
  assert.ok(rows.every(r => typeof r.label === "string" && r.label.length > 0), "every request row must have a non-empty label");
  assert.ok(rows.every(r => typeof r.cost_source_summary === "string" && r.cost_source_summary.length > 0), "every request row must have a non-empty cost_source_summary");
});

// ---------------------------------------------------------------------------
// Task 3: buildAgentDashboardRows, buildAgentModelRows, buildAgentModelSessionRows
// ---------------------------------------------------------------------------

test("buildAgentDashboardRows groups by agent and sorts agents by total cost descending", () => {
  const records = [
    {
      id: "expensive-1",
      agent: "backend-engineer",
      source: "main",
      session_id: "sess-be-1",
      telemetry_session_id: "sess-be-1",
      message_id: "msg-be-1",
      model_id: "openai/gpt-5.3-codex",
      timestamp: "2026-05-02T10:00:00Z",
      cost_usd: 0,
      tokens: { input: 1_000_000, cache_read: 0, cache_write: 0, output: 0 },
      scores: { composite: 0.8, effective_quality: 4 },
    },
    {
      id: "cheap-1",
      agent: "qa",
      source: "main",
      session_id: "sess-qa-1",
      telemetry_session_id: "sess-qa-1",
      message_id: "msg-qa-1",
      model_id: "openai/gpt-5.3-codex",
      timestamp: "2026-05-02T10:01:00Z",
      cost_usd: 0,
      tokens: { input: 1, cache_read: 0, cache_write: 0, output: 0 },
      scores: { composite: 0.5, effective_quality: 3 },
    },
  ];

  const result = buildAgentDashboardRows(records, REGISTRY, { page: 1, pageSize: 50 });
  const rows = result.rows;

  assert.ok(rows.length >= 2, "must have at least 2 agent rows");
  assert.equal(rows[0].id, "backend-engineer", "backend-engineer must be first (highest cost)");
  assert.equal(rows[0].row_type, "agent", "row_type must be 'agent'");
  assert.equal(rows[0].model_count, 1, "model_count must be 1");
  assert.equal(rows[0].label, "backend-engineer", "label must equal agent id");
  assert.deepStrictEqual(rows[0].child_query, { kind: "agent-models", agent: "backend-engineer" }, "child_query shape must match");
  assert.equal(rows[0].session_count, 1, "session_count must be 1 for single-session agent");
  assert.ok(typeof rows[0].cost_source_summary === "string" && rows[0].cost_source_summary.length > 0, "cost_source_summary must be a non-empty string");
  assert.equal(rows[0].has_children, true, "has_children must be true when child rows exist");
});

test("buildAgentModelRows sorts models by avg composite then total cost", () => {
  const records = [
    {
      id: "be-openai-1",
      agent: "backend-engineer",
      source: "main",
      session_id: "sess-be-openai",
      telemetry_session_id: "sess-be-openai",
      message_id: "msg-be-openai-1",
      model_id: "openai/gpt-5.3-codex",
      timestamp: "2026-05-02T10:00:00Z",
      cost_usd: 0,
      tokens: { input: 1000, cache_read: 0, cache_write: 0, output: 100 },
      scores: { composite: 0.5, effective_quality: 3 },
    },
    {
      id: "be-gh-1",
      agent: "backend-engineer",
      source: "main",
      session_id: "sess-be-gh",
      telemetry_session_id: "sess-be-gh",
      message_id: "msg-be-gh-1",
      model_id: "github-copilot/claude-sonnet-4.6",
      timestamp: "2026-05-02T10:01:00Z",
      cost_usd: 0,
      tokens: { input: 1, cache_read: 0, cache_write: 0, output: 0 },
      scores: { composite: 0.9, effective_quality: 5 },
    },
  ];

  const rows = buildAgentModelRows(records, REGISTRY, "backend-engineer");

  assert.ok(rows.length >= 2, "must return at least 2 model rows");
  assert.equal(rows[0].id, "github-copilot/claude-sonnet-4.6", "higher composite model must be first");
  assert.equal(rows[0].row_type, "agent_model", "row_type must be agent_model");
  assert.equal(rows[0].has_children, false, "agent model rows must not be expandable (agent table stops at model level)");
  assert.equal(rows[0].child_query, undefined, "agent model rows must not have a child_query");
});

test("buildAgentModelRows places missing composite after scored models", () => {
  const records = [
    {
      id: "qa-openai-1",
      agent: "qa",
      source: "main",
      session_id: "sess-qa-openai",
      telemetry_session_id: "sess-qa-openai",
      message_id: "msg-qa-openai-1",
      model_id: "openai/gpt-5.3-codex",
      timestamp: "2026-05-02T10:00:00Z",
      cost_usd: 0,
      tokens: { input: 500, cache_read: 0, cache_write: 0, output: 50 },
      scores: { composite: 0.7, effective_quality: 4 },
    },
    {
      id: "qa-gh-1",
      agent: "qa",
      source: "main",
      session_id: "sess-qa-gh",
      telemetry_session_id: "sess-qa-gh",
      message_id: "msg-qa-gh-1",
      model_id: "github-copilot/claude-sonnet-4.6",
      timestamp: "2026-05-02T10:01:00Z",
      cost_usd: 0,
      tokens: { input: 1, cache_read: 0, cache_write: 0, output: 0 },
      // no scores — avg_composite will be null
    },
  ];

  const rows = buildAgentModelRows(records, REGISTRY, "qa");

  assert.ok(rows.length >= 2, "must return at least 2 model rows");
  assert.equal(rows[0].id, "openai/gpt-5.3-codex", "scored model must be first");
  assert.equal(rows[1].id, "github-copilot/claude-sonnet-4.6", "unscored model must be last");
});

test("buildAgentModelSessionRows returns session rows sorted by total cost descending with correct shape", () => {
  const records = [
    {
      id: "sess-a-run-1",
      agent: "backend-engineer",
      source: "main",
      session_id: "sess-a",
      telemetry_session_id: "sess-a",
      message_id: "msg-a-1",
      model_id: "openai/gpt-5.3-codex",
      timestamp: "2026-05-02T10:00:00Z",
      cost_usd: 0,
      tokens: { input: 100_000, cache_read: 0, cache_write: 0, output: 10_000 },
      scores: { composite: 0.7, effective_quality: 4 },
    },
    {
      id: "sess-b-run-1",
      agent: "backend-engineer",
      source: "main",
      session_id: "sess-b",
      telemetry_session_id: "sess-b",
      message_id: "msg-b-1",
      model_id: "openai/gpt-5.3-codex",
      timestamp: "2026-05-02T10:01:00Z",
      cost_usd: 0,
      tokens: { input: 1, cache_read: 0, cache_write: 0, output: 0 },
      scores: { composite: 0.4, effective_quality: 2 },
    },
  ];

  const rows = buildAgentModelSessionRows(records, REGISTRY, { agent: "backend-engineer", model_id: "openai/gpt-5.3-codex" });

  assert.ok(rows.length >= 2, "must return at least 2 session rows");
  assert.ok(rows.every(r => r.row_type === "agent_model_session"), "all rows must have row_type agent_model_session");
  assert.equal(rows[0].id, "sess-a", "higher-cost session must be first");
  assert.ok(rows[0].total_cost_usd > rows[1].total_cost_usd, "rows must be sorted by total_cost_usd desc");
  assert.equal(rows[0].session_count, 1, "each session row has session_count 1");
  assert.deepStrictEqual(
    rows[0].child_query,
    { kind: "session-requests", session_id: "sess-a", parent_session_id: null },
    "child_query must have kind session-requests, correct session_id, and explicit parent_session_id null"
  );
  assert.deepStrictEqual(
    rows[1].child_query,
    { kind: "session-requests", session_id: "sess-b", parent_session_id: null }
  );
});

// ---------------------------------------------------------------------------
// Task 4: buildStatsResponse dashboard object and buildDashboardChildRows
// ---------------------------------------------------------------------------

test("buildStatsResponse exposes dashboard parent and agent top-level rows", () => {
  const resp = buildStatsResponse(BRIDGE_RECORDS, {}, REGISTRY);
  assert.ok(resp.dashboard, "dashboard must be present on response");
  assert.ok(resp.dashboard.parent_sessions, "dashboard.parent_sessions must be present");
  assert.ok(Array.isArray(resp.dashboard.parent_sessions.rows), "dashboard.parent_sessions.rows must be an array");
  assert.ok(resp.dashboard.parent_sessions.rows.length > 0, "dashboard.parent_sessions.rows must have at least one row");
  assert.ok(resp.dashboard.parent_sessions.pagination, "dashboard.parent_sessions.pagination must be present");
  assert.equal(resp.dashboard.parent_sessions.pagination.page_size, 50, "default parent page_size must be 50");
  assert.ok(resp.dashboard.agents, "dashboard.agents must be present");
  assert.ok(Array.isArray(resp.dashboard.agents.rows), "dashboard.agents.rows must be an array");
  assert.ok(resp.dashboard.agents.rows.length > 0, "dashboard.agents.rows must have at least one row");
  assert.ok(resp.dashboard.agents.pagination, "dashboard.agents.pagination must be present");
  assert.equal(resp.dashboard.agents.pagination.page_size, 50, "default agent page_size must be 50");
  assert.ok(resp.dashboard.summary, "dashboard.summary must be present");
  assert.ok(typeof resp.dashboard.summary.total_tokens === "number", "dashboard.summary.total_tokens must be a number");
  assert.ok(typeof resp.dashboard.summary.total_cost_usd === "number", "dashboard.summary.total_cost_usd must be a number");
});

test("buildBillableRuns marks free registry runs as free cost source", () => {
  const records = [{
    id: "free-run-1",
    agent: "backend-engineer",
    source: "main",
    session_id: "free-session",
    telemetry_session_id: "free-session",
    message_id: "msg-free-1",
    model_id: "github-copilot/claude-sonnet-4.6",
    timestamp: "2026-05-04T10:00:00Z",
    cost_usd: 0,
    tokens: { input: 1000, cache_read: 200, cache_write: 300, output: 400 },
  }];

  const [run] = buildBillableRuns(records, REGISTRY);

  assert.equal(run.total_cost_usd, 0);
  assert.equal(run.fresh_input_cost_usd, 0);
  assert.equal(run.cached_input_cost_usd, 0);
  assert.equal(run.cache_write_cost_usd, 0);
  assert.equal(run.output_cost_usd, 0);
  assert.equal(run.cost_source, "free");
});

test("buildRequestRowsForSession returns orphan session requests without parentSessionId", () => {
  const rows = buildRequestRowsForSession(BRIDGE_RECORDS, REGISTRY, { sessionId: "orphan-sess" });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].row_type, "request");
  assert.equal(rows[0].message_id, "msg-orphan-1");
  assert.equal(rows[0].run_id, "run:orphan-sess:::msg-orphan-1");
  assert.equal(rows[0].child_query, undefined);
});

test("buildStatsResponse dashboard pagination uses row pagination shape", () => {
  const resp = buildStatsResponse(BRIDGE_RECORDS, {}, REGISTRY);
  const expectedKeys = ["has_next", "has_previous", "page", "page_size", "total_pages", "total_rows"];

  assert.deepEqual(Object.keys(resp.dashboard.parent_sessions.pagination).sort(), expectedKeys);
  assert.deepEqual(Object.keys(resp.dashboard.agents.pagination).sort(), expectedKeys);
  assert.equal(resp.dashboard.parent_sessions.pagination.page, 1);
  assert.equal(resp.dashboard.parent_sessions.pagination.page_size, 50);
  assert.equal(resp.dashboard.parent_sessions.pagination.total_rows, 2);
  assert.equal(resp.dashboard.agents.pagination.page, 1);
  assert.equal(resp.dashboard.agents.pagination.page_size, 50);
  assert.equal(resp.dashboard.agents.pagination.total_rows, 3);
});

test("buildStatsResponse and billable run ledger agree on bridge fixture total tokens", () => {
  const resp = buildStatsResponse(BRIDGE_RECORDS, {}, REGISTRY);
  const runs = buildBillableRuns(BRIDGE_RECORDS, REGISTRY);
  const ledgerTotalTokens = runs.reduce((sum, run) => sum + run.total_tokens, 0);

  assert.equal(ledgerTotalTokens, 203);
  assert.equal(resp.tokens.total_tokens, ledgerTotalTokens);
  assert.equal(resp.dashboard.summary.total_tokens, ledgerTotalTokens);
});

test("buildStatsResponse dashboard parent filter remains dedupe-safe", () => {
  const resp = buildStatsResponse(BRIDGE_RECORDS, { parent_session_id: "parent-sess" }, REGISTRY);
  assert.ok(resp.dashboard, "dashboard must be present");
  assert.equal(resp.dashboard.parent_sessions.rows.length, 1, "parent filter must produce exactly 1 row");
  assert.equal(resp.dashboard.parent_sessions.rows[0].id, "parent-sess", "filtered row id must be parent-sess");
  assert.equal(resp.dashboard.parent_sessions.rows[0].total_tokens, 195, "total_tokens must be 195 (dedupe-safe)");
});

test("buildDashboardChildRows kind parent-session returns parent children", () => {
  const result = buildDashboardChildRows(BRIDGE_RECORDS, REGISTRY, { kind: "parent-session", id: "parent-sess" });
  assert.ok(Array.isArray(result.rows), "result.rows must be an array");
  // Returns parent's own request rows first, then child session rows
  assert.ok(result.rows.length >= 1, "must return at least one row");
  assert.ok(result.rows.every(r => r.id !== "parent-sess"), "must not include the parent session as a child_session row");
  assert.ok(result.rows.some(r => r.row_type === "request"), "must include parent's own request rows");
  assert.ok(result.rows.some(r => r.row_type === "child_session"), "must include child session rows");
  assert.ok(result.rows.every(r => r.row_type === "request" || r.row_type === "child_session"), "rows must be request or child_session type only");
});

test("buildDashboardChildRows kind session-requests returns request rows", () => {
  const result = buildDashboardChildRows(BRIDGE_RECORDS, REGISTRY, { kind: "session-requests", session_id: "child-sess", parent_session_id: "parent-sess" });
  assert.ok(Array.isArray(result.rows), "result.rows must be an array");
  assert.ok(result.rows.length > 0, "must return at least one request row");
  assert.ok(result.rows.every(r => r.row_type === "request"), "all rows must have row_type request");
});

test("buildDashboardChildRows kind agent-models returns model rows", () => {
  const result = buildDashboardChildRows(BRIDGE_RECORDS, REGISTRY, { kind: "agent-models", agent: "backend-engineer" });
  assert.ok(Array.isArray(result.rows), "result.rows must be an array");
  assert.ok(result.rows.length > 0, "must return at least one model row");
});

test("buildDashboardChildRows kind agent-model-sessions returns session rows", () => {
  const result = buildDashboardChildRows(BRIDGE_RECORDS, REGISTRY, { kind: "agent-model-sessions", agent: "backend-engineer", model_id: "openai/gpt-5.3-codex" });
  assert.ok(Array.isArray(result.rows), "result.rows must be an array");
});

test("buildDashboardChildRows invalid kind throws Error", () => {
  assert.throws(
    () => buildDashboardChildRows(BRIDGE_RECORDS, REGISTRY, { kind: "invalid-kind" }),
    /Invalid dashboard child kind/,
    "invalid kind must throw Error with expected message"
  );
});

// ─── Hierarchy fix: parent session children must not duplicate root ───────────

test("buildParentSessionChildren does not include a row with same id as the parent session", () => {
  // When expanding a parent session, the root row (same id/label as the parent)
  // must NOT appear in the children list — it would duplicate the already-rendered parent row.
  const result = buildParentSessionChildren(BRIDGE_RECORDS, REGISTRY, "parent-sess");
  assert.ok(Array.isArray(result), "result must be an array");
  const duplicates = result.filter(r => r.id === "parent-sess");
  assert.equal(
    duplicates.length,
    0,
    `buildParentSessionChildren must not return a row with id equal to the parent session id ("parent-sess"), ` +
    `but got ${duplicates.length} such row(s): ${JSON.stringify(duplicates.map(r => r.id))}`
  );
});

test("buildParentSessionChildren rows are only child sessions, never the parent session row", () => {
  const result = buildParentSessionChildren(BRIDGE_RECORDS, REGISTRY, "parent-sess");
  // Every row returned must be a child session (telemetry child, not the parent itself)
  const parentRows = result.filter(r => r.id === "parent-sess" || r.label === "parent-sess");
  assert.equal(
    parentRows.length,
    0,
    "buildParentSessionChildren must return only child session rows, not a root row for the parent"
  );
});

// ─── Hierarchy fix: request/message rows must be leaves (no child_query) ──────

test("buildRequestRowsForSession rows have no child_query property", () => {
  // Request rows are leaf rows — they must never expand further.
  const result = buildRequestRowsForSession(BRIDGE_RECORDS, REGISTRY, { sessionId: "child-sess", parentSessionId: "parent-sess" });
  assert.ok(Array.isArray(result), "result must be an array");
  assert.ok(result.length > 0, "must return at least one request row for child-sess");
  result.forEach((row, i) => {
    assert.equal(
      row.child_query,
      undefined,
      `Request row[${i}] (run_id: ${row.run_id}) must not have child_query, got: ${JSON.stringify(row.child_query)}`
    );
  });
});

test("buildDashboardChildRows kind session-requests rows have no child_query", () => {
  const result = buildDashboardChildRows(BRIDGE_RECORDS, REGISTRY, {
    kind: "session-requests",
    session_id: "child-sess",
    parent_session_id: "parent-sess",
  });
  assert.ok(Array.isArray(result.rows), "result.rows must be an array");
  assert.ok(result.rows.length > 0, "must return at least one request row");
  result.rows.forEach((row, i) => {
    assert.equal(
      row.child_query,
      undefined,
      `session-requests child row[${i}] must not have child_query, got: ${JSON.stringify(row.child_query)}`
    );
  });
});

// ─── Hierarchy fix: child_session rows must include has_children boolean ──────

test("buildParentSessionChildren child_session rows include has_children boolean", () => {
  const result = buildParentSessionChildren(BRIDGE_RECORDS, REGISTRY, "parent-sess");
  assert.ok(Array.isArray(result), "result must be an array");
  assert.ok(result.length > 0, "must return at least one row");
  const childSessionRows = result.filter(r => r.row_type === "child_session");
  assert.ok(childSessionRows.length > 0, "must include at least one child_session row");
  childSessionRows.forEach((row, i) => {
    assert.equal(
      typeof row.has_children,
      "boolean",
      `child_session row[${i}] must have has_children as a boolean, got ${typeof row.has_children}`
    );
  });
});

test("buildParentSessionChildren child_session rows with runs have has_children true when they have child_query", () => {
  // child-sess has runs, so it has a child_query for session-requests.
  // has_children must accurately reflect whether expanding would yield data.
  const result = buildParentSessionChildren(BRIDGE_RECORDS, REGISTRY, "parent-sess");
  const childRow = result.find(r => r.id === "child-sess");
  assert.ok(childRow, "child-sess row must be present");
  // child-sess has runs (msg-bridge-1 and msg-child-2) so has_children should be true
  assert.equal(childRow.has_children, true, "child-sess row has runs, so has_children must be true");
});
