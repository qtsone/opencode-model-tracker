// model-tracker/tests/sync.test.js
import { strict as assert } from "assert";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getSyncStatus, applyRegistryAssignments } from "../src/sync.js";

const BUILTIN_AGENTS = new Set(["plan", "build", "explore", "general", "title", "summary", "compaction"]);

function makeTestEnv() {
  const dir = mkdtempSync(join(tmpdir(), "sync-test-"));
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir);

  // Custom agent file
  writeFileSync(join(agentDir, "backend-engineer.md"), [
    "---",
    "model: github-copilot/claude-sonnet-4.6",
    "description: A backend engineer.",
    "---",
    "Body text.",
  ].join("\n") + "\n");

  // opencode.json with built-in agents
  const opencodeJson = {
    agent: {
      plan:  { model: "openai/gpt-5.3-codex" },
      build: { model: "github-copilot/claude-sonnet-4.6" },
    },
  };
  writeFileSync(join(dir, "opencode.json"), JSON.stringify(opencodeJson, null, 2));

  const assignments = {
    "backend-engineer": "github-copilot/claude-sonnet-4.6",
    "plan":  "openai/gpt-5.3-codex",
    "build": "github-copilot/claude-sonnet-4.6",
  };

  return { dir, agentDir, assignments };
}

test("getSyncStatus: no drift when assignments match", () => {
  const { dir, agentDir, assignments } = makeTestEnv();
  const status = getSyncStatus(assignments, agentDir, join(dir, "opencode.json"), BUILTIN_AGENTS);
  assert.deepStrictEqual(status.drift, []);
  assert.equal(status.in_sync, true);
  rmSync(dir, { recursive: true });
});

test("getSyncStatus: detects drift in custom agent file", () => {
  const { dir, agentDir } = makeTestEnv();
  const assignments = {
    "backend-engineer": "openai/gpt-5.3-codex", // changed
    "plan":  "openai/gpt-5.3-codex",
    "build": "github-copilot/claude-sonnet-4.6",
  };
  const status = getSyncStatus(assignments, agentDir, join(dir, "opencode.json"), BUILTIN_AGENTS);
  assert.ok(status.drift.some(d => d.agent === "backend-engineer"));
  assert.equal(status.in_sync, false);
  rmSync(dir, { recursive: true });
});

test("getSyncStatus: detects drift in opencode.json built-in", () => {
  const { dir, agentDir } = makeTestEnv();
  const assignments = {
    "backend-engineer": "github-copilot/claude-sonnet-4.6",
    "plan":  "openai/gpt-5.4", // changed
    "build": "github-copilot/claude-sonnet-4.6",
  };
  const status = getSyncStatus(assignments, agentDir, join(dir, "opencode.json"), BUILTIN_AGENTS);
  assert.ok(status.drift.some(d => d.agent === "plan"));
  rmSync(dir, { recursive: true });
});

test("applyRegistryAssignments: writes correct model to custom agent file", () => {
  const { dir, agentDir, assignments } = makeTestEnv();
  const changed = { ...assignments, "backend-engineer": "openai/gpt-5.3-codex" };
  applyRegistryAssignments(changed, agentDir, join(dir, "opencode.json"), BUILTIN_AGENTS);
  const content = readFileSync(join(agentDir, "backend-engineer.md"), "utf-8");
  assert.ok(content.includes("model: openai/gpt-5.3-codex"));
  assert.ok(!content.includes("model: github-copilot/claude-sonnet-4.6"));
  rmSync(dir, { recursive: true });
});

test("applyRegistryAssignments: preserves non-model frontmatter and body", () => {
  const { dir, agentDir, assignments } = makeTestEnv();
  applyRegistryAssignments(assignments, agentDir, join(dir, "opencode.json"), BUILTIN_AGENTS);
  const content = readFileSync(join(agentDir, "backend-engineer.md"), "utf-8");
  assert.ok(content.includes("description: A backend engineer."));
  assert.ok(content.includes("Body text."));
  rmSync(dir, { recursive: true });
});

test("applyRegistryAssignments: writes built-in model to opencode.json", () => {
  const { dir, agentDir, assignments } = makeTestEnv();
  const changed = { ...assignments, "plan": "openai/gpt-5.4" };
  applyRegistryAssignments(changed, agentDir, join(dir, "opencode.json"), BUILTIN_AGENTS);
  const oc = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf-8"));
  assert.equal(oc.agent.plan.model, "openai/gpt-5.4");
  rmSync(dir, { recursive: true });
});

test("applyRegistryAssignments: preserves unrelated opencode.json keys", () => {
  const { dir, agentDir, assignments } = makeTestEnv();
  // Add unrelated key to opencode.json
  const oc = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf-8"));
  oc.plugin = ["./model-tracker/index.js"];
  writeFileSync(join(dir, "opencode.json"), JSON.stringify(oc, null, 2));
  applyRegistryAssignments(assignments, agentDir, join(dir, "opencode.json"), BUILTIN_AGENTS);
  const updated = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf-8"));
  assert.deepStrictEqual(updated.plugin, ["./model-tracker/index.js"]);
  rmSync(dir, { recursive: true });
});

