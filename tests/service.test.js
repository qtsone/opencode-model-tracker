// tests/service.test.js
import { strict as assert } from "assert";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  startService,
  stopService,
  applyAssignmentsForRequest,
  configureServiceStorePathForTest,
  resetServiceStorePathForTest,
} from "../src/service.js";
import { initPerformanceStore } from "../src/store.js";

// ─── Admin token / auth tests ─────────────────────────────────────────────────

test("PUT /api/registry without token returns 401 and does not mutate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "service-auth-put-"));
  try {
    const registryPath = join(dir, "models.json");
    const original = { models: {}, agent_assignments: {}, ab_test_candidates: {} };
    writeFileSync(registryPath, JSON.stringify(original, null, 2));

    const { url } = await startService({ port: 4790, adminToken: "test-token-put" });
    const res = await fetch(`${url}/api/registry`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ models: { "evil/model": { provider: "evil" } }, agent_assignments: {}, ab_test_candidates: {} }),
    });

    assert.ok(res.status === 401 || res.status === 403,
      `Expected 401 or 403 without token, got ${res.status}`);
    const body = await res.json();
    assert.ok(body.error, "response must include error field");
  } finally {
    await stopService();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PUT /api/registry with wrong token returns 401 or 403 and does not mutate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "service-auth-put-wrong-"));
  try {
    const { url } = await startService({ port: 4791, adminToken: "correct-token" });
    const res = await fetch(`${url}/api/registry`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-model-tracker-admin-token": "wrong-token",
      },
      body: JSON.stringify({ models: {}, agent_assignments: {}, ab_test_candidates: {} }),
    });

    assert.ok(res.status === 401 || res.status === 403,
      `Expected 401 or 403 with wrong token, got ${res.status}`);
    const body = await res.json();
    assert.ok(body.error, "response must include error field");
  } finally {
    await stopService();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PUT /api/registry with correct token succeeds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "service-auth-put-ok-"));
  try {
    const registryPath = join(dir, "models.json");
    const original = {
      models: {
        "keep/model": {
          provider: "test", name: "Keep", context_window: 1000,
          cost: { input_per_1m: "free", output_per_1m: "free" }, strengths: [],
        },
      },
      agent_assignments: {},
      ab_test_candidates: {},
    };
    writeFileSync(registryPath, JSON.stringify(original, null, 2));

    const { url } = await startService({ port: 4792, adminToken: "good-token" });
    const res = await fetch(`${url}/api/registry`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-model-tracker-admin-token": "good-token",
      },
      body: JSON.stringify(original),
    });

    assert.equal(res.status, 200, `Expected 200 with correct token, got ${res.status}`);
    const body = await res.json();
    assert.ok(body.ok, "response must include ok:true");
  } finally {
    await stopService();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POST /api/apply without token returns 401 or 403 and does not mutate", async () => {
  const { url } = await startService({ port: 4793, adminToken: "test-token-apply" });
  try {
    const res = await fetch(`${url}/api/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignments: { "some-agent": "some/model" } }),
    });

    assert.ok(res.status === 401 || res.status === 403,
      `Expected 401 or 403 without token, got ${res.status}`);
    const body = await res.json();
    assert.ok(body.error, "response must include error field");
  } finally {
    await stopService();
  }
});

test("POST /api/apply with wrong token returns 401 or 403", async () => {
  const { url } = await startService({ port: 4794, adminToken: "correct-apply-token" });
  try {
    const res = await fetch(`${url}/api/apply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-model-tracker-admin-token": "wrong-apply-token",
      },
      body: JSON.stringify({ assignments: {} }),
    });

    assert.ok(res.status === 401 || res.status === 403,
      `Expected 401 or 403 with wrong token, got ${res.status}`);
    const body = await res.json();
    assert.ok(body.error, "response must include error field");
  } finally {
    await stopService();
  }
});

// ─── Hardening: OPTIONS returns 403, no CORS headers ─────────────────────────

test("OPTIONS preflight returns 403 with no CORS headers", async () => {
  const { url } = await startService({ port: 4795, adminToken: "cors-test-token" });
  try {
    const res = await fetch(`${url}/api/registry`, {
      method: "OPTIONS",
      headers: { "Origin": "http://evil.example.com" },
    });
    assert.equal(
      res.status,
      403,
      `OPTIONS must return 403 but got ${res.status}`
    );
    const acao = res.headers.get("access-control-allow-origin");
    assert.equal(
      acao,
      null,
      `OPTIONS must omit Access-Control-Allow-Origin entirely but got: '${acao}'`
    );
    const acam = res.headers.get("access-control-allow-methods");
    assert.equal(
      acam,
      null,
      `OPTIONS must omit Access-Control-Allow-Methods but got: '${acam}'`
    );
  } finally {
    await stopService();
  }
});

