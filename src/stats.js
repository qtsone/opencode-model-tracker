// src/stats.js
// Pure-function stats aggregation — no I/O. Port of model_performance_webapp.py.

import {
  avg,
  avgCompositeForRuns,
  buildBillableRuns,
  buildSessionGraph,
  displayValue,
  effectiveCostUsd,
  estimateRecordCostUsd,
  paginationForRows,
  roundUsd,
  sourcePriority,
  sumRunBuckets,
  sumTokenStats,
  tokenStatsForRecord,
} from "./ledger.js";

// ---------------------------------------------------------------------------
// Time range constants and helpers
// ---------------------------------------------------------------------------

const TIME_RANGE_MS = {
  "15m": 15 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1h":  60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d":  7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const DEFAULT_TIME_RANGE = "1h";

/**
 * Normalize a time_range query value. Valid values: "15m", "30m", "1h", "24h", "7d", "30d", "all".
 * All other values (null, undefined, empty, unknown, wrong case) normalize to DEFAULT_TIME_RANGE.
 *
 * @param {string|null|undefined} value
 * @returns {string}
 */
export function normalizeTimeRange(value) {
  if (value === "all") return "all";
  if (typeof value === "string" && Object.prototype.hasOwnProperty.call(TIME_RANGE_MS, value)) {
    return value;
  }
  return DEFAULT_TIME_RANGE;
}

/**
 * Filter records to those within the given time range window.
 * For relative ranges, records with missing or invalid timestamps are excluded.
 * For "all", all records are included regardless of timestamp.
 *
 * @param {object[]} records
 * @param {string} timeRange - normalized time range value
 * @param {number} [nowMs] - reference timestamp in milliseconds (defaults to Date.now())
 * @returns {object[]}
 */
export function applyTimeRangeFilter(records, timeRange, nowMs = Date.now()) {
  if (timeRange === "all") return records;
  const windowMs = TIME_RANGE_MS[timeRange];
  if (!windowMs) return records;
  const cutoff = nowMs - windowMs;
  return records.filter(r => {
    if (!r.timestamp) return false;
    const ts = Date.parse(r.timestamp);
    if (!Number.isFinite(ts)) return false;
    return ts >= cutoff;
  });
}

const VALID_SORT_FIELDS = new Set([
  "avg_composite",
  "avg_effective_quality",
  "avg_duration_ms",
  "total_cost_usd",
  "runs",
]);

/**
 * @param {object[]} records
 * @param {string|null} agent
 * @param {string|null} session_id
 * @param {string|null} model_id
 */
export function applyFilters(records, agent, session_id, model_id) {
  let r = records;
  if (agent)      r = r.filter(x => x.agent      === agent);
  if (session_id) r = r.filter(x => x.session_id === session_id);
  if (model_id)   r = r.filter(x => x.model_id   === model_id);
  return r;
}

export function computeFilterOptions(records) {
  const agents   = [...new Set(records.map(r => r.agent).filter(Boolean))].sort();
  const sessions = [...new Set(records.map(r => r.session_id).filter(Boolean))].sort();
  const models   = [...new Set(records.map(r => r.model_id).filter(Boolean))].sort();
  return { agents, session_ids: sessions, model_ids: models };
}

function logicalRequestKey(record, index) {
  const sessionIdentity = record?.telemetry_session_id ?? record?.session_id;
  const messageIdentity = record?.message_id;

  if (sessionIdentity != null && typeof messageIdentity === "string" && messageIdentity.trim().length > 0) {
    return `logical:${sessionIdentity}:::${messageIdentity}`;
  }

  // Legacy/no-message rows must never collapse together.
  return `record:${index}`;
}

function canonicalUniqueRecords(records) {
  const selectedByKey = new Map();
  const orderedKeys = [];

  records.forEach((record, index) => {
    const key = logicalRequestKey(record, index);
    const existing = selectedByKey.get(key);

    if (!existing) {
      selectedByKey.set(key, record);
      orderedKeys.push(key);
      return;
    }

    if (sourcePriority(record?.source) > sourcePriority(existing?.source)) {
      selectedByKey.set(key, record);
    }
  });

  return orderedKeys.map(key => selectedByKey.get(key));
}

export function computeStats(records, registry = null) {
  const total = records.length;
  const uniqueRecords = canonicalUniqueRecords(records);
  if (total === 0) {
    return {
      total_records: 0,
      avg_duration_ms: null,
      total_cost_usd: 0.0,
      tokens: sumTokenStats([]),
      attributed_cost_usd: 0.0,
      attributed_tokens: sumTokenStats([]),
      top_agents: [],
      top_models: [],
      recent_records: [],
    };
  }

  const durations = records.map(r => r.duration_ms).filter(v => typeof v === "number");
  const uniqueCosts = uniqueRecords.map(r => effectiveCostUsd(r, registry)).filter(v => typeof v === "number");
  const attributedCosts = records.map(r => effectiveCostUsd(r, registry)).filter(v => typeof v === "number");

  const agentCounts = {};
  const modelCounts = {};
  for (const r of records) {
    const a = r.agent    || "unknown";
    const m = r.model_id || "unknown";
    agentCounts[a] = (agentCounts[a] ?? 0) + 1;
    modelCounts[m] = (modelCounts[m] ?? 0) + 1;
  }

  const topAgents = Object.entries(agentCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  const topModels = Object.entries(modelCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  const sorted = [...records].sort((a, b) =>
    (b.timestamp ?? "").localeCompare(a.timestamp ?? "")
  );
  const tokenTotals = sumTokenStats(uniqueRecords);
  const attributedTokenTotals = sumTokenStats(records);

  const recentRecords = sorted.slice(0, 20).map(r => {
    const estimatedCost = estimateRecordCostUsd(r, registry);
    const effectiveCost = effectiveCostUsd(r, registry);
    const tokenStats = tokenStatsForRecord(r);
    return {
      timestamp:          r.timestamp ?? "",
      agent:              r.agent ?? "",
      source:             r.source ?? "subagent",
      model_id:           r.model_id ?? "",
      duration_ms:        r.duration_ms ?? null,
      cost_usd:           r.cost_usd ?? null,
      estimated_cost_usd: estimatedCost,
      effective_cost_usd: effectiveCost,
      composite: typeof r.scores?.composite === "number"
        ? Math.round(r.scores.composite * 10000) / 10000
        : null,
      ...tokenStats,
    };
  });

  return {
    total_records:   total,
    avg_duration_ms: avg(durations),
    total_cost_usd:  roundUsd(uniqueCosts.reduce((a, b) => a + b, 0)),
    tokens:          tokenTotals,
    attributed_cost_usd: roundUsd(attributedCosts.reduce((a, b) => a + b, 0)),
    attributed_tokens: attributedTokenTotals,
    top_agents:      topAgents,
    top_models:      topModels,
    recent_records:  recentRecords,
  };
}

export function computePerAgentModelStats(records, sortBy = "avg_composite", sortDir = "desc", registry = null) {
  if (!VALID_SORT_FIELDS.has(sortBy)) sortBy = "avg_composite";
  if (sortDir !== "asc" && sortDir !== "desc") sortDir = "desc";

  const groups = new Map();
  for (const r of records) {
    const key = `${r.agent ?? "unknown"}|||${r.model_id ?? "unknown"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const rows = [];
  for (const [key, grp] of groups) {
    const [agent, model_id] = key.split("|||");
    const durVals  = grp.map(r => r.duration_ms).filter(v => typeof v === "number");
    const costVals = grp.map(r => effectiveCostUsd(r, registry)).filter(v => typeof v === "number");
    const compVals = grp.map(r => r.scores?.composite).filter(v => typeof v === "number");
    const qualVals = grp.map(r => r.scores?.effective_quality).filter(v => typeof v === "number");
    const tokenTotals = sumTokenStats(grp);

    rows.push({
      agent,
      model_id,
      runs: grp.length,
      avg_composite:         avg(compVals),
      avg_effective_quality: avg(qualVals),
      avg_duration_ms:       avg(durVals),
      total_cost_usd: costVals.length
        ? roundUsd(costVals.reduce((a, b) => a + b, 0))
        : 0.0,
      ...tokenTotals,
    });
  }

  const reverse = sortDir === "desc";
  rows.sort((a, b) => {
    const av = a[sortBy];
    const bv = b[sortBy];
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return reverse ? bv - av : av - bv;
  });

  return rows;
}

/**
 * @param {object[]} records
 * @param {object|null} registry
 * @param {{ groupSessionBy?: "raw" | "parent" }} [options]
 */
export function computeSessionStats(records, registry = null, options = {}) {
  const groupSessionBy = options?.groupSessionBy ?? "raw";
  const childToParent = groupSessionBy === "parent" ? buildSessionGraph(records).childToParent : new Map();

  /**
   * Resolve the effective session bucket key for a record.
   * In parent mode, child main rows are re-bucketed under their parent session.
   */
  function effectiveSessionKey(r) {
    const rawKey = r.session_id ?? "unknown";
    if (groupSessionBy !== "parent") return rawKey;
    // A child main row has session_id === telemetry_session_id.
    // If telemetry_session_id maps to a parent, use the parent as bucket key.
    const tel = r.telemetry_session_id;
    if (typeof tel === "string" && tel === rawKey && childToParent.has(tel)) {
      return childToParent.get(tel);
    }
    return rawKey;
  }

  const uniqueRecords = canonicalUniqueRecords(records);

  const groups = new Map();
  for (const r of uniqueRecords) {
    const key = effectiveSessionKey(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  // In parent mode each session bucket may now contain records that were
  // originally keyed by different raw session_ids. Re-deduplicate within
  // each bucket so shared logical rows are not double-counted.
  if (groupSessionBy === "parent") {
    for (const [key, grp] of groups) {
      groups.set(key, canonicalUniqueRecords(grp));
    }
  }

  const attributedGroups = new Map();
  for (const r of records) {
    const key = effectiveSessionKey(r);
    if (!attributedGroups.has(key)) attributedGroups.set(key, []);
    attributedGroups.get(key).push(r);
  }

  const sessionIds = new Set([...groups.keys(), ...attributedGroups.keys()]);
  const rows = [];
  for (const session_id of sessionIds) {
    const grp = groups.get(session_id) ?? [];
    const attributedGrp = attributedGroups.get(session_id) ?? [];
    const costs = grp.map(r => effectiveCostUsd(r, registry)).filter(v => typeof v === "number");
    const durations = grp.map(r => r.duration_ms).filter(v => typeof v === "number");
    const attributedCosts = attributedGrp.map(r => effectiveCostUsd(r, registry)).filter(v => typeof v === "number");
    const sorted = [...attributedGrp].sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
    const tokenTotals = sumTokenStats(grp);
    const attributedTokenTotals = sumTokenStats(attributedGrp);
    rows.push({
      session_id,
      runs: attributedGrp.length,
      main_runs: attributedGrp.filter(r => (r.source ?? "subagent") === "main").length,
      subagent_runs: attributedGrp.filter(r => (r.source ?? "subagent") !== "main").length,
      total_cost_usd: roundUsd(costs.reduce((a, b) => a + b, 0)),
      attributed_cost_usd: roundUsd(attributedCosts.reduce((a, b) => a + b, 0)),
      avg_duration_ms: avg(durations),
      last_timestamp: sorted[0]?.timestamp ?? "",
      attributed_tokens: attributedTokenTotals,
      attributed_total_tokens: attributedTokenTotals.total_tokens,
      ...tokenTotals,
    });
  }

  rows.sort((a, b) => (b.total_cost_usd - a.total_cost_usd) || b.last_timestamp.localeCompare(a.last_timestamp));
  return rows;
}

/**
 * Build full stats API response from raw records and query params.
 * @param {object[]} allRecords
 * @param {{ agent?: string, session_id?: string, model_id?: string, sort_by?: string, sort_dir?: string, group_session_by?: "raw" | "parent", session_page?: number, session_page_size?: number }} params
 * @param {object|null} registry
 */
export function buildStatsResponse(allRecords, params, registry = null) {
  const agent      = params.agent      || null;
  const session_id = params.session_id || null;
  const model_id   = params.model_id   || null;
  const sort_by    = params.sort_by    || "avg_composite";
  const sort_dir   = params.sort_dir   || "desc";
  const groupSessionBy = params.group_session_by === "parent" ? "parent" : "raw";
  const time_range = normalizeTimeRange(params.time_range);

  // Normalize pagination params: page_size clamped to [1, 200], page is 1-based
  const PAGE_SIZE_MAX = 200;
  const PAGE_SIZE_DEFAULT = 50;
  let pageSize = parseInt(params.session_page_size, 10);
  if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = PAGE_SIZE_DEFAULT;
  if (pageSize > PAGE_SIZE_MAX) pageSize = PAGE_SIZE_MAX;

  // filter_options always reflects all-time records
  const filterOptions = computeFilterOptions(allRecords);

  // Apply time range first, then secondary filters for stats/session/per-agent-model data
  const timeFiltered = applyTimeRangeFilter(allRecords, time_range);
  const filtered     = applyFilters(timeFiltered, agent, session_id, model_id);
  const stats        = computeStats(filtered, registry);

  const allSessionRows = computeSessionStats(filtered, registry, { groupSessionBy });
  const totalSessions  = allSessionRows.length;
  const totalPages     = Math.max(1, Math.ceil(totalSessions / pageSize));

  let page = parseInt(params.session_page, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (page > totalPages) page = totalPages;

  const sliceStart = (page - 1) * pageSize;
  const perSessionStats = allSessionRows.slice(sliceStart, sliceStart + pageSize);

  const pagination = {
    page,
    page_size: pageSize,
    total_sessions: totalSessions,
    total_pages: totalPages,
    has_next: page < totalPages,
    has_previous: page > 1,
  };

  const parentPage = parseInt(params.parent_page ?? params.session_page ?? 1, 10);
  const parentPageSize = parseInt(params.parent_page_size ?? params.session_page_size ?? 50, 10);
  const agentPage = parseInt(params.agent_page ?? 1, 10);
  const agentPageSize = parseInt(params.agent_page_size ?? 50, 10);

  const dashboardParentSessionId = params.parent_session_id || session_id || null;

  const dashboardParentSessions = buildParentSessionDashboardRows(filtered, registry, {
    page: Number.isFinite(parentPage) && parentPage >= 1 ? parentPage : 1,
    pageSize: Number.isFinite(parentPageSize) && parentPageSize >= 1 ? parentPageSize : 50,
    parentSessionId: dashboardParentSessionId,
  });

  const dashboardAgents = buildAgentDashboardRows(filtered, registry, {
    page: Number.isFinite(agentPage) && agentPage >= 1 ? agentPage : 1,
    pageSize: Number.isFinite(agentPageSize) && agentPageSize >= 1 ? agentPageSize : 50,
  });

  // Summary uses filtered (time-ranged + secondary-filtered) canonical tokens for broad totals
  const allRuns = buildBillableRuns(filtered, registry);
  const summaryBuckets = sumRunBuckets(allRuns);
  const dashboardSummary = {
    total_tokens: summaryBuckets.total_tokens,
    total_cost_usd: summaryBuckets.total_cost_usd,
    fresh_input_tokens: summaryBuckets.fresh_input_tokens,
    cached_input_tokens: summaryBuckets.cached_input_tokens,
    cache_write_tokens: summaryBuckets.cache_write_tokens,
    output_tokens: summaryBuckets.output_tokens,
  };

  return {
    ...stats,
    last_updated:          new Date().toISOString(),
    error:                 null,
    filters_applied:       { agent, session_id, model_id, sort_by, sort_dir, group_session_by: groupSessionBy, session_page: page, session_page_size: pageSize, time_range },
    filter_options:        filterOptions,
    per_agent_model_stats: computePerAgentModelStats(filtered, sort_by, sort_dir, registry),
    per_session_stats:     perSessionStats,
    per_session_pagination: pagination,
    dashboard: {
      summary: dashboardSummary,
      parent_sessions: dashboardParentSessions,
      agents: dashboardAgents,
    },
  };
}

/**
 * Build child rows for a dashboard entry based on the child kind.
 * Dispatches to the appropriate builder function.
 *
 * @param {object[]} records
 * @param {object|null} registry
 * @param {{ kind: string, id?: string, session_id?: string, parent_session_id?: string, agent?: string, model_id?: string }} params
 * @returns {{ rows: object[] }}
 */
export function buildDashboardChildRows(records, registry = null, params = {}) {
  const time_range = normalizeTimeRange(params.time_range);
  const agent      = params.agent      || null;
  const session_id = params.session_id || null;
  const model_id   = params.model_id   || null;

  const timeFiltered = applyTimeRangeFilter(records, time_range);
  const filtered     = applyFilters(timeFiltered, agent, session_id, model_id);

  const { kind } = params;
  if (kind === "parent-session") {
    return { rows: buildParentSessionChildren(filtered, registry, params.id) };
  }
  if (kind === "session-requests") {
    return { rows: buildRequestRowsForSession(filtered, registry, { sessionId: params.session_id, parentSessionId: params.parent_session_id }) };
  }
  if (kind === "agent-models") {
    return { rows: buildAgentModelRows(filtered, registry, params.agent) };
  }
  if (kind === "agent-model-sessions") {
    return { rows: buildAgentModelSessionRows(filtered, registry, { agent: params.agent, model_id: params.model_id }) };
  }
  throw new Error("Invalid dashboard child kind");
}

// ---------------------------------------------------------------------------
// Parent session dashboard views
// ---------------------------------------------------------------------------

/**
 * Build a single parent dashboard row from a set of runs belonging to that parent.
 * @param {string} parentId
 * @param {object[]} runs - all billable runs belonging to this parent
 * @param {Set<string>} childSessions - set of child session_ids
 */
function rowFromRuns(parentId, runs, childSessions) {
  const buckets = sumRunBuckets(runs);
  const timestamps = runs.map(r => r.timestamp).filter(Boolean).sort();

  const parentOwnRuns = runs.filter(r => r.session_id === parentId);
  const childRuns = runs.filter(r => r.session_id !== parentId);

  const orchestratorAgent = displayValue(parentOwnRuns.map(r => r.agent).filter(Boolean));
  const orchestratorModel = displayValue(parentOwnRuns.map(r => r.model_id).filter(Boolean));

  return {
    id: parentId,
    label: (() => {
      const startTs = timestamps[0] ? timestamps[0].slice(0, 16).replace('T', ' ') : '';
      return startTs ? `${startTs} (${parentId.slice(0, 8)}\u2026)` : `${parentId.slice(0, 12)}\u2026`;
    })(),
    row_type: "parent_session",
    run_count: runs.length,
    child_session_count: childSessions.size,
    session_count: 1 + childSessions.size,
    has_children: childSessions.size > 0,
    agent: orchestratorAgent,
    model_id: orchestratorModel,
    cost_source_summary: displayValue(runs.map(r => r.cost_source)),
    last_timestamp: timestamps[timestamps.length - 1] ?? "",
    avg_composite: avgCompositeForRuns(runs),
    child_query: { kind: "parent-session", id: parentId },
    ...buckets,
  };
}

/**
 * Build parent session dashboard rows from raw records.
 * Each parent session aggregates runs from itself and all mapped child sessions.
 * Bridge records do not appear as additional billable runs.
 *
 * @param {object[]} records
 * @param {object|null} registry
 * @param {{ page?: number, pageSize?: number, parentSessionId?: string }} [options]
 * @returns {{ rows: object[], pagination: object }}
 */
export function buildParentSessionDashboardRows(records, registry = null, options = {}) {
  const ledger = buildBillableRuns(records, registry);
  const { childToParent, parentToChildren } = buildSessionGraph(records);

  // Determine the effective parent for each run's session_id.
  // A run's session_id is either a parent itself, or a child session mapped to a parent.
  const parentIds = new Set();
  for (const run of ledger) {
    const sid = run.session_id;
    if (parentToChildren.has(sid)) {
      parentIds.add(sid);
    } else if (childToParent.has(sid)) {
      parentIds.add(childToParent.get(sid));
    } else {
      // Unmapped sessions are their own parent
      parentIds.add(sid);
    }
  }

  const rows = [];
  for (const parentId of parentIds) {
    const childSessions = parentToChildren.get(parentId) ?? new Set();
    const parentRuns = ledger.filter(run => {
      const sid = run.session_id;
      return sid === parentId || childSessions.has(sid);
    });
    rows.push(rowFromRuns(parentId, parentRuns, childSessions));
  }

  // Sort by last_timestamp descending
  rows.sort((a, b) => (b.last_timestamp ?? "").localeCompare(a.last_timestamp ?? ""));

  // Apply parent filter after ledger construction
  const { parentSessionId, page = 1, pageSize = 50 } = options;
  const filtered = parentSessionId != null
    ? rows.filter(r => r.id === parentSessionId)
    : rows;

  return paginationForRows(filtered, page, pageSize);
}

/**
 * Return root + child session rows for a given parent session.
 * Root row comes first, then child rows sorted by id ascending.
 *
 * @param {object[]} records
 * @param {object|null} registry
 * @param {string} parentSessionId
 * @returns {object[]}
 */
export function buildParentSessionChildren(records, registry = null, parentSessionId) {
  const ledger = buildBillableRuns(records, registry);
  const { parentToChildren } = buildSessionGraph(records);
  const childSessions = parentToChildren.get(parentSessionId) ?? new Set();

  const childRows = [];
  for (const childId of [...childSessions].sort()) {
    const childRuns = ledger.filter(r => r.session_id === childId);
    const childBuckets = sumRunBuckets(childRuns);
    const hasChildren = childRuns.length > 0;
    childRows.push({
      id: childId,
      label: childId,
      row_type: "child_session",
      run_count: childRuns.length,
      session_count: 1,
      has_children: hasChildren,
      agent: displayValue(childRuns.map(r => r.agent).filter(Boolean)),
      model_id: displayValue(childRuns.map(r => r.model_id).filter(Boolean)),
      cost_source_summary: displayValue(childRuns.map(r => r.cost_source)),
      child_query: { kind: "parent-session", id: childId },
      ...childBuckets,
    });
  }

  const ownRequestRows = buildRequestRowsForSession(records, registry, { sessionId: parentSessionId });
  return [...ownRequestRows, ...childRows];
}

/**
 * Return canonical request rows for a specific session, sorted by timestamp descending (newest first).
 * Bridge duplicate rows are not shown as separate entries.
 *
 * @param {object[]} records
 * @param {object|null} registry
 * @param {{ sessionId: string, parentSessionId?: string }} options
 * @returns {object[]}
 */
export function buildRequestRowsForSession(records, registry = null, options = {}) {
  const { sessionId, parentSessionId } = options;
  const ledger = buildBillableRuns(records, registry);
  const runs = ledger.filter(r => r.session_id === sessionId);
  runs.sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
  return runs.map(run => ({
    row_type: "request",
    run_id: run.run_id,
    record_id: run.canonical_record?.id ?? null,
    label: run.message_id && run.message_id.trim().length > 0 ? run.message_id : run.run_id,
    message_id: run.message_id,
    agent: run.agent,
    model_id: run.model_id,
    timestamp: run.timestamp,
    duration_ms: run.duration_ms,
    avg_composite: run.avg_composite,
    raw_record_count: run.raw_record_count,
    bridge_record_count: run.bridge_record_count,
    cost_source: run.cost_source,
    cost_source_summary: run.cost_source,
    fresh_input_tokens: run.fresh_input_tokens,
    cached_input_tokens: run.cached_input_tokens,
    cache_write_tokens: run.cache_write_tokens,
    output_tokens: run.output_tokens,
    total_tokens: run.total_tokens,
    fresh_input_cost_usd: run.fresh_input_cost_usd,
    cached_input_cost_usd: run.cached_input_cost_usd,
    cache_write_cost_usd: run.cache_write_cost_usd,
    output_cost_usd: run.output_cost_usd,
    total_cost_usd: run.total_cost_usd,
  }));
}

// ---------------------------------------------------------------------------
// Task 3: Agent dashboard hierarchy
// ---------------------------------------------------------------------------

/**
 * Build agent dashboard rows from raw records.
 * Each row aggregates all runs across all models/sessions for an agent.
 * Sorted by total_cost_usd descending, then agent id ascending as tie-breaker.
 *
 * @param {object[]} records
 * @param {object|null} registry
 * @param {{ page?: number, pageSize?: number }} [options]
 * @returns {{ rows: object[], pagination: object }}
 */
export function buildAgentDashboardRows(records, registry = null, options = {}) {
  const ledger = buildBillableRuns(records, registry);

  // Group runs by agent
  const byAgent = new Map();
  for (const run of ledger) {
    const agent = run.agent ?? "unknown";
    if (!byAgent.has(agent)) byAgent.set(agent, []);
    byAgent.get(agent).push(run);
  }

  const rows = [];
  for (const [agent, runs] of byAgent) {
    const buckets = sumRunBuckets(runs);
    const modelIds = [...new Set(runs.map(r => r.model_id).filter(Boolean))];
    const sessionIds = [...new Set(runs.map(r => r.session_id).filter(Boolean))];
    rows.push({
      id: agent,
      label: agent,
      row_type: "agent",
      run_count: runs.length,
      session_count: sessionIds.length,
      model_count: modelIds.length,
      agent,
      model_id: displayValue(modelIds),
      avg_composite: avgCompositeForRuns(runs),
      cost_source_summary: displayValue(runs.map(r => r.cost_source)),
      child_query: { kind: "agent-models", agent },
      has_children: modelIds.length > 0,
      ...buckets,
    });
  }

  rows.sort((a, b) =>
    (b.total_cost_usd - a.total_cost_usd) || a.id.localeCompare(b.id)
  );

  const { page = 1, pageSize = 50 } = options;
  return paginationForRows(rows, page, pageSize);
}

/**
 * Build model rows under a specific agent.
 * Sorted by avg_composite descending (null last), then total_cost_usd descending, then model_id ascending.
 *
 * @param {object[]} records
 * @param {object|null} registry
 * @param {string} agent
 * @returns {object[]}
 */
export function buildAgentModelRows(records, registry = null, agent) {
  const ledger = buildBillableRuns(records, registry);
  const agentRuns = ledger.filter(r => r.agent === agent);

  const byModel = new Map();
  for (const run of agentRuns) {
    const modelId = run.model_id ?? "unknown";
    if (!byModel.has(modelId)) byModel.set(modelId, []);
    byModel.get(modelId).push(run);
  }

  const rows = [];
  for (const [modelId, runs] of byModel) {
    const buckets = sumRunBuckets(runs);
    const sessionIds = [...new Set(runs.map(r => r.session_id).filter(Boolean))];
    rows.push({
      id: modelId,
      label: modelId,
      row_type: "agent_model",
      agent,
      model_id: modelId,
      run_count: runs.length,
      session_count: sessionIds.length,
      avg_composite: avgCompositeForRuns(runs),
      cost_source_summary: displayValue(runs.map(r => r.cost_source)),
      has_children: false,
      ...buckets,
    });
  }

  rows.sort((a, b) => {
    const ac = a.avg_composite;
    const bc = b.avg_composite;
    if (ac === null && bc === null) return (b.total_cost_usd - a.total_cost_usd) || a.id.localeCompare(b.id);
    if (ac === null) return 1;
    if (bc === null) return -1;
    if (bc !== ac) return bc - ac;
    if (b.total_cost_usd !== a.total_cost_usd) return b.total_cost_usd - a.total_cost_usd;
    return a.id.localeCompare(b.id);
  });

  return rows;
}

/**
 * Build session rows under a specific agent/model pair.
 * Sorted by total_cost_usd descending, then session_id ascending as tie-breaker.
 *
 * @param {object[]} records
 * @param {object|null} registry
 * @param {{ agent: string, model_id: string }} options
 * @returns {object[]}
 */
export function buildAgentModelSessionRows(records, registry = null, options = {}) {
  const { agent, model_id: modelId } = options;
  const ledger = buildBillableRuns(records, registry);
  const filtered = ledger.filter(r => r.agent === agent && r.model_id === modelId);

  const bySession = new Map();
  for (const run of filtered) {
    const sid = run.session_id ?? "unknown";
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push(run);
  }

  const rows = [];
  for (const [sessionId, runs] of bySession) {
    const buckets = sumRunBuckets(runs);
    rows.push({
      id: sessionId,
      label: sessionId,
      row_type: "agent_model_session",
      agent,
      model_id: modelId,
      session_count: 1,
      run_count: runs.length,
      avg_composite: avgCompositeForRuns(runs),
      cost_source_summary: displayValue(runs.map(r => r.cost_source)),
      child_query: { kind: "session-requests", session_id: sessionId, parent_session_id: null },
      has_children: runs.length > 0,
      ...buckets,
    });
  }

  rows.sort((a, b) =>
    (b.total_cost_usd - a.total_cost_usd) || a.id.localeCompare(b.id)
  );

  return rows;
}
