// model-tracker/tests/registry.test.js
import { strict as assert } from "assert";
import { test } from "node:test";
import { join, dirname } from "path";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { loadRegistry, saveRegistry, validateRegistry } from "../src/registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = dirname(__dirname);

const VALID_REGISTRY = {
  models: {
    "openai/gpt-4": {
      provider: "openai",
      name: "GPT-4",
      context_window: 8192,
      cost: { input_per_1m: 0.01, output_per_1m: 0.03 },
      strengths: ["reasoning"],
    },
  },
  agent_assignments: { "test-agent": "openai/gpt-4" },
  ab_test_candidates: {},
};

test("loadRegistry returns valid registry from file", () => {
  const dir = mkdtempSync(join(tmpdir(), "reg-"));
  const file = join(dir, "models.json");
  writeFileSync(file, JSON.stringify(VALID_REGISTRY));
  const result = loadRegistry(file);
  assert.deepStrictEqual(result, VALID_REGISTRY);
  rmSync(dir, { recursive: true });
});

test("loadRegistry throws on missing file", () => {
  assert.throws(() => loadRegistry("/nonexistent/models.json"), /not found|ENOENT/i);
});

test("loadRegistry throws on invalid JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "reg-"));
  const file = join(dir, "models.json");
  writeFileSync(file, "{ bad json");
  assert.throws(() => loadRegistry(file), /invalid json|JSON/i);
  rmSync(dir, { recursive: true });
});

test("saveRegistry writes atomically and loadRegistry reads it back", () => {
  const dir = mkdtempSync(join(tmpdir(), "reg-"));
  const file = join(dir, "models.json");
  saveRegistry(VALID_REGISTRY, file);
  const result = loadRegistry(file);
  assert.deepStrictEqual(result, VALID_REGISTRY);
  rmSync(dir, { recursive: true });
});

test("validateRegistry returns no errors for valid registry", () => {
  const errors = validateRegistry(VALID_REGISTRY);
  assert.deepStrictEqual(errors, []);
});

test("validateRegistry errors on missing models key", () => {
  const errors = validateRegistry({ agent_assignments: {}, ab_test_candidates: {} });
  assert.ok(errors.some(e => /models/.test(e)));
});

test("validateRegistry errors when assignment references unknown model", () => {
  const reg = { ...VALID_REGISTRY, agent_assignments: { "agent-x": "openai/does-not-exist" } };
  const errors = validateRegistry(reg);
  assert.ok(errors.some(e => /does-not-exist/.test(e)));
});

test("validateRegistry errors on model missing required fields", () => {
  const reg = {
    models: { "openai/bad": { provider: "openai" } }, // missing name, context_window, cost, strengths
    agent_assignments: {},
    ab_test_candidates: {},
  };
  const errors = validateRegistry(reg);
  assert.ok(errors.length > 0);
});

test("validateRegistry accepts per-1M cost keys", () => {
  const errors = validateRegistry(VALID_REGISTRY);
  assert.deepStrictEqual(errors, []);
});

test("validateRegistry rejects stale per-1k cost keys", () => {
  const reg = {
    ...VALID_REGISTRY,
    models: {
      "openai/gpt-4": {
        ...VALID_REGISTRY.models["openai/gpt-4"],
        cost: { input_per_1k: 0.01, output_per_1k: 0.03 },
      },
    },
  };
  const errors = validateRegistry(reg);
  assert.ok(errors.some(e => /input_per_1m/.test(e)));
  assert.ok(errors.some(e => /output_per_1m/.test(e)));
  assert.ok(errors.some(e => /input_per_1k/.test(e)));
});

// Fix 2 & 3: cost value validation — reject numeric strings, accept number or "free"
test("validateRegistry rejects numeric string cost values", () => {
  const reg = {
    ...VALID_REGISTRY,
    models: {
      "openai/gpt-4": {
        ...VALID_REGISTRY.models["openai/gpt-4"],
        cost: { input_per_1m: "2", output_per_1m: "30" },
      },
    },
  };
  const errors = validateRegistry(reg);
  assert.ok(errors.some(e => /input_per_1m/.test(e) && /number|free/.test(e)));
  assert.ok(errors.some(e => /output_per_1m/.test(e) && /number|free/.test(e)));
});

test("validateRegistry accepts cost value of 0", () => {
  const reg = {
    ...VALID_REGISTRY,
    models: {
      "openai/gpt-4": {
        ...VALID_REGISTRY.models["openai/gpt-4"],
        cost: { input_per_1m: 0, output_per_1m: 0 },
      },
    },
  };
  assert.deepStrictEqual(validateRegistry(reg), []);
});

test('validateRegistry accepts cost value of "free"', () => {
  const reg = {
    ...VALID_REGISTRY,
    models: {
      "openai/gpt-4": {
        ...VALID_REGISTRY.models["openai/gpt-4"],
        cost: { input_per_1m: "free", output_per_1m: "free" },
      },
    },
  };
  assert.deepStrictEqual(validateRegistry(reg), []);
});