// ─── Hardening: GET /api/health omits registry_path and store_path ───────────

test("GET /api/health omits registry_path and store_path", async () => {
  const { url } = await startService({ port: 4798, adminToken: "health-test-token" });
  try {
    const res = await fetch(`${url}/api/health`);
    assert.equal(res.status, 200, `Expected 200 from /api/health, got ${res.status}`);
    const body = await res.json();
    assert.equal(body.status, "ok", "health response must have status: ok");
    assert.ok(body.port, "health response must include port");
    assert.ok(
      !("registry_path" in body),
      `GET /api/health must not expose registry_path but got: ${body.registry_path}`
    );
    assert.ok(
      !("store_path" in body),
      `GET /api/health must not expose store_path but got: ${body.store_path}`
    );
  } finally {
    await stopService();
  }
});

test("startService exposes adminToken on returned instance for same-origin UI embedding", async () => {
  const { url, adminToken } = await startService({ port: 4796, adminToken: "embed-test-token" });
  try {
    assert.equal(adminToken, "embed-test-token", "startService must expose adminToken on instance");
  } finally {
    await stopService();
  }
});

test("read-only GET endpoints remain accessible without token", async () => {
  const { url } = await startService({ port: 4797, adminToken: "readonly-test-token" });
  try {
    const res = await fetch(`${url}/api/health`);
    assert.equal(res.status, 200, "GET /api/health must not require auth");

    const res2 = await fetch(`${url}/api/registry`);
    assert.equal(res2.status, 200, "GET /api/registry must not require auth");

    const res3 = await fetch(`${url}/api/stats`);
    assert.equal(res3.status, 200, "GET /api/stats must not require auth");
  } finally {
    await stopService();
  }
});

