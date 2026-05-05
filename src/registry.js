// src/registry.js
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { isSafeAgentName } from "./sync.js";

const REQUIRED_MODEL_FIELDS = ["provider", "name", "context_window", "cost", "strengths"];
const OPTIONAL_CACHE_COST_FIELDS = [
  "cache_read_per_1m",
  "cache_write_per_1m",
  "cache_write_5m_per_1m",
  "cache_write_1h_per_1m",
];

/**
 * Load and JSON-parse the registry file.
 * Throws with a human-readable message on any failure.
 * @param {string} registryPath
 * @returns {{ models: object, agent_assignments: object, ab_test_candidates: object }}
 */
export function loadRegistry(registryPath) {
  let raw;
  try {
    raw = readFileSync(registryPath, "utf-8");
  } catch (err) {
    throw new Error(`Registry not found: ${registryPath} — ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in registry: ${err.message}`);
  }
  return parsed;
}

/**
 * Atomically write the registry to disk.
 * Cleans up the .tmp file if any step fails.
 * @param {object} registry
 * @param {string} registryPath
 */
export function saveRegistry(registry, registryPath) {
  const tmp = registryPath + "." + randomBytes(8).toString("hex") + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify(registry, null, 2) + "\n", "utf-8");
    renameSync(tmp, registryPath);
  } catch (err) {
    if (existsSync(tmp)) {
      try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    }
    throw err;
  }
}

/**
 * Return true if value is a valid cost rate: a finite number or exactly the string "free".
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidCostValue(value) {
  if (value === "free") return true;
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validate a registry object. Returns array of error strings (empty = valid).
 * @param {object} registry
 * @returns {string[]}
 */
export function validateRegistry(registry) {
  const errors = [];

  if (!registry || typeof registry !== "object") {
    return ["Registry must be an object."];
  }

  if (!registry.models || typeof registry.models !== "object" || Array.isArray(registry.models)) {
    errors.push("Registry missing required key: 'models'.");
  }
  if (!registry.agent_assignments || typeof registry.agent_assignments !== "object" || Array.isArray(registry.agent_assignments)) {
    errors.push("Registry missing required key: 'agent_assignments'.");
  }
  if (registry.ab_test_candidates == null || typeof registry.ab_test_candidates !== "object" || Array.isArray(registry.ab_test_candidates)) {
    errors.push("Registry missing required key: 'ab_test_candidates'.");
  }

  if (errors.length > 0) return errors;

  // Validate model entries
  for (const [id, model] of Object.entries(registry.models)) {
    if (/[\r\n]/.test(id)) {
      errors.push(`Model ID contains illegal newline or carriage-return characters (control characters not allowed in model IDs).`);
      continue;
    }

    for (const field of REQUIRED_MODEL_FIELDS) {
      if (model[field] === undefined || model[field] === null) {
        errors.push(`Model '${id}' is missing required field '${field}'.`);
      }
    }

    if (model.strengths !== undefined && !Array.isArray(model.strengths)) {
      errors.push(`Model '${id}': 'strengths' must be an array.`);
    }

    // context_window must be a positive integer
    if (model.context_window !== undefined && model.context_window !== null) {
      const cw = model.context_window;
      if (!Number.isInteger(cw) || cw <= 0) {
        errors.push(`Model '${id}': 'context_window' must be a positive integer.`);
      }
    }

    if (model.cost && typeof model.cost === "object") {
      // Reject stale per-1k keys
      if ("input_per_1k" in model.cost) {
        errors.push(`model ${id} uses stale cost.input_per_1k; use input_per_1m`);
      }
      if ("output_per_1k" in model.cost) {
        errors.push(`model ${id} uses stale cost.output_per_1k; use output_per_1m`);
      }

      // Require per-1m keys
      if (!("input_per_1m" in model.cost)) {
        errors.push(`model ${id} missing cost.input_per_1m`);
      } else if (!isValidCostValue(model.cost.input_per_1m)) {
        errors.push(`model ${id} cost.input_per_1m must be a number or "free"`);
      }

      if (!("output_per_1m" in model.cost)) {
        errors.push(`model ${id} missing cost.output_per_1m`);
      } else if (!isValidCostValue(model.cost.output_per_1m)) {
        errors.push(`model ${id} cost.output_per_1m must be a number or "free"`);
      }

      for (const field of OPTIONAL_CACHE_COST_FIELDS) {
        if (field in model.cost && !isValidCostValue(model.cost[field])) {
          errors.push(`model ${id} cost.${field} must be a number or "free"`);
        }
      }
    }
  }

  // Validate assignments reference known models
  for (const [agent, modelId] of Object.entries(registry.agent_assignments)) {
    if (!isSafeAgentName(agent)) {
      errors.push(`Assignment key '${agent}' is an unsafe agent name. Names must match /^[a-zA-Z0-9_-]{1,64}$/.`);
      continue;
    }
    if (!registry.models[modelId]) {
      errors.push(`Assignment for '${agent}' references unknown model '${modelId}'.`);
    }
  }

  // Validate A/B candidates reference known models
  for (const [agent, candidates] of Object.entries(registry.ab_test_candidates)) {
    if (!isSafeAgentName(agent)) {
      errors.push(`A/B candidate key '${agent}' is an unsafe agent name. Names must match /^[a-zA-Z0-9_-]{1,64}$/.`);
      continue;
    }
    if (!Array.isArray(candidates)) {
      errors.push(`ab_test_candidates['${agent}'] must be an array.`);
      continue;
    }
    for (const modelId of candidates) {
      if (!registry.models[modelId]) {
        errors.push(`A/B candidate for '${agent}' references unknown model '${modelId}'.`);
      }
    }
  }

  return errors;
}
