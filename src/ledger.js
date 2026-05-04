// src/ledger.js
// Pure-function billable-run ledger — no I/O.

export function avg(values) {
  if (!values.length) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length * 10000) / 10000;
}

export function roundUsd(value) {
  return Math.round(value * 1e6) / 1e6;
}

export function numericToken(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function tokenStatsForRecord(record) {
  const input = numericToken(record?.tokens?.input);
  const output = numericToken(record?.tokens?.output);
  const cacheRead = numericToken(record?.tokens?.cache_read);
  const cacheWrite = numericToken(record?.tokens?.cache_write);
  const effectiveInput = typeof record?.tokens?.effective_input === "number" && Number.isFinite(record.tokens.effective_input)
    ? record.tokens.effective_input
    : input + cacheRead + cacheWrite;

  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    effective_input_tokens: effectiveInput,
    total_tokens: effectiveInput + output,
  };
}

export function sumTokenStats(records) {
  return records.reduce((acc, record) => {
    const tokens = tokenStatsForRecord(record);
    acc.input_tokens += tokens.input_tokens;
    acc.output_tokens += tokens.output_tokens;
    acc.cache_read_tokens += tokens.cache_read_tokens;
    acc.cache_write_tokens += tokens.cache_write_tokens;
    acc.effective_input_tokens += tokens.effective_input_tokens;
    acc.total_tokens += tokens.total_tokens;
    return acc;
  }, {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    effective_input_tokens: 0,
    total_tokens: 0,
  });
}

export function sourcePriority(source) {
  return source === "main" ? 1 : 0;
}

