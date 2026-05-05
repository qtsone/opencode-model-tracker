// src/sync.js
import { readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, realpathSync, statSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { randomBytes } from "node:crypto";

/** Maximum allowed size for a custom agent markdown file (1 MiB). */
const MAX_AGENT_FILE_SIZE = 1024 * 1024;

/**
 * Safe agent name pattern: alphanumeric, hyphens, underscores, 1–64 chars.
 * @type {RegExp}
 */
export const SAFE_AGENT_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Returns true iff name is a safe agent name per SAFE_AGENT_NAME_RE.
 * @param {string} name
 * @returns {boolean}
 */
export function isSafeAgentName(name) {
  return SAFE_AGENT_NAME_RE.test(name);
}

/**
 * Read the `model:` frontmatter value from an agent markdown file.
 * Returns null if not found.
 * @param {string} filePath
 * @returns {string|null}
 */
function readAgentModel(filePath) {
  let content;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  const match = content.match(/^---\n([\s\S]*?)\n---(\n|$)/);
  if (!match) return null;
  const fm = match[1];
  // Top-level YAML key `model:` must be followed by whitespace or end-of-line.
  // `model:nospace` is a different key and must not match.
  const modelLine = fm.split("\n").find(l => /^model:(\s|$)/.test(l));
  if (!modelLine) return null;
  return modelLine.replace(/^model:\s*/, "").trim();
}

/**
 * Produce updated content with the `model:` frontmatter line replaced.
 * Throws if no `model:` line is found in the frontmatter, so callers can
 * detect and report the problem before any file write occurs.
 * @param {string} content  raw file content
 * @param {string} newModel
 * @param {string} filePath used only in error messages
 * @returns {string} updated content
 */
function replaceModelLine(content, newModel, filePath) {
  // Require a properly closed YAML frontmatter block: ^---\n...\n---\n
  // The closing --- must exist before any body content is matched.
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---(\n|$)/);
  if (!fmMatch) {
    throw new Error(
      `Agent file '${filePath}' has malformed or unclosed YAML frontmatter. ` +
      `Ensure the file begins with '---', contains a 'model:' field, and is closed with '---'.`
    );
  }

  const fmBlock = fmMatch[0]; // the full frontmatter block including delimiters
  const fmBody = fmMatch[1];  // content between the delimiters

  // Top-level YAML key `model:` must be followed by whitespace or end-of-line.
  // `model:nospace` is a different key and must not match.
  if (!fmBody.split("\n").some(l => /^model:(\s|$)/.test(l))) {
    throw new Error(
      `Agent file '${filePath}' has no 'model:' line in its frontmatter. ` +
      `Add a 'model:' field before applying assignments.`
    );
  }

  // Replace only within the frontmatter block, matching `model:` followed by
  // whitespace or end-of-line so that keys like `model:nospace` are not touched.
  // Use a replacer function to prevent $ expansion in newModel (e.g. $&, $`, $').
  const updatedFmBlock = fmBlock.replace(/^model:([ \t].*)?$/m, () => `model: ${newModel}`);
  return content.replace(fmBlock, () => updatedFmBlock);
}

/**
 * Enumerate safe agent files in agentDir, applying all security checks:
 * unsafe names, symlink escapes, and size limit.
 * Returns an array of { name, filePath } for files that pass all checks.
 * @param {string} agentDir
 * @returns {Array<{name: string, filePath: string}>}
 */
function enumerateSafeAgentFiles(agentDir) {
  let files;
  try {
    files = readdirSync(agentDir).filter(f => f.endsWith(".md"));
  } catch {
    return [];
  }
  const resolvedAgentDir = (() => {
    try { return realpathSync(agentDir); } catch { return resolve(agentDir); }
  })();
  const result = [];
  for (const file of files) {
    const name = basename(file, ".md");
    if (!isSafeAgentName(name)) continue;
    const filePath = join(agentDir, file);
    // Symlink escape check
    try {
      const real = realpathSync(filePath);
      if (!real.startsWith(resolvedAgentDir + "/") && real !== resolvedAgentDir) continue;
    } catch {
      continue;
    }
    // Size check
    try {
      const st = statSync(filePath);
      if (st.size > MAX_AGENT_FILE_SIZE) continue;
    } catch {
      continue;
    }
    result.push({ name, filePath });
  }
  return result;
}

