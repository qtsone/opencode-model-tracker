// src/sync.js
import { readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";

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
  const updatedFmBlock = fmBlock.replace(/^model:([ \t].*)?$/m, `model: ${newModel}`);
  return content.replace(fmBlock, updatedFmBlock);
}

/**
 * Read all custom agent models from agent/*.md files.
 * Returns Map<agentName, modelId>.
 * @param {string} agentDir
 * @returns {Map<string, string>}
 */
function readCustomAgentModels(agentDir) {
  const result = new Map();
  let files;
  try {
    files = readdirSync(agentDir).filter(f => f.endsWith(".md"));
  } catch {
    return result;
  }
  for (const file of files) {
    const name = basename(file, ".md");
    const model = readAgentModel(join(agentDir, file));
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

  // --- Stage phase: validate and compute all custom-agent mutations in memory ---
  const customModels = readCustomAgentModels(agentDir);
  const stagedCustom = []; // Array<{ filePath, tmpPath, content }>

  for (const [agent, model] of Object.entries(assignments)) {
    if (builtinAgents.has(agent)) continue;
    if (customModels.get(agent) === model) continue;
    const filePath = join(agentDir, `${agent}.md`);

    let raw;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch (err) {
      errors.push(`Agent file not found for '${agent}' at '${filePath}': ${err.message}`);
      continue;
    }

    try {
      const updated = replaceModelLine(raw, model, filePath);
      stagedCustom.push({ filePath, tmpPath: filePath + ".tmp", content: updated });
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

  const ocTmpPath = opencodePath + ".tmp";
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