// ─── Issue 3: replaceModelLine must not match body model: lines ──────────────

test("applyRegistryAssignments: throws actionable error for unclosed frontmatter and does not mutate file", () => {
  const dir = mkdtempSync(join(tmpdir(), "sync-unclosed-fm-"));
  try {
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir);

    // Unclosed frontmatter: opening --- exists but no closing ---
    // Body contains a model: line at the start of a line (the dangerous case the current regex gets wrong)
    const originalContent = [
      "---",
      "description: Agent with unclosed frontmatter.",
      "model: some/body-model",
      "More content.",
    ].join("\n") + "\n";

    writeFileSync(join(agentDir, "unclosed-agent.md"), originalContent);
    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ agent: {} }, null, 2));

    const assignments = { "unclosed-agent": "target/model" };

    assert.throws(
      () => applyRegistryAssignments(assignments, agentDir, join(dir, "opencode.json"), new Set()),
      (err) => {
        assert.ok(
          typeof err.message === "string" && err.message.length > 0,
          "Error must have a message"
        );
        // Must mention the agent file or frontmatter issue for actionability
        assert.ok(
          /unclosed-agent/.test(err.message) || /frontmatter/.test(err.message) || /model:/.test(err.message),
          `Error must mention agent or frontmatter issue, got: ${err.message}`
        );
        return true;
      }
    );

    // File must not have been modified
    const afterContent = readFileSync(join(agentDir, "unclosed-agent.md"), "utf-8");
    assert.equal(afterContent, originalContent, "File must not be mutated when frontmatter is unclosed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyRegistryAssignments: throws actionable error for missing frontmatter entirely", () => {
  const dir = mkdtempSync(join(tmpdir(), "sync-no-fm-"));
  try {
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir);

    // No frontmatter at all — just a body with a model: line
    const originalContent = [
      "Body text that contains model: some/body-model here.",
      "More content.",
    ].join("\n") + "\n";

    writeFileSync(join(agentDir, "no-fm-agent.md"), originalContent);
    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ agent: {} }, null, 2));

    const assignments = { "no-fm-agent": "target/model" };

    assert.throws(
      () => applyRegistryAssignments(assignments, agentDir, join(dir, "opencode.json"), new Set()),
      (err) => {
        assert.ok(typeof err.message === "string" && err.message.length > 0);
        return true;
      }
    );

    const afterContent = readFileSync(join(agentDir, "no-fm-agent.md"), "utf-8");
    assert.equal(afterContent, originalContent, "File must not be mutated when frontmatter is missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyRegistryAssignments: throws explicit error when agent file lacks model: frontmatter", () => {
  const dir = mkdtempSync(join(tmpdir(), "sync-no-model-line-"));
  try {
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir);

    // Agent file exists but has no model: line in frontmatter
    writeFileSync(join(agentDir, "broken-agent.md"), [
      "---",
      "description: An agent without a model line.",
      "---",
      "Body text.",
    ].join("\n") + "\n");

    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ agent: {} }, null, 2));

    const assignments = { "broken-agent": "some/model" };

    assert.throws(
      () => applyRegistryAssignments(assignments, agentDir, join(dir, "opencode.json"), new Set()),
      (err) => {
        assert.ok(
          /broken-agent/.test(err.message) || /model:/.test(err.message),
          `Error must mention agent name or model: but got: ${err.message}`
        );
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getSyncStatus: still reports drift when agent file has no model: line (no silent success)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sync-no-model-drift-"));
  try {
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir);

    // Agent file exists but has no model: line — readAgentModel returns null
    writeFileSync(join(agentDir, "broken-agent.md"), [
      "---",
      "description: An agent without a model line.",
      "---",
      "Body text.",
    ].join("\n") + "\n");

    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ agent: {} }, null, 2));

    const assignments = { "broken-agent": "some/model" };
    const status = getSyncStatus(assignments, agentDir, join(dir, "opencode.json"), new Set());

    assert.equal(status.in_sync, false, "Must report drift when file lacks model: line");
    assert.ok(
      status.drift.some(d => d.agent === "broken-agent"),
      "drift must include broken-agent"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getSyncStatus: malformed frontmatter (closing --- not followed by newline/EOF) treated as invalid — reports drift with null actual", () => {
  // "---\nmodel: old/model\n---body" — the closing --- is immediately followed
  // by non-whitespace body content, so it is NOT a valid YAML frontmatter close.
  // Both readAgentModel and replaceModelLine must agree this file has no valid model.
  const dir = mkdtempSync(join(tmpdir(), "sync-test-malformed-fm-"));
  try {
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir);

    // Malformed: closing --- runs directly into body without a newline separator
    writeFileSync(join(agentDir, "malformed-agent.md"), "---\nmodel: old/model\n---body content here\n");

    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ agent: {} }, null, 2));

    const assignments = { "malformed-agent": "some/model" };
    const status = getSyncStatus(assignments, agentDir, join(dir, "opencode.json"), new Set());

    assert.equal(status.in_sync, false, "Must report drift for malformed frontmatter file");
    const entry = status.drift.find(d => d.agent === "malformed-agent");
    assert.ok(entry, "drift must include malformed-agent");
    assert.equal(entry.actual, null, "actual must be null when frontmatter is malformed");
    assert.equal(entry.expected, "some/model");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── replaceModelLine block scalar regression ─────────────────────────────────

