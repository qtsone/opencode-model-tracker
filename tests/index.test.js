// tests/index.test.js
import { strict as assert } from "assert";
import { test, afterEach, before, describe } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  server,
  recordFromAssistantMessage,
  getLastRecordBySession,
  configureStorePathsForTest,
  resetStorePathsForTest,
} from "../src/index.js";
import { stopService } from "../src/service.js";
import { listPerformanceRecords } from "../src/store.js";

// ---------------------------------------------------------------------------
// Temp-store helpers
// ---------------------------------------------------------------------------

let tempDir;
let tempDb;

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), "model-tracker-test-"));
  tempDb = join(tempDir, "model-performance.sqlite");
});

// Before each test: redirect store I/O to the temp directory so no writes
// reach the real sqlite performance store.
// afterEach: restore production paths and tear down the singleton service.
afterEach(async () => {
  resetStorePathsForTest();
  await stopService();
});

function useTestStore() {
  configureStorePathsForTest({ dbPath: tempDb });
}

async function readTestStore() {
  return {
    version: 1,
    records: await listPerformanceRecords(tempDb),
  };
}

// ---------------------------------------------------------------------------
// Test 1: service URL deduplication (no store I/O needed)
// ---------------------------------------------------------------------------
test("server initialization logs the admin UI URL only once", async () => {
  useTestStore();

  const originalWrite = process.stderr.write;
  const lines = [];
  process.stderr.write = function write(chunk, ...args) {
    lines.push(String(chunk));
    if (typeof args.at(-1) === "function") args.at(-1)();
    return true;
  };

  try {
    const input = { client: { session: { messages: async () => ({ data: [] }) } } };
    const first  = await server(input, {});
    const second = await server(input, {});
    const third  = await server(input, {});

    first.tool.model_tracker_status.execute();
    second.tool.model_tracker_status.execute();
    third.tool.model_tracker_status.execute();
  } finally {
    process.stderr.write = originalWrite;
  }

  const adminLogs = lines.filter((l) => l.includes("[model-tracker] Admin UI:"));
  assert.equal(adminLogs.length, 1);
});

// ---------------------------------------------------------------------------
// Test 2: pure helper — no I/O, no server
// ---------------------------------------------------------------------------
test("recordFromAssistantMessage creates a main-source record", () => {
  const record = recordFromAssistantMessage({
    sessionID: "ses-main-1",
    messageID: "msg-main-1",
    assistant: {
      id: "msg-main-1",
      role: "assistant",
      modelID: "openai/gpt-5.3-codex",
      providerID: "openai",
      cost: 0,
      finish: "stop",
      error: null,
      time: { created: 1000, completed: 2500 },
      tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 300, write: 400 } },
    },
    retry_count: 0,
  });

  assert.equal(record.id, "ses-main-1:msg-main-1");
  assert.equal(record.source, "main");
  assert.equal(record.agent, "main");
  assert.equal(record.session_id, "ses-main-1");
  assert.equal(record.message_id, "msg-main-1");
  assert.equal(record.duration_ms, 1500);
  assert.equal(record.tokens.effective_input, 800);
  assert.equal(record.model_id, "openai/gpt-5.3-codex");
  assert.equal(record.provider_id, "openai");
  assert.equal(record.cost_usd, 0);
  assert.equal(record.finish_reason, "stop");
  assert.equal(record.has_error, false);
  assert.equal(record.call_id, null);
});

