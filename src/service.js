// src/service.js
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { parse as parseUrl } from "node:url";
import { readFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadRegistry, saveRegistry, validateRegistry } from "./registry.js";
import { buildStatsResponse, buildDashboardChildRows } from "./stats.js";
import { getSyncStatus, applyRegistryAssignments } from "./sync.js";
import { generateUI } from "./ui.js";
import { listPerformanceRecords, getPerformanceRecordById, PerformanceStoreError } from "./store.js";
import { REGISTRY_PATH, PERFORMANCE_DB_PATH, AGENT_DIR, OPENCODE_JSON, EXAMPLE_REGISTRY_PATH, registryExists } from "./paths.js";

let servicePromise = null;
let serviceInstance = null;
let activeDbPath = PERFORMANCE_DB_PATH;

/**
 * Seed the user registry from models.example.json if the user registry is
 * absent. This ensures first-run users have a working set of models without
 * requiring manual setup.
 * @param {string} registryPath
 */
function seedRegistryIfAbsent(registryPath) {
  if (registryExists(registryPath)) return;
  try {
    mkdirSync(dirname(registryPath), { recursive: true });
    copyFileSync(EXAMPLE_REGISTRY_PATH, registryPath);
  } catch {
    // Non-fatal: the service will surface a useful error when the registry is
    // first accessed if the seed also fails.
  }
}

/**
 * Derive the set of builtin agents from opencode.json agent keys.
 * These are agents configured directly in opencode.json rather than agent/*.md files.
 */
function getBuiltinAgents(opencodePath = OPENCODE_JSON) {
  try {
    const oc = JSON.parse(readFileSync(opencodePath, "utf-8"));
    return new Set(Object.keys(oc?.agent ?? {}));
  } catch {
    return new Set();
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, body, contentType = "application/json") {
  const payload =
    contentType === "application/json" ? JSON.stringify(body) : body;
  res.writeHead(status, {
    "Content-Type": contentType,
  });
  res.end(payload);
}

function sendUnauthorized(res) {
  return send(res, 401, { error: "Unauthorized: missing or invalid x-model-tracker-admin-token" });
}

function checkAdminToken(req, adminToken) {
  const provided = req.headers["x-model-tracker-admin-token"];
  return typeof provided === "string" && provided === adminToken;
}

async function handleRequest(req, res, port, adminToken, paths) {
  const { pathname, query } = parseUrl(req.url, true);
  const method = req.method;

  const registryPath = paths?.registryPath ?? REGISTRY_PATH;
  const agentDir = paths?.agentDir ?? AGENT_DIR;
  const opencodePath = paths?.opencodePath ?? OPENCODE_JSON;

  try {
    // Harden: reject OPTIONS with 403 and no CORS headers. Cross-origin
    // preflights must not succeed — this service is localhost-only.
    if (method === "OPTIONS") {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Forbidden" }));
    }

    if (method === "GET" && pathname === "/") {
      return send(res, 200, generateUI(adminToken), "text/html");
    }

    if (method === "GET" && pathname === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }

    if (method === "GET" && pathname === "/api/health") {
      // Omit registry_path and store_path to avoid leaking local filesystem
      // paths to any client that can reach the health endpoint.
      return send(res, 200, {
        status: "ok",
        port,
      });
    }

    if (method === "GET" && pathname === "/api/registry") {
      const registry = loadRegistry(registryPath);
      return send(res, 200, registry);
    }

    if (method === "PUT" && pathname === "/api/registry") {
      if (!checkAdminToken(req, adminToken)) {
        return sendUnauthorized(res);
      }
      let body;
      try {
        body = await readBody(req);
      } catch {
        return send(res, 400, { error: "Invalid JSON body" });
      }
      validateRegistry(body);
      saveRegistry(body, registryPath);
      return send(res, 200, { ok: true });
    }

    if (method === "GET" && pathname === "/api/sync-status") {
      const registry = loadRegistry(registryPath);
      const builtins = paths?.builtinAgents ?? getBuiltinAgents(opencodePath);
      const result = getSyncStatus(registry.agent_assignments ?? {}, agentDir, opencodePath, builtins);
      return send(res, 200, result);
    }

    if (method === "POST" && pathname === "/api/apply") {
      if (!checkAdminToken(req, adminToken)) {
        return sendUnauthorized(res);
      }
      let body;
      try {
        body = await readBody(req);
      } catch {
        return send(res, 400, { error: "Invalid JSON body" });
      }
      const { assignments } = body;
      const builtins = paths?.builtinAgents ?? getBuiltinAgents(opencodePath);
      const applied = applyAssignmentsForRequest(assignments, { registryPath, agentDir, opencodePath, builtinAgents: builtins });
      return send(res, 200, { ok: true, applied });
    }

    if (method === "GET" && pathname === "/api/stats/record") {
      const { id } = query;
      if (!id) {
        return send(res, 400, { error: "Missing required query param: id" });
      }
      let record;
      try {
        record = await getPerformanceRecordById(id, activeDbPath);
      } catch (e) {
        if (e instanceof PerformanceStoreError) {
          return send(res, 500, { error: { code: "performance_store_error", message: e.message } });
        }
        throw e;
      }
      if (!record) {
        return send(res, 404, { error: "record not found" });
      }
      return send(res, 200, { record });
    }

    if (method === "GET" && pathname === "/api/stats/children") {
      const { kind, id, session_id, parent_session_id, agent, model_id } = query;
      if (!kind) {
        return send(res, 400, { error: "Missing required query param: kind" });
      }
      const VALID_KINDS = new Set(["parent-session", "session-requests", "agent-models", "agent-model-sessions"]);
      if (!VALID_KINDS.has(kind)) {
        return send(res, 400, { error: "Invalid dashboard child kind" });
      }
      let records;
      try {
        records = await listPerformanceRecords(activeDbPath);
      } catch (e) {
        if (e instanceof PerformanceStoreError) {
          return send(res, 500, {
            error: {
              code: "performance_store_error",
              message: e.message,
            },
          });
        }
        throw e;
      }
      const registry = loadRegistry(registryPath);
      const result = buildDashboardChildRows(records, registry, { kind, id, session_id, parent_session_id, agent, model_id });
      return send(res, 200, result);
    }

    if (method === "GET" && pathname === "/api/stats") {
      const { agent, session_id, model_id, sort_by, sort_dir, group_session_by, session_page, session_page_size, parent_session_id, parent_page, parent_page_size, agent_page, agent_page_size } = query;
      let records;
      try {
        records = await listPerformanceRecords(activeDbPath);
      } catch (e) {
        if (e instanceof PerformanceStoreError) {
          return send(res, 500, {
            error: {
              code: "performance_store_error",
              message: e.message,
            },
          });
        }
        throw e;
      }
      const registry = loadRegistry(registryPath);
      const result = buildStatsResponse(records, { agent, session_id, model_id, sort_by, sort_dir, group_session_by, session_page, session_page_size, parent_session_id, parent_page, parent_page_size, agent_page, agent_page_size }, registry);
      return send(res, 200, result);
    }

    return send(res, 404, { error: "not found" });
  } catch (e) {
    // Log full error details to stderr; return a generic message to the client
    // to avoid leaking internal paths, stack traces, or implementation details.
    process.stderr.write(`[model-tracker] Internal error: ${e?.stack ?? e}\n`);
    return send(res, 500, { error: "Internal server error" });
  }
}

function tryListen(server, port, maxPort) {
  return new Promise((resolve, reject) => {
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE" && port < maxPort) {
        server.removeAllListeners("error");
        resolve(tryListen(server, port + 1, maxPort));
      } else {
        reject(err);
      }
    });
    server.listen(port, "127.0.0.1", () => resolve(port));
  });
}

