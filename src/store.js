// src/store.js
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PERFORMANCE_DB_PATH } from "./paths.js";

const CREATE_PERFORMANCE_RECORDS_SQL = `
CREATE TABLE IF NOT EXISTS performance_records (
  id INTEGER PRIMARY KEY,
  record_id TEXT NOT NULL UNIQUE,
  timestamp TEXT NOT NULL,
  session_id TEXT,
  source TEXT,
  provider_id TEXT,
  model_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  cost_usd REAL,
  quality_score REAL,
  duration_ms INTEGER,
  metadata_json TEXT NOT NULL
)`;

// description and notes live only in metadata_json; they are not stored in
// dedicated columns. They are sanitized here before serialization to prevent
// unbounded growth in the database.
const METADATA_TEXT_MAX_LENGTH = 200;

export class PerformanceStoreError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "PerformanceStoreError";
  }
}

let sqliteBackendPromise = null;

function normalizeDbPath(dbPath) {
  return dbPath ?? PERFORMANCE_DB_PATH;
}

async function loadSqliteBackend() {
  if (!sqliteBackendPromise) {
    sqliteBackendPromise = loadSqliteBackendOnce();
  }
  return sqliteBackendPromise;
}

async function loadSqliteBackendOnce() {
  try {
    if (typeof Bun !== "undefined") {
      const mod = await import("bun:sqlite");
      return {
        runtime: "bun",
        open(dbPath) {
          return new mod.Database(dbPath);
        },
      };
    }

    const mod = await import("node:sqlite");
    return {
      runtime: "node",
      open(dbPath) {
        return new mod.DatabaseSync(dbPath);
      },
    };
  } catch (cause) {
    throw new PerformanceStoreError("No supported sqlite backend is available", { cause });
  }
}

async function withDb(dbPath, callback) {
  const resolvedPath = normalizeDbPath(dbPath);

  try {
    mkdirSync(dirname(resolvedPath), { recursive: true });
    const backend = await loadSqliteBackend();
    const db = backend.open(resolvedPath);

    try {
      db.exec(CREATE_PERFORMANCE_RECORDS_SQL);
      return await callback(db);
    } finally {
      db.close();
    }
  } catch (cause) {
    if (cause instanceof PerformanceStoreError) {
      throw cause;
    }

    const message = cause instanceof Error ? cause.message : String(cause);
    throw new PerformanceStoreError(`performance store failure: ${message}`, { cause });
  }
}

function validateRecord(record) {
  if (!record || typeof record !== "object") {
    throw new Error("record must be an object");
  }
  if (typeof record.id !== "string" || record.id.length === 0) {
    throw new Error("record.id must be a non-empty string");
  }
  if (typeof record.timestamp !== "string" || record.timestamp.length === 0) {
    throw new Error("record.timestamp must be a non-empty string");
  }
}

/**
 * Truncate a string field to METADATA_TEXT_MAX_LENGTH characters, appending
 * "…" when truncation occurs. Returns null for nullish values and returns
 * other non-string values unchanged. Returns strings unchanged when they are
 * string or is within the limit.
 * @param {unknown} value
 * @returns {unknown}
 */
function truncateTextField(value) {
  if (typeof value !== "string") return value ?? null;
  if (value.length <= METADATA_TEXT_MAX_LENGTH) return value;
  return `${value.slice(0, METADATA_TEXT_MAX_LENGTH)}…`;
}

/**
 * Sanitize metadata fields before JSON serialization.
 * description and notes are capped to METADATA_TEXT_MAX_LENGTH characters.
 * @param {object} record
 * @returns {object}
 */
function sanitizeMetadata(record) {
  const hasDescription = Object.hasOwn(record, "description");
  const hasNotes = Object.hasOwn(record, "notes");
  if (!hasDescription && !hasNotes) return record;

  const sanitized = { ...record };
  if (hasDescription) {
    sanitized.description = truncateTextField(record.description);
  }
  if (hasNotes) {
    sanitized.notes = truncateTextField(record.notes);
  }
  return sanitized;
}

