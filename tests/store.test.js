// tests/store.test.js
import { strict as assert } from "assert";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { test } from "node:test";
import {
  appendPerformanceRecordOnce,
  getPerformanceRecordById,
  initPerformanceStore,
  listPerformanceRecords,
  updatePerformanceRecord,
} from "../src/store.js";

async function withTempDb(run) {
  const dir = mkdtempSync(join(tmpdir(), "model-tracker-store-test-"));
  const dbPath = join(dir, "model-performance.sqlite");
  try {
    return await run(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function buildRecord(overrides = {}) {
  return {
    id: "rec-1",
    timestamp: "2026-04-27T12:00:00.000Z",
    agent: "main",
    session_id: "session-1",
    provider_id: "openai",
    model_id: "openai/gpt-5.3-codex",
    duration_ms: 1234,
    notes: "baseline note",
    tokens: {
      input: 101,
      cache_read: 11,
      cache_write: 7,
      output: 303,
      breakdown: { prompt: 50, completion: 303 },
    },
    scores: {
      quality: 4,
      speed: 5,
      composite: 0.91,
      nested: { confidence: 0.87 },
    },
    custom_extra: {
      flags: ["one", "two"],
      nested: { enabled: true, count: 3 },
    },
    ...overrides,
  };
}

test("initPerformanceStore creates an empty sqlite store", async () => {
  await withTempDb(async (dbPath) => {
    await initPerformanceStore(dbPath);
    const records = await listPerformanceRecords(dbPath);
    assert.deepStrictEqual(records, []);
  });
});

test("append/list/get round-trips representative record including nested and custom fields", async () => {
  await withTempDb(async (dbPath) => {
    const input = buildRecord();

    const inserted = await appendPerformanceRecordOnce(input, dbPath);
    assert.equal(inserted, true);

    const listed = await listPerformanceRecords(dbPath);
    assert.equal(listed.length, 1);
    assert.deepStrictEqual(listed[0], input);

    const fetched = await getPerformanceRecordById(input.id, dbPath);
    assert.deepStrictEqual(fetched, input);
  });
});

test("duplicate append by id is idempotent", async () => {
  await withTempDb(async (dbPath) => {
    const input = buildRecord();

    assert.equal(await appendPerformanceRecordOnce(input, dbPath), true);
    assert.equal(await appendPerformanceRecordOnce(input, dbPath), false);

    const listed = await listPerformanceRecords(dbPath);
    assert.equal(listed.length, 1);
    assert.deepStrictEqual(listed[0], input);
  });
});

test("updatePerformanceRecord replaces fields and persists latest values", async () => {
  await withTempDb(async (dbPath) => {
    const original = buildRecord();
    await appendPerformanceRecordOnce(original, dbPath);

    const updated = buildRecord({
      notes: "updated note",
      scores: {
        quality: 2,
        speed: 3,
        composite: 0.42,
        nested: { confidence: 0.21 },
      },
    });

    await updatePerformanceRecord(updated, dbPath);

    const fetched = await getPerformanceRecordById(original.id, dbPath);
    assert.deepStrictEqual(fetched, updated);
  });
});

test("invalid record validation rejects missing id or timestamp", async () => {
  await withTempDb(async (dbPath) => {
    await assert.rejects(() => appendPerformanceRecordOnce({ timestamp: "2026-04-27T12:00:00.000Z" }, dbPath));
    await assert.rejects(() => appendPerformanceRecordOnce({ id: "rec-2" }, dbPath));
  });
});

// Hardening: description and notes capped to 200 chars in metadata_json
test("description over 200 chars is truncated to 200 chars plus ellipsis in stored metadata_json", async () => {
  await withTempDb(async (dbPath) => {
    const longDescription = "A".repeat(250);
    const input = buildRecord({ id: "rec-trunc-desc", description: longDescription });
    await appendPerformanceRecordOnce(input, dbPath);

    const fetched = await getPerformanceRecordById("rec-trunc-desc", dbPath);
    assert.equal(fetched.description.length, 201);
    assert.ok(
      fetched.description.endsWith("…"),
      `Expected description to end with ellipsis but got: ${fetched.description.slice(-5)}`
    );
    assert.equal(fetched.description, "A".repeat(200) + "…");
  });
});

test("notes over 200 chars is truncated to 200 chars plus ellipsis in stored metadata_json", async () => {
  await withTempDb(async (dbPath) => {
    const longNotes = "B".repeat(300);
    const input = buildRecord({ id: "rec-trunc-notes", notes: longNotes });
    await appendPerformanceRecordOnce(input, dbPath);

    const fetched = await getPerformanceRecordById("rec-trunc-notes", dbPath);
    assert.equal(fetched.notes.length, 201);
    assert.ok(
      fetched.notes.endsWith("…"),
      `Expected notes to end with ellipsis but got: ${fetched.notes.slice(-5)}`
    );
    assert.equal(fetched.notes, "B".repeat(200) + "…");
  });
});

test("description and notes within 200 chars are stored as-is", async () => {
  await withTempDb(async (dbPath) => {
    const shortDesc = "Short description";
    const shortNotes = "Short notes";
    const input = buildRecord({ id: "rec-short", description: shortDesc, notes: shortNotes });
    await appendPerformanceRecordOnce(input, dbPath);

    const fetched = await getPerformanceRecordById("rec-short", dbPath);
    assert.equal(fetched.description, shortDesc);
    assert.equal(fetched.notes, shortNotes);
  });
});

test("nullish description and notes are persisted as null", async () => {
  await withTempDb(async (dbPath) => {
    const input = buildRecord({ id: "rec-nullish", description: undefined, notes: null });
    await appendPerformanceRecordOnce(input, dbPath);

    const fetched = await getPerformanceRecordById("rec-nullish", dbPath);
    assert.equal(fetched.description, null);
    assert.equal(fetched.notes, null);
  });
});