export async function startService({ port = 4747, adminToken, paths } = {}) {
  if (serviceInstance) return serviceInstance;
  if (servicePromise) return servicePromise;

  const resolvedToken = adminToken ?? randomBytes(32).toString("hex");

  // Seed registry from example if not yet present
  const registryPath = paths?.registryPath ?? REGISTRY_PATH;
  seedRegistryIfAbsent(registryPath);

  servicePromise = startServiceInstance(port, resolvedToken, paths);
  try {
    serviceInstance = await servicePromise;
    serviceInstance.server.once("close", () => {
      serviceInstance = null;
      servicePromise = null;
    });
    return serviceInstance;
  } catch (err) {
    servicePromise = null;
    throw err;
  }
}

/**
 * Close the singleton service and reset state. Safe to call even if the
 * service was never started. Resolves once the server is fully closed.
 */
export async function stopService() {
  if (serviceInstance) {
    const { server } = serviceInstance;
    await new Promise((resolve) => server.close(resolve));
    // The 'close' listener above resets serviceInstance / servicePromise
  } else if (servicePromise) {
    // In-flight start — wait for it then close
    try {
      const inst = await servicePromise;
      await new Promise((resolve) => inst.server.close(resolve));
    } catch {
      // start failed; state already reset
    }
  }
}

export function applyAssignmentsForRequest(assignments, options = {}) {
  const registryPath = options.registryPath ?? REGISTRY_PATH;
  const agentDir = options.agentDir ?? AGENT_DIR;
  const opencodePath = options.opencodePath ?? OPENCODE_JSON;
  const builtinAgents = options.builtinAgents ?? getBuiltinAgents(opencodePath);

  const registry = loadRegistry(registryPath);
  registry.agent_assignments = { ...registry.agent_assignments, ...assignments };
  const errors = validateRegistry(registry);
  if (errors.length) throw new Error(errors.join("\n"));

  // Apply target files first; only persist registry if apply succeeds.
  const result = applyRegistryAssignments(registry.agent_assignments, agentDir, opencodePath, builtinAgents);
  saveRegistry(registry, registryPath);
  return result;
}

export function configureServiceStorePathForTest(dbPath) {
  activeDbPath = dbPath;
}

export function resetServiceStorePathForTest() {
  activeDbPath = PERFORMANCE_DB_PATH;
}

async function startServiceInstance(port, adminToken, paths) {
  let boundPort;
  const server = createServer((req, res) => {
    handleRequest(req, res, boundPort, adminToken, paths).catch((e) => {
      process.stderr.write(`[model-tracker] Unhandled error in request handler: ${e?.stack ?? e}\n`);
      res.writeHead(500, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ error: "Internal server error" }));
    });
  });

  boundPort = await tryListen(server, port, port + 10);

  const url = `http://127.0.0.1:${boundPort}`;
  return { url, server, adminToken };
}