function toRow(record) {
  validateRecord(record);

  const effectiveInput = record.tokens?.effective_input;
  const output = record.tokens?.output;
  const hasAnyTokenValue = typeof effectiveInput === "number" || typeof output === "number";

  // Sanitize text fields before persistence; description/notes live only in metadata_json.
  const sanitized = sanitizeMetadata(record);

  return {
    record_id: record.id,
    timestamp: record.timestamp,
    session_id: record.session_id ?? null,
    source: record.source ?? null,
    provider_id: record.provider_id ?? null,
    model_id: record.model_id ?? null,
    input_tokens: typeof record.tokens?.input === "number" ? record.tokens.input : null,
    output_tokens: typeof output === "number" ? output : null,
    total_tokens: hasAnyTokenValue ? (effectiveInput ?? 0) + (output ?? 0) : null,
    cost_usd: typeof record.cost_usd === "number" ? record.cost_usd : null,
    quality_score: typeof record.scores?.effective_quality === "number" ? record.scores.effective_quality : null,
    duration_ms: typeof record.duration_ms === "number" ? record.duration_ms : null,
    metadata_json: JSON.stringify(sanitized),
  };
}

function fromRow(row) {
  return JSON.parse(row.metadata_json);
}

export async function initPerformanceStore(dbPath = PERFORMANCE_DB_PATH) {
  await withDb(dbPath, () => undefined);
}

export async function appendPerformanceRecordOnce(record, dbPath = PERFORMANCE_DB_PATH) {
  const row = toRow(record);

  return withDb(dbPath, (db) => {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO performance_records (
        record_id,
        timestamp,
        session_id,
        source,
        provider_id,
        model_id,
        input_tokens,
        output_tokens,
        total_tokens,
        cost_usd,
        quality_score,
        duration_ms,
        metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      row.record_id,
      row.timestamp,
      row.session_id,
      row.source,
      row.provider_id,
      row.model_id,
      row.input_tokens,
      row.output_tokens,
      row.total_tokens,
      row.cost_usd,
      row.quality_score,
      row.duration_ms,
      row.metadata_json,
    );

    return result.changes === 1;
  });
}

export async function getPerformanceRecordById(id, dbPath = PERFORMANCE_DB_PATH) {
  return withDb(dbPath, (db) => {
    const row = db
      .prepare("SELECT metadata_json FROM performance_records WHERE record_id = ?")
      .get(id);

    return row ? fromRow(row) : null;
  });
}

export async function updatePerformanceRecord(record, dbPath = PERFORMANCE_DB_PATH) {
  const row = toRow(record);

  return withDb(dbPath, (db) => {
    const result = db
      .prepare(`
        UPDATE performance_records
        SET
          timestamp = ?,
          session_id = ?,
          source = ?,
          provider_id = ?,
          model_id = ?,
          input_tokens = ?,
          output_tokens = ?,
          total_tokens = ?,
          cost_usd = ?,
          quality_score = ?,
          duration_ms = ?,
          metadata_json = ?
        WHERE record_id = ?
      `)
      .run(
        row.timestamp,
        row.session_id,
        row.source,
        row.provider_id,
        row.model_id,
        row.input_tokens,
        row.output_tokens,
        row.total_tokens,
        row.cost_usd,
        row.quality_score,
        row.duration_ms,
        row.metadata_json,
        row.record_id,
      );

    if (result.changes !== 1) {
      throw new PerformanceStoreError(`record ${row.record_id} not found in performance store`);
    }
  });
}

export async function listPerformanceRecords(dbPath = PERFORMANCE_DB_PATH) {
  return withDb(dbPath, (db) =>
    db
      .prepare("SELECT metadata_json FROM performance_records ORDER BY id ASC")
      .all()
      .map(fromRow),
  );
}
