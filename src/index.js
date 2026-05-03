/**
 * model-tracker — opencode server plugin
 *
 * Automatically records performance metrics for sub-agent and main-agent
 * executions and persists them to sqlite.
 *
 * HOW SUB-AGENT BOUNDARIES ARE DETECTED
 * ───────────────────────────────────────
 * opencode has no dedicated sub-agent lifecycle hook. Sub-agents are spawned
 * via the built-in `task` tool. The plugin detects boundaries using three
 * complementary signals from the event stream and interceptor hooks:
 *
 *   1. message.part.updated (event) where part.type === "subtask"
 *      → carries { agent, prompt, description, callID-correlated messageID }
 *        This is the dispatch signal — we learn which agent is being called
 *        and for what purpose before execution begins.
 *
 *   2. tool.execute.before hook where tool === "task"
 *      → fires synchronously before the sub-agent runs. We record the
 *        wall-clock start time and store pending state keyed on callID.
 *
 *   3. tool.execute.after hook where tool === "task"
 *      → fires synchronously after the sub-agent returns. We compute
 *        duration, pull token/cost data from the completed AssistantMessage
 *        (fetched via the REST client), and write the record atomically.
 *        This fires before technical-lead processes the result — the earliest
 *        possible moment to record without requiring LLM cooperation.
 *
 * TOKEN / COST DATA
 * ─────────────────
 * AssistantMessage (from message.updated events) carries tokens and cost but
 * has no agent field. We correlate via task-tool metadata (child session ID)
 * and fetch the completed assistant message from that sub-agent session.
 *
 * AUTOMATIC RATING
 * ─────────────────
 * Ratings are fully automatic — no LLM instruction needed. The plugin derives
 * a quality signal from observable outcomes:
 *
 *   retry_count   — RetryPart events within the sub-agent's message window
 *   error         — AssistantMessage.error present → automatic score cap of 2
 *   finish_reason — "length" (truncated) → score penalty
 *
 * These produce an inferred_quality (1–5) used in composite scoring. Users or
 * agents can still override with rate_last_task for a human/LLM quality score.
 *
 * COMPOSITE SCORE (0–1)
 * ─────────────────────
 *   quality   (50%) — inferred or manual rating, normalised from 1–5 → 0–1
 *   efficiency (30%) — output_tokens / (input_tokens + output_tokens)
 *   speed     (20%) — 1 − (duration_ms / 120_000), capped 0–1
 *
 * PERSISTENCE
 * ───────────
 * Records are persisted in sqlite via store.js.
 */

import { tool } from "@opencode-ai/plugin";
import { startService } from "./service.js";
import { PERFORMANCE_DB_PATH } from "./paths.js";
import {
  appendPerformanceRecordOnce,
  getPerformanceRecordById,
  updatePerformanceRecord,
} from "./store.js";

// ---------------------------------------------------------------------------
// Performance store path
// ---------------------------------------------------------------------------

// Mutable so tests can redirect writes to a temp sqlite DB without touching
// the real store. See configureStorePathsForTest / resetStorePathsForTest.
let activeDbPath = PERFORMANCE_DB_PATH;

/**
 * Test-only: redirect store I/O to the given paths. Call resetStorePathsForTest
 * in afterEach to restore production paths.
 */
export function configureStorePathsForTest({ dbPath, storePath, tmpPath } = {}) {
  if (typeof dbPath === "string" && dbPath.length > 0) {
    activeDbPath = dbPath;
  }

  // Tolerate legacy callers passing JSON path keys without using them.
  void storePath;
  void tmpPath;
}

/** Test-only: restore store paths to production defaults. */
export function resetStorePathsForTest() {
  activeDbPath = PERFORMANCE_DB_PATH;
  lastRecordBySession.clear();
}

// ---------------------------------------------------------------------------
// Store helpers
// ---------------------------------------------------------------------------