test("recordFromAssistantMessage preserves source main while using assistant agent when present", () => {
  const record = recordFromAssistantMessage({
    sessionID: "ses-main-agent-1",
    messageID: "msg-main-agent-1",
    assistant: {
      id: "msg-main-agent-1",
      role: "assistant",
      agent: "Technical-Lead",
      modelID: "openai/gpt-5.3-codex",
      providerID: "openai",
      cost: 0,
      finish: "stop",
      error: null,
      time: { created: 1000, completed: 2000 },
      tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    retry_count: 0,
  });

  assert.equal(record.source, "main");
  assert.equal(record.agent, "Technical-Lead");
});

// ---------------------------------------------------------------------------
// Test 3: event hook appends a main record to the temp store
// ---------------------------------------------------------------------------
test("event hook records completed main assistant messages", async () => {
  useTestStore();

  const sessionID = "ses-event-test-1";
  const messageID = "msg-event-test-1";

  const plugin = await server(
    { client: { session: { messages: async () => ({ data: [] }) } } },
    {},
  );

  // No record tracked yet for this session
  assert.equal(getLastRecordBySession(sessionID), null);

  await plugin.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: messageID,
          role: "assistant",
          agent: "Plan",
          sessionID,
          modelID: "openai/gpt-5.3-codex",
          providerID: "openai",
          cost: 0,
          finish: "stop",
          time: { created: 1000, completed: 2500 },
          tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 300, write: 400 } },
        },
      },
    },
  });

  // In-memory tracker updated
  const expectedID = `${sessionID}:${messageID}`;
  assert.equal(getLastRecordBySession(sessionID), expectedID);

  // Record written to temp store — NOT the real store
  const store = await readTestStore();
  const written = store.records.find((r) => r.id === expectedID);
  assert.ok(written, `record ${expectedID} not found in temp store`);
  assert.equal(written.source, "main");
  assert.equal(written.agent, "Plan");
  assert.equal(written.session_id, sessionID);
  assert.equal(written.tokens.effective_input, 800);
  assert.equal(written.model_id, "openai/gpt-5.3-codex");

  // Idempotency: second event with same ID must not duplicate
  await plugin.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: messageID,
          role: "assistant",
          agent: "Plan",
          sessionID,
          modelID: "openai/gpt-5.3-codex",
          providerID: "openai",
          cost: 0,
          finish: "stop",
          time: { created: 1000, completed: 2500 },
          tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 300, write: 400 } },
        },
      },
    },
  });
  const storeAfter = await readTestStore();
  const matches = storeAfter.records.filter((r) => r.id === expectedID);
  assert.equal(matches.length, 1, "duplicate record written on second event");
});

// ---------------------------------------------------------------------------
// Test 4: rate_last_task works end-to-end on a main-agent record
// ---------------------------------------------------------------------------
test("rate_last_task updates manual quality on a main-agent record", async () => {
  useTestStore();

  const sessionID = "ses-rate-test-1";
  const messageID = "msg-rate-test-1";

  const plugin = await server(
    { client: { session: { messages: async () => ({ data: [] }) } } },
    {},
  );

  // Append a main record via the event hook (writes to temp store)
  await plugin.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: messageID,
          role: "assistant",
          sessionID,
          modelID: "openai/gpt-5.3-codex",
          providerID: "openai",
          cost: 0,
          finish: "stop",
          time: { created: 1000, completed: 2000 },
          tokens: { input: 50, output: 80, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    },
  });

  const trackedID = getLastRecordBySession(sessionID);
  assert.equal(trackedID, `${sessionID}:${messageID}`);

  // Apply a manual rating
  const result = await plugin.tool.rate_last_task.execute({
    session_id: sessionID,
    rating: 5,
    notes: "test: perfect run",
  });

  // Output string checks
  assert.ok(result.includes(trackedID),  `result missing record ID:\n${result}`);
  assert.ok(result.includes("main"),     `result missing agent "main":\n${result}`);
  assert.ok(result.includes("5"),        `result missing rating 5:\n${result}`);
  assert.ok(result.includes("test: perfect run"), `result missing notes:\n${result}`);

  // Verify the record in the temp store has manual_quality=5
  const store  = await readTestStore();
  const record = store.records.find((r) => r.id === trackedID);
  assert.ok(record, "record not found in temp store after rating");
  assert.equal(record.scores.manual_quality, 5);
  assert.equal(record.scores.effective_quality, 5);
  assert.equal(record.agent, "main");

  const allRecords = await listPerformanceRecords(tempDb);
  const matches = allRecords.filter((r) => r.id === trackedID);
  assert.equal(matches.length, 1, "rated record should persist in sqlite exactly once");
});