/**
 * Read all custom agent models from agent/*.md files.
 * Returns Map<agentName, modelId>.
 * Skips unsafe filenames, symlinks escaping agentDir, and files over 1 MiB.
 * @param {string} agentDir
 * @returns {Map<string, string>}
 */
function readCustomAgentModels(agentDir) {
  const result = new Map();
  for (const { name, filePath } of enumerateSafeAgentFiles(agentDir)) {
    const model = readAgentModel(filePath);
    if (model) result.set(name, model);
  }
  return result;
}

/**
 * Read built-in agent models from opencode.json.
 * Returns Map<agentName, modelId>.
 * @param {string} opencodePath
 * @param {Set<string>} builtinAgents
 * @returns {Map<string, string>}
 */
function readBuiltinModels(opencodePath, builtinAgents) {
  const result = new Map();
  let oc;
  try {
    oc = JSON.parse(readFileSync(opencodePath, "utf-8"));
  } catch {
    return result;
  }
  for (const name of builtinAgents) {
    const model = oc?.agent?.[name]?.model;
    if (model) result.set(name, model);
  }
  return result;
}

/**
 * Discover all assignable agents from custom agent/*.md files and the provided
 * builtinAgents Set. Each entry has shape:
 *   { name: string, source: "custom"|"opencode", model: string|null, target: string }
 *
 * Rules:
 * - Custom agents: safe existing `agent/*.md` filenames only (no symlink escapes, no oversized files).
 * - Opencode agents: from builtinAgents Set; unsafe names are skipped defensively.
 * - If the same name appears in both, the opencode entry wins (matches builtinAgents.has() routing).
 * - model is current model value from file/config, or null when absent/malformed.
 * - Returns array sorted by agent name.
 *
 * @param {string} agentDir
 * @param {string} opencodePath
 * @param {Set<string>} builtinAgents
 * @returns {Array<{name: string, source: "custom"|"opencode", model: string|null, target: string}>}
 */