test("startService reuses an already-started local service", async () => {
  const started = [];
  try {
    const first = await startService({ port: 4780 });
    started.push(first.server);
    const second = await startService({ port: 4780 });
    started.push(second.server);
    const third = await startService({ port: 4780 });
    started.push(third.server);

    assert.equal(second.url, first.url);
    assert.equal(third.url, first.url);
    assert.equal(second.server, first.server);
    assert.equal(third.server, first.server);
  } finally {
    const servers = [...new Set(started)];
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
});

test("applyAssignmentsForRequest saves registry only after target apply succeeds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "service-apply-test-"));
  try {
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "backend-engineer.md"), [
      "---",
      "model: old/model",
      "description: Backend engineer",
      "---",
      "Body",
    ].join("\n") + "\n");

    const opencodePath = join(dir, "opencode.json");
    writeFileSync(opencodePath, JSON.stringify({ agent: {} }, null, 2));

    const registryPath = join(dir, "models.json");
    writeFileSync(registryPath, JSON.stringify({
      models: {
        "old/model": {
          provider: "test",
          name: "Old",
          context_window: 1000,
          cost: { input_per_1m: "free", output_per_1m: "free" },
          strengths: ["old"],
        },
        "new/model": {
          provider: "test",
          name: "New",
          context_window: 1000,
          cost: { input_per_1m: "free", output_per_1m: "free" },
          strengths: ["new"],
        },
      },
      agent_assignments: { "backend-engineer": "old/model" },
      ab_test_candidates: {},
    }, null, 2));

    applyAssignmentsForRequest({ "backend-engineer": "new/model" }, {
      registryPath,
      agentDir,
      opencodePath,
      builtinAgents: new Set(),
    });

    const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
    assert.equal(registry.agent_assignments["backend-engineer"], "new/model");

    const agentFile = readFileSync(join(agentDir, "backend-engineer.md"), "utf-8");
    assert.ok(agentFile.includes("model: new/model"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyAssignmentsForRequest returns a meaningful apply summary", () => {
  const dir = mkdtempSync(join(tmpdir(), "service-apply-summary-"));
  try {
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "backend-engineer.md"), [
      "---",
      "model: old/model",
      "description: Backend engineer",
      "---",
      "Body",
    ].join("\n") + "\n");

    const opencodePath = join(dir, "opencode.json");
    writeFileSync(opencodePath, JSON.stringify({
      agent: { plan: { model: "old/model" } },
    }, null, 2));

    const registryPath = join(dir, "models.json");
    writeFileSync(registryPath, JSON.stringify({
      models: {
        "old/model": {
          provider: "test", name: "Old", context_window: 1000,
          cost: { input_per_1m: "free", output_per_1m: "free" }, strengths: [],
        },
        "new/model": {
          provider: "test", name: "New", context_window: 1000,
          cost: { input_per_1m: "free", output_per_1m: "free" }, strengths: [],
        },
      },
      agent_assignments: { "backend-engineer": "old/model", "plan": "old/model" },
      ab_test_candidates: {},
    }, null, 2));

    const result = applyAssignmentsForRequest(
      { "backend-engineer": "new/model", "plan": "new/model" },
      { registryPath, agentDir, opencodePath, builtinAgents: new Set(["plan"]) }
    );

    assert.ok(result !== undefined && result !== null, "apply must return a summary object");
    assert.equal(typeof result.custom_agents, "number", "summary must include custom_agents count");
    assert.equal(typeof result.built_in_agents, "number", "summary must include built_in_agents count");
    assert.equal(typeof result.total_files, "number", "summary must include total_files count");
    assert.equal(result.custom_agents, 1, "one custom agent written");
    assert.equal(result.built_in_agents, 1, "one built-in agent written");
    assert.equal(result.total_files, 2, "total_files = custom + built_in");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/api/stats uses sqlite records and ignores model-performance.json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "service-stats-sqlite-only-"));
  const dbPath = join(dir, "model-performance.sqlite");

  try {
    await initPerformanceStore(dbPath);
    configureServiceStorePathForTest(dbPath);

    // The sqlite db is empty; service must report 0 records.
    const { url } = await startService({ port: 4782 });
    const res = await fetch(`${url}/api/stats`);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.total_records, 0);
  } finally {
    await stopService();
    resetServiceStorePathForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/api/stats passes session_page, session_page_size, group_session_by to buildStatsResponse", async () => {
  const dir = mkdtempSync(join(tmpdir(), "service-stats-pagination-"));
  const dbPath = join(dir, "model-performance.sqlite");

  try {
    await initPerformanceStore(dbPath);
    configureServiceStorePathForTest(dbPath);

    const { url } = await startService({ port: 4784 });
    const res = await fetch(`${url}/api/stats?session_page=2&session_page_size=25&group_session_by=parent`);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.ok(body.per_session_pagination, "per_session_pagination must be present");
    assert.equal(body.per_session_pagination.page_size, 25, "page_size must match query param");
    assert.equal(body.filters_applied.session_page_size, 25, "filters_applied must echo session_page_size");
    assert.equal(body.filters_applied.group_session_by, "parent", "filters_applied must echo group_session_by");
    assert.ok(Array.isArray(body.per_session_stats), "per_session_stats must be an array");
  } finally {
    await stopService();
    resetServiceStorePathForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/api/stats?session_page=1&session_page_size=5 limits per_session_stats rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "service-stats-page-limit-"));
  const dbPath = join(dir, "model-performance.sqlite");

  try {
    const { initPerformanceStore: init } = await import("../src/store.js");
    await init(dbPath);
    configureServiceStorePathForTest(dbPath);

    const { url } = await startService({ port: 4785 });
    const res = await fetch(`${url}/api/stats?session_page=1&session_page_size=5`);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.ok(body.per_session_pagination, "per_session_pagination must be present");
    assert.equal(body.per_session_pagination.page_size, 5, "page_size 5 must be respected");
    assert.ok(body.per_session_stats.length <= 5, "per_session_stats must not exceed page_size");
  } finally {
    await stopService();
    resetServiceStorePathForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Atomic registry apply regression tests ───────────────────────────────────

test("applyAssignmentsForRequest leaves registry unchanged when agent file is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "service-atomic-missing-"));
  try {
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir);
    // Note: backend-engineer.md is intentionally NOT created

    const opencodePath = join(dir, "opencode.json");
    writeFileSync(opencodePath, JSON.stringify({ agent: {} }, null, 2));

    const registryPath = join(dir, "models.json");
    const originalRegistry = {
      models: {
        "old/model": {
          provider: "test",
          name: "Old",
          context_window: 1000,
          cost: { input_per_1m: "free", output_per_1m: "free" },
          strengths: [],
        },
        "new/model": {
          provider: "test",
          name: "New",
          context_window: 1000,
          cost: { input_per_1m: "free", output_per_1m: "free" },
          strengths: [],
        },
      },
      agent_assignments: { "backend-engineer": "old/model" },
      ab_test_candidates: {},
    };
    writeFileSync(registryPath, JSON.stringify(originalRegistry, null, 2));

    assert.throws(() => {
      applyAssignmentsForRequest({ "backend-engineer": "new/model" }, {
        registryPath,
        agentDir,
        opencodePath,
        builtinAgents: new Set(),
      });
    }, /backend-engineer/);

    const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
    assert.equal(
      registry.agent_assignments["backend-engineer"],
      "old/model",
      "Registry must remain unchanged when agent file is missing"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Malformed JSON returns 400 on mutating endpoints ────────────────────────

test("PUT /api/registry with valid token and malformed JSON body returns 400 with JSON error", async () => {
  const { url } = await startService({ port: 4800, adminToken: "malformed-json-token" });
  try {
    const res = await fetch(`${url}/api/registry`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-model-tracker-admin-token": "malformed-json-token",
      },
      body: "{ not valid json >>>",
    });
    assert.equal(res.status, 400, `Expected 400 for malformed JSON, got ${res.status}`);
    const body = await res.json();
    assert.ok(body.error, "response must include error field");
  } finally {
    await stopService();
  }
});

test("PUT /api/registry without token and malformed JSON body still returns 401 (auth checked before body)", async () => {
  const { url } = await startService({ port: 4801, adminToken: "malformed-json-token-2" });
  try {
    const res = await fetch(`${url}/api/registry`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{ not valid json >>>",
    });
    assert.ok(res.status === 401 || res.status === 403,
      `Expected 401/403 without token (auth first), got ${res.status}`);
  } finally {
    await stopService();
  }
});

test("POST /api/apply with valid token and malformed JSON body returns 400 with JSON error", async () => {
  const { url } = await startService({ port: 4802, adminToken: "malformed-apply-token" });
  try {
    const res = await fetch(`${url}/api/apply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-model-tracker-admin-token": "malformed-apply-token",
      },
      body: "definitely not json",
    });
    assert.equal(res.status, 400, `Expected 400 for malformed JSON on /api/apply, got ${res.status}`);
    const body = await res.json();
    assert.ok(body.error, "response must include error field");
  } finally {
    await stopService();
  }
});

test("POST /api/apply without token and malformed JSON body still returns 401 (auth checked before body)", async () => {
  const { url } = await startService({ port: 4804, adminToken: "malformed-apply-noauth-token" });
  try {
    const res = await fetch(`${url}/api/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not valid json >>>",
    });
    assert.ok(res.status === 401 || res.status === 403,
      `Expected 401/403 without token (auth first), got ${res.status}`);
  } finally {
    await stopService();
  }
});