async function appendRecordOnce(record) {
  return appendPerformanceRecordOnce(record, activeDbPath);
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function computeScores({ input, output, cache_read = 0, cache_write = 0, duration_ms, inferred_quality, manual_quality }) {
  // Efficiency = output / (input + cache_read + output).
  // cache_write is excluded: it is pre-paid infrastructure cost that does not
  // represent tokens the model actively processed during this inference call.
  // (cache_write IS included in record.tokens.effective_input for billing/cost.)
  const scoring_input = input + cache_read;
  const total      = scoring_input + output;
  const efficiency = total > 0 ? output / total : 0;
  const speed_cap  = 120_000;
  const speed      = Math.max(0, 1 - duration_ms / speed_cap);

  const quality_rating = manual_quality ?? inferred_quality;
  const q_norm = quality_rating !== null ? (quality_rating - 1) / 4 : null;

  const composite =
    q_norm !== null
      ? Math.round((q_norm * 0.5 + efficiency * 0.3 + speed * 0.2) * 10_000) / 10_000
      : null;

  return {
    efficiency:            Math.round(efficiency * 10_000) / 10_000,
    speed:                 Math.round(speed * 10_000) / 10_000,
    inferred_quality,
    manual_quality:        manual_quality ?? null,
    effective_quality:     quality_rating,
    composite,
  };
}

/**
 * Derive a quality score (1–5) from observable signals without LLM input.
 *
 * Signals (all from data already collected):
 *   - error present         → 1  (hard failure)
 *   - finish_reason=length  → penalise by 1 (truncated output)
 *   - retry_count > 0       → penalise by retry_count (each retry costs a point)
 *   - no issues             → 4  (optimistic default; 5 requires manual confirmation)
 */
function inferQuality({ has_error, finish_reason, retry_count }) {
  if (has_error) return 1;
  let score = 4;
  if (finish_reason === "length") score -= 1;
  score -= Math.min(retry_count, 2); // cap penalty at 2
  return Math.max(1, score);
}

/**
 * Build a performance record from a completed main-agent assistant message.
 * Records have source:"main" and id:`${sessionID}:${messageID}` to distinguish
 * them from sub-agent records whose id is `${parentSessionID}:${callID}`.
 */
export function recordFromAssistantMessage({ sessionID, messageID, assistant, retry_count = 0, event_agent = null }) {
  const duration_ms = assistant.time?.created != null && assistant.time?.completed != null
    ? assistant.time.completed - assistant.time.created
    : 0;

  const tokens = {
    input:       assistant.tokens?.input        ?? 0,
    output:      assistant.tokens?.output       ?? 0,
    reasoning:   assistant.tokens?.reasoning    ?? 0,
    cache_read:  assistant.tokens?.cache?.read  ?? 0,
    cache_write: assistant.tokens?.cache?.write ?? 0,
  };

  const has_error = !!assistant.error;
  const finish_reason = assistant.finish ?? null;
  const inferred_quality = inferQuality({ has_error, finish_reason, retry_count });
  const scores = computeScores({
    input:       tokens.input,
    output:      tokens.output,
    cache_read:  tokens.cache_read,
    cache_write: tokens.cache_write,
    duration_ms,
    inferred_quality,
    manual_quality: null,
  });

  const mainAgent =
    assistant?.agent ??
    assistant?.agentName ??
    assistant?.metadata?.agent ??
    event_agent ??
    "main";

  return {
    id:          `${sessionID}:${messageID}`,
    source:      "main",
    timestamp:   new Date(assistant.time?.completed ?? Date.now()).toISOString(),
    session_id:  sessionID,
    message_id:  messageID,
    call_id:     null,
    agent:       mainAgent,
    description: null,
    model_id:    assistant.modelID    ?? "unknown",
    provider_id: assistant.providerID ?? "unknown",
    tokens: {
      ...tokens,
      effective_input: tokens.input + tokens.cache_read + tokens.cache_write,
    },
    cost_usd:             assistant.cost ?? 0,
    duration_ms,
    finish_reason,
    has_error,
    retry_count,
    telemetry_session_id: sessionID,
    scores,
  };
}

// ---------------------------------------------------------------------------
// In-memory state — keyed on callID
// ---------------------------------------------------------------------------

/**
 * Pending sub-agent executions, populated in tool.execute.before, consumed in
 * tool.execute.after.
 *
 * Map<callID, { agent, sessionID, messageID, startMs, retryCount }>
 */
const pending = new Map();

/**
 * Subtask parts observed, keyed on sessionID → latest { agent, description }.
 * Populated from message.part.updated events before tool.execute.before fires.
 */
const latestSubtask = new Map();

/**
 * Retry counts per messageID, populated from RetryPart events.
 */
const retryCounts = new Map();

/**
 * Last written record ID per sessionID, for rate_last_task.
 */
const lastRecordBySession = new Map();

/**
 * Read-only accessor for tests: returns the last record ID tracked for a
 * given session. Does not expose the Map itself; avoids coupling tests to
 * internal mutable state.
 */
export function getLastRecordBySession(sessionID) {
  return lastRecordBySession.get(sessionID) ?? null;
}

let loggedServiceUrl = null;

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

export const id = "model-tracker";

/** @type {import("@opencode-ai/plugin").Plugin} */
export const server = async (input, _options) => {
  const client = input.client;

  // Start the admin UI service on first plugin load.
  let serviceUrl = null;
  try {
    const { url } = await startService({ port: 4747 });
    serviceUrl = url;
    if (loggedServiceUrl !== url) {
      loggedServiceUrl = url;
      process.stderr.write(`[model-tracker] Admin UI: ${url}\n`);
    }
  } catch (err) {
    process.stderr.write(`[model-tracker] Service failed to start: ${err?.message ?? err}\n`);
  }

  return {
    // -----------------------------------------------------------------------
    // Observe events: subtask parts, retry parts, completed messages
    // -----------------------------------------------------------------------
    async event({ event }) {

      // Track subtask dispatch — gives us agent name before the tool fires
      if (event.type === "message.part.updated") {
        const part = event.properties?.part;
        if (part?.type === "subtask") {
          latestSubtask.set(part.sessionID, {
            agent:       part.agent,
            description: part.description,
            messageID:   part.messageID,
          });
        }
        // Count retries within a message
        if (part?.type === "retry") {
          const key = `${part.sessionID}:${part.messageID}`;
          retryCounts.set(key, (retryCounts.get(key) ?? 0) + 1);
        }
      }

      if (event.type === "message.updated") {
        const info = event.properties?.info ?? event.properties?.message;
        if (info?.role === "assistant" && info.time?.completed) {
          const sessionID = info.sessionID ?? event.properties?.sessionID;
          const messageID = info.id;
          if (sessionID && messageID) {
            const retryKey = `${sessionID}:${messageID}`;
            const retry_count = retryCounts.get(retryKey) ?? 0;
            const event_agent =
              event.properties?.agent ??
              event.properties?.metadata?.agent ??
              null;
            const record = recordFromAssistantMessage({ sessionID, messageID, assistant: info, retry_count, event_agent });
            if (await appendRecordOnce(record)) {
              lastRecordBySession.set(sessionID, record.id);
            }
            retryCounts.delete(retryKey);
          }
        }
      }
    },

    // -----------------------------------------------------------------------
    // tool.execute.before — record start time when `task` tool is called
    // -----------------------------------------------------------------------
    async "tool.execute.before"(input_hook, output) {
      if (input_hook.tool !== "task") return;

      const { sessionID, callID } = input_hook;
      const subtask = latestSubtask.get(sessionID);

      // Primary source: subtask event cache (populated from message.part.updated).
      // Fallback: tool call args (output.args) carry subagent/agent fields that
      // the task tool sets directly — used when the event cache misses (e.g. the
      // subtask part arrived before the plugin was ready, or ordering variance).
      const args  = output?.args ?? {};
      const agent =
        subtask?.agent ??
        args.subagent_type ??
        args.subagent  ??
        args.agent     ??
        "unknown";

      const description = subtask?.description ?? args.description ?? null;

      pending.set(callID, {
        agent,
        description: typeof description === "string" ? description.slice(0, 200) : null,
        sessionID,
        startMs: Date.now(),
      });
    },

    // -----------------------------------------------------------------------
    // tool.execute.after — sub-agent has completed; write the record
    // -----------------------------------------------------------------------
    async "tool.execute.after"(input_hook, output) {
      if (input_hook.tool !== "task") return;

      const { sessionID, callID } = input_hook;
      const state = pending.get(callID);
      if (!state) return;
      pending.delete(callID);

      const duration_ms = Date.now() - state.startMs;

      // Guard: child session ID is required for subagent telemetry.
      // Without it, any fallback to the parent session would fetch the parent's
      // own assistant message and write a subagent row sharing the parent's
      // telemetry_session_id — causing token double-counting and key overlap.
      const childSessionID = output?.metadata?.sessionId ?? output?.metadata?.sessionID ?? null;
      if (!childSessionID) {
        process.stderr.write(
          `[model-tracker] skipping subagent record for callID=${callID}: ` +
          `output.metadata.sessionId missing — cannot determine child telemetry session\n`,
        );
        return;
      }

      const telemetrySessionID = childSessionID;

      // Fetch the most recent completed assistant message for this session
      // to get token counts and cost. The sub-agent's message is the latest
      // completed one at this point in the event stream.
      let tokens      = { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 };
      let cost_usd    = 0;
      let model_id    = "unknown";
      let provider_id = "unknown";
      let finish_reason = null;
      let has_error   = false;
      let messageID   = "unknown";

      // Metadata from task tool output is a reliable fallback for provider/model
      // even when message lookups fail.
      model_id = output?.metadata?.model?.modelID ?? model_id;
      provider_id = output?.metadata?.model?.providerID ?? provider_id;

      try {
        const resp = await client.session.messages({ path: { id: telemetrySessionID } });
        // SDK envelope: resp.data is Array<{ info: Message, parts: Part[] }>
        // Find the most recent completed assistant message.
        const items = resp?.data ?? [];
        const assistant = [...items]
          .reverse()
          .map((item) => item?.info)
          .find((m) => m?.role === "assistant" && m.time?.completed);

        if (assistant) {
          messageID     = assistant.id;
          model_id      = assistant.modelID    ?? "unknown";
          provider_id   = assistant.providerID ?? "unknown";
          cost_usd      = assistant.cost       ?? 0;
          finish_reason = assistant.finish     ?? null;
          has_error     = !!assistant.error;
          tokens = {
            input:       assistant.tokens?.input        ?? 0,
            output:      assistant.tokens?.output       ?? 0,
            reasoning:   assistant.tokens?.reasoning    ?? 0,
            cache_read:  assistant.tokens?.cache?.read  ?? 0,
            cache_write: assistant.tokens?.cache?.write ?? 0,
          };
        }
      } catch (err) {
        // Non-fatal — record with zeroed metrics rather than dropping entirely
        process.stderr.write(
          `[model-tracker] session.messages failed for ${telemetrySessionID}: ${err?.message ?? err}\n`
        );
      }

      const retryKey    = `${telemetrySessionID}:${messageID}`;
      const retry_count = retryCounts.get(retryKey) ?? 0;
      retryCounts.delete(retryKey);

      const inferred_quality = inferQuality({ has_error, finish_reason, retry_count });

      const scores = computeScores({
        input:     tokens.input,
        output:    tokens.output,
        cache_read: tokens.cache_read,
        cache_write: tokens.cache_write,
        duration_ms,
        inferred_quality,
        manual_quality: null,
      });

      const recordID = `${sessionID}:${callID}`;

      const record = {
        id:            recordID,
        source:        "subagent",
        timestamp:     new Date().toISOString(),
        session_id:    sessionID,
        message_id:    messageID,
        call_id:       callID,
        agent:         state.agent,
        description:   state.description,
        model_id,
        provider_id,
        tokens: {
          ...tokens,
          effective_input: tokens.input + tokens.cache_read + tokens.cache_write,
        },
        cost_usd,
        duration_ms,
        finish_reason,
        has_error,
        retry_count,
        telemetry_session_id: telemetrySessionID,
        scores,
      };

      if (await appendRecordOnce(record)) {
        lastRecordBySession.set(sessionID, recordID);
      }
    },

    // -----------------------------------------------------------------------
    // Tool: rate_last_task
    // Override the inferred quality score with a manual 1–5 rating.
    // Can be called by the user directly or by any agent.
    // -----------------------------------------------------------------------
    tool: {
      rate_last_task: tool({
        description:
          "Override the automatically inferred quality score for the most recent " +
          "main-agent or sub-agent task in this session with a manual rating (1–5). " +
          "Use this when you can assess output quality more precisely than the " +
          "automatic signals (retry count, errors, truncation) allow. " +
          "1 = rejected/harmful, 2 = major rework needed, 3 = partial/one rerun, " +
          "4 = minor gaps only, 5 = fully correct on first attempt.",
        args: {
          session_id: tool.schema
            .string()
            .describe("Current session ID."),
          rating: tool.schema
            .number()
            .min(1)
            .max(5)
            .describe("Manual quality score 1–5."),
          notes: tool.schema
            .string()
            .optional()
            .describe("One-line note: which agent, why this score."),
        },
        async execute({ session_id, rating, notes }) {
          const recordID = lastRecordBySession.get(session_id);
          if (!recordID) {
            return `No tracked main-agent or sub-agent record found for session ${session_id}.`;
          }

          const record = await getPerformanceRecordById(recordID, activeDbPath);
          if (!record) {
            return `Record ${recordID} not found in performance store.`;
          }

          record.scores = computeScores({
            input:          record.tokens.input,
            output:         record.tokens.output,
            cache_read:     record.tokens.cache_read,
            cache_write:    record.tokens.cache_write,
            duration_ms:    record.duration_ms,
            inferred_quality: record.scores.inferred_quality,
            manual_quality:   rating,
          });
          if (notes) record.notes = notes.slice(0, 200);

          await updatePerformanceRecord(record, activeDbPath);

          return (
            `Rated ${recordID}:\n` +
            `  agent:             ${record.agent}\n` +
            `  model:             ${record.model_id}\n` +
            `  inferred_quality:  ${record.scores.inferred_quality}/5\n` +
            `  manual_quality:    ${rating}/5\n` +
            `  composite:         ${record.scores.composite?.toFixed(4) ?? "n/a"}\n` +
            (notes ? `  notes:             ${notes.slice(0, 200)}\n` : "")
          );
        },
      }),

      model_tracker_status: tool({
        description:
          "Returns the URL of the model-tracker admin UI. Open it in a browser to " +
          "view stats, manage the model registry, and sync agent assignments.",
        args: {},
        async execute() {
          if (!serviceUrl) return "Model tracker service is not running.";
          return `Model tracker admin UI: ${serviceUrl}`;
        },
      }),
    },
  };
};

/** @type {import("@opencode-ai/plugin").PluginModule} */
export default { id, server };