// ---------------------------------------------------------------------------
// Test 5 (BUG-1): duration must be correct when assistant.time.created === 0
// ---------------------------------------------------------------------------
test("recordFromAssistantMessage computes duration correctly when created is 0", () => {
  const record = recordFromAssistantMessage({
    sessionID: "ses-bug1",
    messageID: "msg-bug1",
    assistant: {
      id: "msg-bug1",
      role: "assistant",
      modelID: "openai/gpt-4",
      providerID: "openai",
      cost: 0,
      finish: "stop",
      error: null,
      // created === 0 is a valid Unix epoch value; falsy guard treats it as missing
      time: { created: 0, completed: 1500 },
      tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    retry_count: 0,
  });

  assert.equal(record.duration_ms, 1500);
});

// ---------------------------------------------------------------------------
// Test 6 (BUG-2): cache_write must not deflate efficiency score
// cache_write is pre-paid infrastructure cost, not a token the model "read"
// during inference; including it in the efficiency denominator unfairly
// penalises cache-heavy workloads.
// ---------------------------------------------------------------------------
test("computeScores efficiency is not deflated by large cache_write", () => {
  // 100 input + 0 cache_read + 0 cache_write, 100 output → efficiency = 0.5
  const record_no_cache = recordFromAssistantMessage({
    sessionID: "ses-bug2a",
    messageID: "msg-bug2a",
    assistant: {
      id: "msg-bug2a",
      role: "assistant",
      modelID: "openai/gpt-4",
      providerID: "openai",
      cost: 0,
      finish: "stop",
      error: null,
      time: { created: 0, completed: 1000 },
      tokens: { input: 100, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    retry_count: 0,
  });

  // Same output ratio, but a large cache_write — efficiency should be the same
  const record_heavy_write = recordFromAssistantMessage({
    sessionID: "ses-bug2b",
    messageID: "msg-bug2b",
    assistant: {
      id: "msg-bug2b",
      role: "assistant",
      modelID: "openai/gpt-4",
      providerID: "openai",
      cost: 0,
      finish: "stop",
      error: null,
      time: { created: 0, completed: 1000 },
      tokens: { input: 100, output: 100, reasoning: 0, cache: { read: 0, write: 10000 } },
    },
    retry_count: 0,
  });

  assert.equal(
    record_no_cache.scores.efficiency,
    record_heavy_write.scores.efficiency,
    "efficiency should not be deflated by cache_write",
  );
  // Sanity-check the baseline value: output/(input+output) = 100/200 = 0.5
  assert.equal(record_no_cache.scores.efficiency, 0.5);
});

// ---------------------------------------------------------------------------
// Test 7 (GUARDRAIL): missing child session ID must not produce a subagent record
//
// Root cause: when output.metadata.sessionId is absent, childSessionID is null
// and the code falls back to the parent sessionID. It then fetches the parent's
// completed assistant message and writes a subagent row whose telemetry_session_id
// equals the parent session — causing token double-counting with the main record.
//
// Expected: no subagent performance record is appended when child session
// metadata is missing, even when the parent session has a completed message.
// ---------------------------------------------------------------------------
test("tool.execute.after skips subagent record when child session ID is missing", async () => {
  useTestStore();

  const parentSessionID = "ses-guardrail-parent-1";
  const parentMessageID = "msg-guardrail-parent-1";
  const callID = "call-guardrail-1";

  // Parent session has a completed assistant message that would be fetched
  // if the fallback incorrectly uses the parent session ID.
  const parentAssistantMessage = {
    id: parentMessageID,
    role: "assistant",
    sessionID: parentSessionID,
    modelID: "openai/gpt-5.3-codex",
    providerID: "openai",
    cost: 0.05,
    finish: "stop",
    error: null,
    time: { created: 1000, completed: 3000 },
    tokens: { input: 500, output: 300, reasoning: 0, cache: { read: 0, write: 0 } },
  };

  const stderrLines = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = function write(chunk, ...args) {
    stderrLines.push(String(chunk));
    if (typeof args.at(-1) === "function") args.at(-1)();
    return true;
  };

  let plugin;
  try {
    plugin = await server(
      {
        client: {
          session: {
            messages: async ({ path: { id } }) => {
              // Only the parent session has messages
              if (id === parentSessionID) {
                return { data: [{ info: parentAssistantMessage, parts: [] }] };
              }
              return { data: [] };
            },
          },
        },
      },
      {},
    );

    // Simulate tool.execute.before: track a task call in the parent session
    await plugin["tool.execute.before"](
      { tool: "task", sessionID: parentSessionID, callID },
      { args: { agent: "implementer", description: "do some work" } },
    );

    // Simulate tool.execute.after: output has NO child session metadata
    await plugin["tool.execute.after"](
      { tool: "task", sessionID: parentSessionID, callID },
      {
        // Intentionally no metadata.sessionId / metadata.sessionID
        metadata: {},
      },
    );
  } finally {
    process.stderr.write = originalWrite;
  }

  // The store must contain no subagent record for this call
  const store = await readTestStore();
  const subagentRecords = store.records.filter((r) => r.source === "subagent");
  assert.equal(
    subagentRecords.length,
    0,
    `Expected no subagent records, but found: ${JSON.stringify(subagentRecords.map((r) => r.id))}`,
  );

  // A warning should have been emitted about the missing child session
  const warned = stderrLines.some(
    (l) => l.includes("[model-tracker]") && l.includes(callID),
  );
  assert.ok(warned, `Expected a stderr warning mentioning callID ${callID}, got:\n${stderrLines.join("")}`);
});

// ---------------------------------------------------------------------------
// Test 8 (GUARDRAIL): valid child session persists a correct subagent record
//
// When output.metadata.sessionId points to a real child session, the subagent
// record must use the child session's telemetry data, not the parent's.
// ---------------------------------------------------------------------------
test("tool.execute.after persists subagent record with child session telemetry when child session ID is present", async () => {
  useTestStore();

  const parentSessionID  = "ses-guardrail-parent-2";
  const childSessionID   = "ses-guardrail-child-2";
  const childMessageID   = "msg-guardrail-child-2";
  const callID           = "call-guardrail-2";
  const longDescription  = "D".repeat(260);

  const childAssistantMessage = {
    id: childMessageID,
    role: "assistant",
    sessionID: childSessionID,
    modelID: "anthropic/claude-sonnet",
    providerID: "anthropic",
    cost: 0.02,
    finish: "stop",
    error: null,
    time: { created: 2000, completed: 5000 },
    tokens: { input: 400, output: 200, reasoning: 0, cache: { read: 100, write: 50 } },
  };

  const plugin = await server(
    {
      client: {
        session: {
          messages: async ({ path: { id } }) => {
            if (id === childSessionID) {
              return { data: [{ info: childAssistantMessage, parts: [] }] };
            }
            return { data: [] };
          },
        },
      },
    },
    {},
  );

  // Simulate tool.execute.before
  await plugin["tool.execute.before"](
    { tool: "task", sessionID: parentSessionID, callID },
    { args: { agent: "implementer", description: longDescription } },
  );

  // Simulate tool.execute.after: output has valid child session metadata
  await plugin["tool.execute.after"](
    { tool: "task", sessionID: parentSessionID, callID },
    {
      metadata: {
        sessionId: childSessionID,
        model: { modelID: "anthropic/claude-sonnet", providerID: "anthropic" },
      },
    },
  );

  const store = await readTestStore();
  const subagentRecords = store.records.filter((r) => r.source === "subagent");
  assert.equal(subagentRecords.length, 1, "Expected exactly one subagent record");

  const rec = subagentRecords[0];
  assert.equal(rec.source, "subagent");
  assert.equal(rec.session_id, parentSessionID,  "session_id must be the parent session");
  assert.equal(rec.telemetry_session_id, childSessionID, "telemetry_session_id must be the child session");
  assert.equal(rec.message_id, childMessageID,   "message_id must be the child message");
  assert.equal(rec.call_id, callID);
  assert.equal(rec.description.length, 200);
  assert.equal(rec.description, "D".repeat(200));
  assert.equal(rec.tokens.input, 400);
  assert.equal(rec.tokens.output, 200);
  assert.equal(rec.tokens.cache_read, 100);
  assert.equal(rec.tokens.effective_input, 550); // 400 + 100 + 50
  assert.equal(rec.cost_usd, 0.02);
  assert.equal(rec.model_id, "anthropic/claude-sonnet");
});

// ---------------------------------------------------------------------------
// Test 9 (NOTES CAP): rate_last_task must cap notes at 200 characters
// ---------------------------------------------------------------------------
test("rate_last_task stores notes capped at 200 characters when input exceeds 200 chars", async () => {
  useTestStore();

  const sessionID = "ses-notes-cap-1";
  const messageID = "msg-notes-cap-1";

  const plugin = await server(
    { client: { session: { messages: async () => ({ data: [] }) } } },
    {},
  );

  // Append a main record via the event hook
  await plugin.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: messageID,
          role: "assistant",
          sessionID,
          modelID: "openai/gpt-4",
          providerID: "openai",
          cost: 0,
          finish: "stop",
          time: { created: 0, completed: 1000 },
          tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    },
  });

  const trackedID = getLastRecordBySession(sessionID);
  assert.ok(trackedID, "record must be tracked before rating");

  // Notes with exactly 260 characters (exceeds 200-char cap)
  const longNotes = "A".repeat(260);
  assert.equal(longNotes.length, 260);

  await plugin.tool.rate_last_task.execute({
    session_id: sessionID,
    rating: 3,
    notes: longNotes,
  });

  // Verify the record in the temp store has notes capped at 200 chars
  const allRecords = await listPerformanceRecords(tempDb);
  const record = allRecords.find((r) => r.id === trackedID);
  assert.ok(record, "record not found in temp store after rating with long notes");
  assert.ok(
    typeof record.notes === "string",
    "notes must be a string"
  );
  assert.equal(
    record.notes.length,
    200,
    `notes must be capped at 200 chars, but stored length is ${record.notes.length}`
  );
  assert.equal(
    record.notes,
    "A".repeat(200),
    "stored notes must equal first 200 chars of input"
  );
});