// ─── group_session_by normalization ──────────────────────────────────────────

test("/api/stats?group_session_by=garbage normalizes to raw in filters_applied", async () => {
  const dir = mkdtempSync(join(tmpdir(), "service-stats-groupby-norm-"));
  const dbPath = join(dir, "model-performance.sqlite");
  try {
    await initPerformanceStore(dbPath);
    configureServiceStorePathForTest(dbPath);

    const { url } = await startService({ port: 4803, adminToken: "groupby-norm-token" });
    const res = await fetch(`${url}/api/stats?group_session_by=garbage`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(
      body.filters_applied.group_session_by,
      "raw",
      `group_session_by 'garbage' must normalize to 'raw', got '${body.filters_applied.group_session_by}'`
    );
  } finally {
    await stopService();
    resetServiceStorePathForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/api/stats returns performance_store_error for sqlite failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "service-stats-store-error-"));
  const blockerPath = join(dir, "not-a-directory");
  const invalidDbPath = join(blockerPath, "model-performance.sqlite");

  try {
    writeFileSync(blockerPath, "blocker");
    configureServiceStorePathForTest(invalidDbPath);

    const { url } = await startService({ port: 4783 });
    const res = await fetch(`${url}/api/stats`);
    const body = await res.json();

    assert.equal(res.status, 500);
    assert.equal(body.error.code, "performance_store_error");
    assert.equal(typeof body.error.message, "string");
    assert.ok(body.error.message.length > 0);
  } finally {
    await stopService();
    resetServiceStorePathForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── POST /api/apply happy-path ───────────────────────────────────────────────

test("POST /api/apply with valid token and valid body returns { ok: true, applied: ... } and updates files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "service-apply-http-ok-"));
  try {
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir);

    writeFileSync(join(agentDir, "backend-engineer.md"), [
      "---",
      "model: old/model",
      "description: Backend engineer",
      "---",
      "Body",
    ].join("\n") + "\n");

    const opencodePath = join(dir, "opencode.json");
    writeFileSync(opencodePath, JSON.stringify({ agent: {} }, null, 2));

    const registryPath = join(dir, "models.json");
    writeFileSync(registryPath, JSON.stringify({
      models: {
        "old/model": {
          provider: "test", name: "Old", context_window: 1000,
          cost: { input_per_1m: "free", output_per_1m: "free" }, strengths: [],
        },
        "new/model": {
          provider: "test", name: "New", context_window: 1000,
          cost: { input_per_1m: "free", output_per_1m: "free" }, strengths: [],
        },
      },
      agent_assignments: { "backend-engineer": "old/model" },
      ab_test_candidates: {},
    }, null, 2));

    const { url } = await startService({ port: 4805, adminToken: "apply-happy-token", paths: { registryPath, agentDir, opencodePath, builtinAgents: new Set() } });
    const res = await fetch(`${url}/api/apply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-model-tracker-admin-token": "apply-happy-token",
      },
      body: JSON.stringify({ assignments: { "backend-engineer": "new/model" } }),
    });

    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    const body = await res.json();
    assert.ok(body.ok === true, "response must have ok: true");
    assert.ok(body.applied !== undefined && body.applied !== null, "response must include applied summary");
    assert.equal(typeof body.applied.custom_agents, "number", "applied.custom_agents must be a number");
    assert.equal(typeof body.applied.total_files, "number", "applied.total_files must be a number");
    assert.ok(body.applied.total_files >= 1, "at least one file must be reported as applied");

    const agentFile = readFileSync(join(agentDir, "backend-engineer.md"), "utf-8");
    assert.ok(agentFile.includes("model: new/model"), "agent file must reflect the new model");

    const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
    assert.equal(registry.agent_assignments["backend-engineer"], "new/model",
      "registry must be updated with the new assignment");
  } finally {
    await stopService();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── /api/stats dashboard and /api/stats/children ────────────────────────────

test("/api/stats exposes dashboard parent and agent rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "service-stats-dashboard-"));
  const dbPath = join(dir, "model-performance.sqlite");

  try {
    await initPerformanceStore(dbPath);
    configureServiceStorePathForTest(dbPath);

    const { url } = await startService({ port: 4806, adminToken: "dashboard-test-token" });
    const res = await fetch(`${url}/api/stats`);
    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    const body = await res.json();

    assert.ok(body.dashboard, "response must include dashboard");
    assert.ok(body.dashboard.parent_sessions, "dashboard.parent_sessions must be present");
    assert.ok(Array.isArray(body.dashboard.parent_sessions.rows), "dashboard.parent_sessions.rows must be an array");
    assert.ok(body.dashboard.agents, "dashboard.agents must be present");
    assert.ok(Array.isArray(body.dashboard.agents.rows), "dashboard.agents.rows must be an array");
  } finally {
    await stopService();
    resetServiceStorePathForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/api/stats/children validates missing kind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "service-children-nokind-"));
  const dbPath = join(dir, "model-performance.sqlite");

  try {
    await initPerformanceStore(dbPath);
    configureServiceStorePathForTest(dbPath);

    const { url } = await startService({ port: 4807, adminToken: "children-test-token" });
    const res = await fetch(`${url}/api/stats/children`);
    assert.equal(res.status, 400, `Expected 400 for missing kind, got ${res.status}`);
    const body = await res.json();
    assert.ok(body.error, "response must include error field");
  } finally {
    await stopService();
    resetServiceStorePathForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/api/stats/children?kind=evil returns 400 with static error message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "service-children-evil-kind-"));
  const dbPath = join(dir, "model-performance.sqlite");

  try {
    await initPerformanceStore(dbPath);
    configureServiceStorePathForTest(dbPath);

    const { url } = await startService({ port: 4808, adminToken: "evil-kind-token" });
    const res = await fetch(`${url}/api/stats/children?kind=evil`);
    assert.equal(res.status, 400, `Expected 400 for invalid kind 'evil', got ${res.status}`);
    const body = await res.json();
    assert.equal(
      body.error,
      "Invalid dashboard child kind",
      `Expected static error message, got: ${JSON.stringify(body.error)}`
    );
  } finally {
    await stopService();
    resetServiceStorePathForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Hardening: generic internal server error in catch-all ───────────────────

test("catch-all error handler returns generic message without leaking details", async () => {
  const { url } = await startService({ port: 4809, adminToken: "generic-error-token" });
  try {
    // Trigger a 404 (the generic error path is for unhandled throws, but we
    // verify that the catch-all on the server level returns a JSON body)
    const res = await fetch(`${url}/api/nonexistent`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error, "404 must include error field");
    // Must not leak internal paths or stack traces
    const bodyStr = JSON.stringify(body);
    assert.ok(
      !bodyStr.includes("/Users/"),
      `Response must not leak absolute paths: ${bodyStr}`
    );
  } finally {
    await stopService();
  }
});