test("applyRegistryAssignments: replaces only top-level model: key, not indented block-scalar model: lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "sync-block-scalar-"));
  try {
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir);

    // Frontmatter contains a block scalar whose content includes indented
    // "model:" text. Only the top-level unindented "model:" key must be replaced.
    const originalContent = [
      "---",
      "description: |",
      "  This agent uses a special model: approach for reasoning.",
      "  Another model: reference here.",
      "model: old/model",
      "---",
      "Body text.",
    ].join("\n") + "\n";

    writeFileSync(join(agentDir, "scalar-agent.md"), originalContent);
    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ agent: {} }, null, 2));

    const assignments = { "scalar-agent": "new/model" };
    applyRegistryAssignments(assignments, agentDir, join(dir, "opencode.json"), new Set());

    const updated = readFileSync(join(agentDir, "scalar-agent.md"), "utf-8");

    // The top-level model: key must be updated
    assert.ok(
      updated.includes("model: new/model"),
      "top-level model: key must be updated to new/model"
    );

    // The indented block-scalar lines must remain unchanged
    assert.ok(
      updated.includes("  This agent uses a special model: approach for reasoning."),
      "indented block-scalar model: line must not be changed"
    );
    assert.ok(
      updated.includes("  Another model: reference here."),
      "second indented block-scalar model: line must not be changed"
    );

    // The old top-level model value must be gone
    assert.ok(
      !updated.includes("model: old/model"),
      "old top-level model: old/model must not remain"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getSyncStatus: reads valid model: key and ignores model:nospace key before it", () => {
  // readAgentModel must only extract the value from `model:` followed by whitespace/EOL.
  // A preceding `model:nospace: bad-key` line must not be returned as the model value.
  const dir = mkdtempSync(join(tmpdir(), "sync-nospace-read-"));
  try {
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir);

    // model:nospace appears BEFORE the valid model: key in frontmatter
    writeFileSync(join(agentDir, "nospace-read-agent.md"), [
      "---",
      "model:nospace: bad-key",
      "model: expected/model",
      "---",
      "Body.",
    ].join("\n") + "\n");

    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ agent: {} }, null, 2));

    const assignments = { "nospace-read-agent": "expected/model" };
    const status = getSyncStatus(assignments, agentDir, join(dir, "opencode.json"), new Set());

    // If readAgentModel mistakenly returns "bad-key" (from model:nospace), drift is reported.
    // Expected: no drift — the file has model: expected/model which matches the assignment.
    assert.equal(status.in_sync, true, "Must be in sync when valid model: matches assignment; readAgentModel must not pick up model:nospace");
    assert.deepStrictEqual(status.drift, [], "No drift expected when valid model: key matches");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyRegistryAssignments: does not match model: key without whitespace separator (e.g. model:nospace)", () => {
  // The regex must only replace `model:` followed by whitespace or end-of-line.
  // A line like `model:nospace` is a different YAML key and must not be replaced.
  const dir = mkdtempSync(join(tmpdir(), "sync-nospace-"));
  try {
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir);

    // Frontmatter where 'model:' is the real key and 'model:nospace' is a
    // distinct YAML key. replaceModelLine must only change the real 'model:' line.
    const originalContent = [
      "---",
      "model:nospace: should-not-be-touched",
      "model: old/model",
      "---",
      "Body.",
    ].join("\n") + "\n";

    writeFileSync(join(agentDir, "nospace-agent.md"), originalContent);
    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ agent: {} }, null, 2));

    const assignments = { "nospace-agent": "new/model" };
    applyRegistryAssignments(assignments, agentDir, join(dir, "opencode.json"), new Set());

    const updated = readFileSync(join(agentDir, "nospace-agent.md"), "utf-8");

    assert.ok(
      updated.includes("model: new/model"),
      "top-level model: key must be updated"
    );
    assert.ok(
      updated.includes("model:nospace: should-not-be-touched"),
      "model:nospace key must remain untouched"
    );
    assert.ok(
      !updated.includes("model: old/model"),
      "old model: value must be gone"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