export function discoverAssignableAgents(agentDir, opencodePath, builtinAgents) {
  // Collect custom agents (only safe, non-symlink-escaped, non-oversized files)
  const customMap = new Map(); // name -> model|null
  for (const { name, filePath } of enumerateSafeAgentFiles(agentDir)) {
    customMap.set(name, readAgentModel(filePath));
  }

  // Collect builtin models from opencode.json
  const builtinModelMap = new Map(); // name -> model|null
  {
    let oc;
    try {
      oc = JSON.parse(readFileSync(opencodePath, "utf-8"));
    } catch {
      oc = {};
    }
    for (const name of builtinAgents) {
      if (!isSafeAgentName(name)) continue;
      const model = oc?.agent?.[name]?.model ?? null;
      builtinModelMap.set(name, model);
    }
  }

  // Merge: opencode wins for overlapping names
  const merged = new Map(); // name -> entry
  for (const [name, model] of customMap) {
    merged.set(name, { name, source: "custom", model: model ?? null, target: `agent/${name}.md` });
  }
  for (const [name, model] of builtinModelMap) {
    // Overwrite custom if present
    merged.set(name, { name, source: "opencode", model: model ?? null, target: "opencode.json" });
  }

  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Compare registry assignments to actual files.
 * Returns { in_sync: boolean, drift: Array<{ agent, expected, actual, target }> }
 * @param {object} assignments  agent_assignments from registry
 * @param {string} agentDir
 * @param {string} opencodePath
 * @param {Set<string>} builtinAgents
 */
export function getSyncStatus(assignments, agentDir, opencodePath, builtinAgents) {
  const customModels  = readCustomAgentModels(agentDir);
  const builtinModels = readBuiltinModels(opencodePath, builtinAgents);

  const drift = [];

  for (const [agent, expected] of Object.entries(assignments)) {
    const isBuiltin = builtinAgents.has(agent);
    const actual = isBuiltin ? builtinModels.get(agent) : customModels.get(agent);
    if (actual !== expected) {
      drift.push({
        agent,
        expected,
        actual: actual ?? null,
        target: isBuiltin ? "opencode.json" : `agent/${agent}.md`,
      });
    }
  }

  return { in_sync: drift.length === 0, drift };
}

/**
 * Apply all assignments to agent files and opencode.json.
 * Writes only files that differ from the assignment.
 *
 * Atomicity approach:
 *   1. Stage phase  – read & transform all targets in memory; fail fast on any
 *      missing file or missing model: line, before touching the filesystem.
 *   2. Temp-write phase – write every .tmp file; if any temp write fails, the
 *      already-written temps are removed and an error is thrown.
 *   3. Rename phase – atomically rename each .tmp to its final path.
 *
 * Residual cross-file risk: the rename phase is not an atomic group operation.
 * A process crash between individual renames could leave some targets updated
 * and others not. Full cross-file atomicity would require a journal/WAL and is
 * intentionally out of scope. The registry is saved by the caller only after
 * this function returns successfully, so a partial rename leaves the registry
 * and files transiently inconsistent until the next apply; getSyncStatus will
 * detect and report the drift.
 *
 * @param {object} assignments
 * @param {string} agentDir
 * @param {string} opencodePath
 * @param {Set<string>} builtinAgents
 * @returns {{ custom_agents: number, built_in_agents: number, total_files: number }}
 */
export function applyRegistryAssignments(assignments, agentDir, opencodePath, builtinAgents) {
  const errors = [];

  // --- Reject unsafe agent names before any path construction or file access ---
  for (const agent of Object.keys(assignments)) {
    if (!isSafeAgentName(agent)) {
      errors.push(`Unsafe agent name rejected: '${agent}'. Names must match /^[a-zA-Z0-9_-]{1,64}$/.`);
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));

  // --- Stage phase: validate and compute all custom-agent mutations in memory ---
  const customModels = readCustomAgentModels(agentDir);
  const stagedCustom = []; // Array<{ filePath, tmpPath, content }>

  for (const [agent, model] of Object.entries(assignments)) {
    if (builtinAgents.has(agent)) continue;
    if (customModels.get(agent) === model) continue;
    const filePath = join(agentDir, `${agent}.md`);

    // Size guard: reject oversized custom agent files before reading content
    try {
      const st = statSync(filePath);
      if (st.size > MAX_AGENT_FILE_SIZE) {
        errors.push(`Agent file '${filePath}' exceeds the 1 MiB size limit and cannot be applied.`);
        continue;
      }
    } catch (err) {
      errors.push(`Agent file not found for '${agent}' at '${filePath}': ${err.message}`);
      continue;
    }

    let raw;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch (err) {
      errors.push(`Agent file not found for '${agent}' at '${filePath}': ${err.message}`);
      continue;
    }

    try {
      const updated = replaceModelLine(raw, model, filePath);
      const tmpPath = filePath + "." + randomBytes(8).toString("hex") + ".tmp";
      stagedCustom.push({ filePath, tmpPath, content: updated });
    } catch (err) {
      errors.push(err.message);
    }
  }

  // --- Stage phase: validate opencode.json is readable and compute update ---
  let oc;
  try {
    oc = JSON.parse(readFileSync(opencodePath, "utf-8"));
  } catch (err) {
    errors.push(`Cannot read opencode.json: ${err.message}`);
  }

  if (errors.length) throw new Error(errors.join("\n"));

  // Compute opencode.json mutation in memory
  if (!oc.agent) oc.agent = {};
  let builtinChanged = false;
  for (const [agent, model] of Object.entries(assignments)) {
    if (!builtinAgents.has(agent)) continue;
    if (!oc.agent[agent]) oc.agent[agent] = {};
    if (oc.agent[agent].model !== model) {
      oc.agent[agent].model = model;
      builtinChanged = true;
    }
  }

  const ocTmpPath = opencodePath + "." + randomBytes(8).toString("hex") + ".tmp";
  const stagedBuiltin = builtinChanged
    ? [{ filePath: opencodePath, tmpPath: ocTmpPath, content: JSON.stringify(oc, null, 2) + "\n" }]
    : [];

  const allStaged = [...stagedCustom, ...stagedBuiltin];

  // --- Temp-write phase: write all .tmp files before any rename ---
  // If a temp write fails, clean up already-written temps and abort.
  const writtenTmps = [];
  try {
    for (const { tmpPath, content } of allStaged) {
      writeFileSync(tmpPath, content, "utf-8");
      writtenTmps.push(tmpPath);
    }
  } catch (err) {
    for (const tmpPath of writtenTmps) {
      try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    }
    throw new Error(`Temp-write failed, all temp files cleaned up: ${err.message}`);
  }

  // --- Rename phase: atomically promote each temp to its final path ---
  // See atomicity note in JSDoc above for residual cross-file risk.
  for (const { filePath, tmpPath } of allStaged) {
    renameSync(tmpPath, filePath);
  }

  return {
    custom_agents: stagedCustom.length,
    built_in_agents: stagedBuiltin.length,
    total_files: allStaged.length,
  };
}