test("validateRegistry accepts optional cache cost fields as finite numbers or free", () => {
  const reg = {
    ...VALID_REGISTRY,
    models: {
      "openai/gpt-4": {
        ...VALID_REGISTRY.models["openai/gpt-4"],
        cost: {
          input_per_1m: 1,
          cache_read_per_1m: 0.1,
          cache_write_per_1m: 1,
          cache_write_5m_per_1m: 1.5,
          cache_write_1h_per_1m: "free",
          output_per_1m: 3,
        },
      },
    },
  };
  assert.deepStrictEqual(validateRegistry(reg), []);
});

test("validateRegistry rejects invalid optional cache cost fields", () => {
  const reg = {
    ...VALID_REGISTRY,
    models: {
      "openai/gpt-4": {
        ...VALID_REGISTRY.models["openai/gpt-4"],
        cost: {
          input_per_1m: 1,
          cache_read_per_1m: "0.1",
          cache_write_per_1m: Infinity,
          cache_write_5m_per_1m: null,
          cache_write_1h_per_1m: {},
          output_per_1m: 3,
        },
      },
    },
  };
  const errors = validateRegistry(reg);
  assert.ok(errors.some(e => /cache_read_per_1m/.test(e)));
  assert.ok(errors.some(e => /cache_write_per_1m/.test(e)));
  assert.ok(errors.some(e => /cache_write_5m_per_1m/.test(e)));
  assert.ok(errors.some(e => /cache_write_1h_per_1m/.test(e)));
});

// Fix 4: integration test against actual models.json (skipped when file is absent)
test("validateRegistry returns no errors for actual models.json", { skip: !existsSync(join(PROJECT_DIR, "models.json")) }, () => {
  const modelsPath = join(PROJECT_DIR, "models.json");
  const registry = loadRegistry(modelsPath);
  const errors = validateRegistry(registry);
  assert.deepStrictEqual(errors, [], `models.json validation errors:\n${errors.join("\n")}`);
});

// Fix 5: saveRegistry cleans up .tmp file on failure
test("saveRegistry cleans up .tmp file when write fails", () => {
  // Use a target inside a nonexistent subdirectory so writeFileSync on the .tmp path
  // throws ENOENT — no .tmp file is ever created, and none should be left behind.
  const dir = mkdtempSync(join(tmpdir(), "reg-save-"));
  const nonexistentSubdir = join(dir, "missing");
  const target = join(nonexistentSubdir, "models.json");
  const tmp = target + ".tmp";

  assert.throws(() => saveRegistry(VALID_REGISTRY, target), /ENOENT|no such file/i);
  assert.equal(existsSync(tmp), false);
  rmSync(dir, { recursive: true });
});

// Fix 6: Array.isArray guards — arrays must be rejected for top-level object keys
test("validateRegistry rejects array as models value", () => {
  const reg = { models: [], agent_assignments: {}, ab_test_candidates: {} };
  const errors = validateRegistry(reg);
  assert.ok(errors.some(e => /models/.test(e)));
});

test("validateRegistry rejects array as agent_assignments value", () => {
  const reg = { ...VALID_REGISTRY, agent_assignments: [] };
  const errors = validateRegistry(reg);
  assert.ok(errors.some(e => /agent_assignments/.test(e)));
});

test("validateRegistry rejects array as ab_test_candidates value", () => {
  const reg = { ...VALID_REGISTRY, ab_test_candidates: [] };
  const errors = validateRegistry(reg);
  assert.ok(errors.some(e => /ab_test_candidates/.test(e)));
});

// Fix 7: context_window must be a positive integer
test("validateRegistry rejects non-integer context_window", () => {
  const reg = {
    ...VALID_REGISTRY,
    models: {
      "openai/gpt-4": { ...VALID_REGISTRY.models["openai/gpt-4"], context_window: 8192.5 },
    },
  };
  const errors = validateRegistry(reg);
  assert.ok(errors.some(e => /context_window/.test(e)));
});

test("validateRegistry rejects zero context_window", () => {
  const reg = {
    ...VALID_REGISTRY,
    models: {
      "openai/gpt-4": { ...VALID_REGISTRY.models["openai/gpt-4"], context_window: 0 },
    },
  };
  const errors = validateRegistry(reg);
  assert.ok(errors.some(e => /context_window/.test(e)));
});

test("validateRegistry rejects negative context_window", () => {
  const reg = {
    ...VALID_REGISTRY,
    models: {
      "openai/gpt-4": { ...VALID_REGISTRY.models["openai/gpt-4"], context_window: -1 },
    },
  };
  const errors = validateRegistry(reg);
  assert.ok(errors.some(e => /context_window/.test(e)));
});

// Fix 8: provider is a required field
test("validateRegistry errors on model missing provider field", () => {
  const { provider: _p, ...modelWithoutProvider } = VALID_REGISTRY.models["openai/gpt-4"];
  const reg = {
    ...VALID_REGISTRY,
    models: { "openai/gpt-4": modelWithoutProvider },
  };
  const errors = validateRegistry(reg);
  assert.ok(errors.some(e => /provider/.test(e)));
});