function numericRate(value) {
  if (value === "free") return 0;
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function modelRegistryEntry(record, registry) {
  const modelId = record?.model_id;
  const providerId = record?.provider_id;
  let model = registry?.models?.[modelId];
  if (!model && typeof modelId === "string" && typeof providerId === "string" && !modelId.includes("/")) {
    model = registry?.models?.[`${providerId}/${modelId}`];
  }
  return model ?? null;
}

export function estimateRecordCostUsd(record, registry) {
  const model = modelRegistryEntry(record, registry);
  const cost = model?.cost ?? null;
  const inputRate = numericRate(cost?.input_per_1m);
  const outputRate = numericRate(cost?.output_per_1m);
  if (inputRate == null || outputRate == null) return null;

  const hasCacheReadRate = !!cost && Object.prototype.hasOwnProperty.call(cost, "cache_read_per_1m");
  const hasCacheWriteRate = !!cost && Object.prototype.hasOwnProperty.call(cost, "cache_write_per_1m");

  const cacheReadRate = hasCacheReadRate
    ? numericRate(cost.cache_read_per_1m)
    : (inputRate === 0 ? 0 : inputRate * 0.1);
  const cacheWriteRate = hasCacheWriteRate
    ? numericRate(cost.cache_write_per_1m)
    : inputRate;
  if (cacheReadRate == null || cacheWriteRate == null) return null;

  const input = record.tokens?.input ?? 0;
  const cacheRead = record.tokens?.cache_read ?? 0;
  const cacheWrite = record.tokens?.cache_write ?? 0;
  const output = record.tokens?.output ?? 0;
  return roundUsd(
    (input / 1_000_000) * inputRate +
    (cacheRead / 1_000_000) * cacheReadRate +
    (cacheWrite / 1_000_000) * cacheWriteRate +
    (output / 1_000_000) * outputRate
  );
}

export function effectiveCostUsd(record, registry) {
  if (typeof record.cost_usd === "number" && record.cost_usd > 0) return roundUsd(record.cost_usd);
  const estimated = estimateRecordCostUsd(record, registry);
  return estimated ?? (typeof record.cost_usd === "number" ? roundUsd(record.cost_usd) : 0);
}

function isUsableMessageId(messageId) {
  return typeof messageId === "string" &&
    messageId.trim().length > 0 &&
    messageId.trim().toLowerCase() !== "unknown";
}

function billableRunKey(record, index) {
  const sessionIdentity = record?.telemetry_session_id ?? record?.session_id;
  if (typeof sessionIdentity === "string" && sessionIdentity.length > 0 && isUsableMessageId(record?.message_id)) {
    return `run:${sessionIdentity}:::${record.message_id.trim()}`;
  }
  const fallback = record?.id ?? record?.record_id ?? `record:${index}`;
  return `record:${fallback}`;
}

function costRatesForRecord(record, registry) {
  const model = modelRegistryEntry(record, registry);
  const cost = model?.cost ?? null;
  const inputRate = numericRate(cost?.input_per_1m);
  const outputRate = numericRate(cost?.output_per_1m);
  if (inputRate == null || outputRate == null) return null;
  const hasCacheReadRate = !!cost && Object.prototype.hasOwnProperty.call(cost, "cache_read_per_1m");
  const hasCacheWriteRate = !!cost && Object.prototype.hasOwnProperty.call(cost, "cache_write_per_1m");
  const cacheReadRate = hasCacheReadRate ? numericRate(cost.cache_read_per_1m) : (inputRate === 0 ? 0 : inputRate * 0.1);
  const cacheWriteRate = hasCacheWriteRate ? numericRate(cost.cache_write_per_1m) : inputRate;
  if (cacheReadRate == null || cacheWriteRate == null) return null;
  return { inputRate, cacheReadRate, cacheWriteRate, outputRate };
}

function costBreakdownForRecord(record, registry) {
  const tokens = tokenStatsForRecord(record);
  const providerCost = typeof record?.cost_usd === "number" && Number.isFinite(record.cost_usd) && record.cost_usd > 0
    ? roundUsd(record.cost_usd)
    : null;
  const rates = costRatesForRecord(record, registry);
  if (!rates) {
    return {
      fresh_input_cost_usd: 0,
      cached_input_cost_usd: 0,
      cache_write_cost_usd: 0,
      output_cost_usd: 0,
      total_cost_usd: providerCost ?? 0,
      cost_source: providerCost != null ? "provider" : "partial",
    };
  }

  const fresh = roundUsd((tokens.input_tokens / 1_000_000) * rates.inputRate);
  const cached = roundUsd((tokens.cache_read_tokens / 1_000_000) * rates.cacheReadRate);
  const write = roundUsd((tokens.cache_write_tokens / 1_000_000) * rates.cacheWriteRate);
  const output = roundUsd((tokens.output_tokens / 1_000_000) * rates.outputRate);
  const estimated = roundUsd(fresh + cached + write + output);
  const allRatesZero = rates.inputRate === 0 && rates.cacheReadRate === 0 && rates.cacheWriteRate === 0 && rates.outputRate === 0;
  return {
    fresh_input_cost_usd: fresh,
    cached_input_cost_usd: cached,
    cache_write_cost_usd: write,
    output_cost_usd: output,
    total_cost_usd: providerCost ?? estimated,
    cost_source: providerCost != null ? "provider" : (allRatesZero ? "free" : "estimated"),
  };
}

export function buildBillableRuns(records, registry = null) {
  const byKey = new Map();
  const orderedKeys = [];
  records.forEach((record, index) => {
    const key = billableRunKey(record, index);
    if (!byKey.has(key)) {
      byKey.set(key, []);
      orderedKeys.push(key);
    }
    byKey.get(key).push(record);
  });

  return orderedKeys.map((key) => {
    const observations = byKey.get(key);
    const canonicalRecord = observations.reduce((best, record) => (
      sourcePriority(record?.source) > sourcePriority(best?.source) ? record : best
    ), observations[0]);
    const tokens = tokenStatsForRecord(canonicalRecord);
    const costs = costBreakdownForRecord(canonicalRecord, registry);
    return {
      key,
      run_id: key,
      canonical_record: canonicalRecord,
      observations,
      raw_record_count: observations.length,
      bridge_record_count: observations.filter(r => (r.source ?? "subagent") !== "main").length,
      agent: canonicalRecord?.agent ?? "unknown",
      provider_id: canonicalRecord?.provider_id ?? "",
      model_id: canonicalRecord?.model_id ?? "unknown",
      session_id: canonicalRecord?.session_id ?? "unknown",
      telemetry_session_id: canonicalRecord?.telemetry_session_id ?? canonicalRecord?.session_id ?? "unknown",
      message_id: canonicalRecord?.message_id ?? "",
      timestamp: canonicalRecord?.timestamp ?? "",
      duration_ms: canonicalRecord?.duration_ms ?? null,
      avg_composite: typeof canonicalRecord?.scores?.composite === "number"
        ? Math.round(canonicalRecord.scores.composite * 10000) / 10000
        : null,
      fresh_input_tokens: tokens.input_tokens,
      cached_input_tokens: tokens.cache_read_tokens,
      cache_write_tokens: tokens.cache_write_tokens,
      output_tokens: tokens.output_tokens,
      total_tokens: tokens.total_tokens,
      ...costs,
    };
  });
}

export function sumRunBuckets(runs) {
  return runs.reduce((acc, run) => {
    acc.fresh_input_tokens  += run.fresh_input_tokens  ?? 0;
    acc.cached_input_tokens += run.cached_input_tokens ?? 0;
    acc.cache_write_tokens  += run.cache_write_tokens  ?? 0;
    acc.output_tokens       += run.output_tokens       ?? 0;
    acc.total_tokens        += run.total_tokens        ?? 0;
    acc.fresh_input_cost_usd  = roundUsd((acc.fresh_input_cost_usd  ?? 0) + (run.fresh_input_cost_usd  ?? 0));
    acc.cached_input_cost_usd = roundUsd((acc.cached_input_cost_usd ?? 0) + (run.cached_input_cost_usd ?? 0));
    acc.cache_write_cost_usd  = roundUsd((acc.cache_write_cost_usd  ?? 0) + (run.cache_write_cost_usd  ?? 0));
    acc.output_cost_usd       = roundUsd((acc.output_cost_usd       ?? 0) + (run.output_cost_usd       ?? 0));
    acc.total_cost_usd        = roundUsd((acc.total_cost_usd        ?? 0) + (run.total_cost_usd        ?? 0));
    return acc;
  }, {
    fresh_input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    fresh_input_cost_usd: 0,
    cached_input_cost_usd: 0,
    cache_write_cost_usd: 0,
    output_cost_usd: 0,
    total_cost_usd: 0,
  });
}

export function displayValue(values) {
  const distinct = [...new Set(values.filter(v => v != null && v !== ""))];
  if (distinct.length === 0) return "unknown";
  if (distinct.length === 1) return distinct[0];
  return `mixed (${distinct.length})`;
}

export function avgCompositeForRuns(runs) {
  const vals = runs.map(r => r.avg_composite).filter(v => typeof v === "number");
  return avg(vals);
}

export function paginationForRows(rows, page = 1, pageSize = 50) {
  if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = 1;
  if (pageSize > 200) pageSize = 200;
  const total_rows = rows.length;
  const total_pages = Math.max(1, Math.ceil(total_rows / pageSize));
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (page > total_pages) page = total_pages;
  const start = (page - 1) * pageSize;
  return {
    rows: rows.slice(start, start + pageSize),
    pagination: {
      page,
      page_size: pageSize,
      total_rows,
      total_pages,
      has_next: page < total_pages,
      has_previous: page > 1,
    },
  };
}

export function buildSessionGraph(records) {
  const childToParent = new Map();
  const parentToChildren = new Map();
  for (const r of records) {
    if (
      r.source === "subagent" &&
      typeof r.session_id === "string" && r.session_id.length > 0 &&
      typeof r.telemetry_session_id === "string" && r.telemetry_session_id.length > 0 &&
      r.telemetry_session_id !== r.session_id
    ) {
      childToParent.set(r.telemetry_session_id, r.session_id);
      if (!parentToChildren.has(r.session_id)) parentToChildren.set(r.session_id, new Set());
      parentToChildren.get(r.session_id).add(r.telemetry_session_id);
    }
  }
  return { childToParent, parentToChildren };
}
