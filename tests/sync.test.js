// model-tracker/tests/sync.test.js
import { strict as assert } from "assert";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getSyncStatus, applyRegistryAssignments, discoverAssignableAgents, SAFE_AGENT_NAME_RE, isSafeAgentName } from "../src/sync.js";
import { symlinkSync, statSync } from "fs";

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

// ─── SAFE_AGENT_NAME_RE and isSafeAgentName ───────────────────────────────────

test("isSafeAgentName: accepts valid names", () => {
  assert.equal(isSafeAgentName("backend-engineer"), true);
  assert.equal(isSafeAgentName("plan"), true);
  assert.equal(isSafeAgentName("My_Agent-123"), true);
  assert.equal(isSafeAgentName("a".repeat(64)), true);
});

test("isSafeAgentName: rejects unsafe names", () => {
  assert.equal(isSafeAgentName(""), false);
  assert.equal(isSafeAgentName("../escape"), false);
  assert.equal(isSafeAgentName("has space"), false);
  assert.equal(isSafeAgentName("a".repeat(65)), false);
  assert.equal(isSafeAgentName("with/slash"), false);
  assert.equal(isSafeAgentName("with.dot"), false);
});

// ─── discoverAssignableAgents ─────────────────────────────────────────────────

test("discoverAssignableAgents: returns safe opencode and custom agents sorted with source metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "discover-basic-"));
  try {
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir);

    writeFileSync(join(agentDir, "zebra-agent.md"), [
      "---",
      "model: custom/model-z",
      "---",
      "body",
    ].join("\n") + "\n");

    writeFileSync(join(agentDir, "alpha-agent.md"), [
      "---",
      "model: custom/model-a",
      "---",
      "body",
    ].join("\n") + "\n");

    const opencodePath = join(dir, "opencode.json");
    writeFileSync(opencodePath, JSON.stringify({ agent: { plan: { model: "builtin/plan-model" } } }, null, 2));

    const builtins = new Set(["plan"]);
    const result = discoverAssignableAgents(agentDir, opencodePath, builtins);

    // Must be sorted by name
    const names = result.map(r => r.name);
    assert.deepStrictEqual(names, [...names].sort());

    // Each entry has required shape
    for (const entry of result) {
      assert.ok(typeof entry.name === "string");
      assert.ok(entry.source === "custom" || entry.source === "opencode");
      assert.ok(entry.model === null || typeof entry.model === "string");
      assert.ok(typeof entry.target === "string");
    }

    const alpha = result.find(r => r.name === "alpha-agent");
    assert.ok(alpha, "alpha-agent must be in results");
    assert.equal(alpha.source, "custom");
    assert.equal(alpha.model, "custom/model-a");
    assert.equal(alpha.target, "agent/alpha-agent.md");

    const planEntry = result.find(r => r.name === "plan");
    assert.ok(planEntry, "plan must be in results");
    assert.equal(planEntry.source, "opencode");
    assert.equal(planEntry.model, "builtin/plan-model");
    assert.equal(planEntry.target, "opencode.json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverAssignableAgents: prefers opencode source when same agent appears in both", () => {
  const dir = mkdtempSync(join(tmpdir(), "discover-overlap-"));
  try {
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir);

    // plan.md exists as a custom file but plan is also a builtin
    writeFileSync(join(agentDir, "plan.md"), [
      "---",
      "model: custom/plan-model",
      "---",
    ].join("\n") + "\n");

    const opencodePath = join(dir, "opencode.json");
    writeFileSync(opencodePath, JSON.stringify({ agent: { plan: { model: "builtin/plan-model" } } }, null, 2));

    const builtins = new Set(["plan"]);
    const result = discoverAssignableAgents(agentDir, opencodePath, builtins);

    const planEntries = result.filter(r => r.name === "plan");
    assert.equal(planEntries.length, 1, "plan must appear only once");
    assert.equal(planEntries[0].source, "opencode", "opencode source must win");
    assert.equal(planEntries[0].target, "opencode.json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverAssignableAgents: ignores unsafe custom filenames and unsafe builtin names", () => {
  const dir = mkdtempSync(join(tmpdir(), "discover-unsafe-"));
  try {
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir);

    // Unsafe custom filename: contains dots
    writeFileSync(join(agentDir, "bad.name.md"), "---\nmodel: x\n---\n");
    // Safe custom filename
    writeFileSync(join(agentDir, "good-agent.md"), "---\nmodel: good/model\n---\n");

    const opencodePath = join(dir, "opencode.json");
    writeFileSync(opencodePath, JSON.stringify({ agent: {} }, null, 2));

    // Unsafe builtin name included
    const builtins = new Set(["plan", "../evil", "good with spaces"]);
    const result = discoverAssignableAgents(agentDir, opencodePath, builtins);

    const names = result.map(r => r.name);
    assert.ok(!names.includes("bad.name"), "unsafe custom filename must be excluded");
    assert.ok(!names.includes("../evil"), "unsafe builtin name must be excluded");
    assert.ok(!names.includes("good with spaces"), "unsafe builtin name with spaces must be excluded");
    assert.ok(names.includes("good-agent"), "safe custom agent must be included");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverAssignableAgents: handles missing agentDir gracefully", () => {
  const dir = mkdtempSync(join(tmpdir(), "discover-nodir-"));
  try {
    const opencodePath = join(dir, "opencode.json");
    writeFileSync(opencodePath, JSON.stringify({ agent: { plan: { model: "m" } } }, null, 2));

    const result = discoverAssignableAgents(join(dir, "nonexistent"), opencodePath, new Set(["plan"]));
    // Must not throw; builtin agents still returned
    const planEntry = result.find(r => r.name === "plan");
    assert.ok(planEntry, "builtin agents still returned when agentDir missing");
    assert.equal(planEntry.source, "opencode");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverAssignableAgents: ignores custom symlink escaping agentDir and oversized markdown files", () => {
  const dir = mkdtempSync(join(tmpdir(), "discover-sec-"));
  try {
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir);

    // Oversized file (> 1 MiB)
    const bigContent = "---\nmodel: big/model\n---\n" + "x".repeat(1024 * 1024 + 1);
    writeFileSync(join(agentDir, "big-agent.md"), bigContent);

    // Normal agent that should appear
    writeFileSync(join(agentDir, "normal-agent.md"), "---\nmodel: good/model\n---\n");

    const opencodePath = join(dir, "opencode.json");
    writeFileSync(opencodePath, JSON.stringify({ agent: {} }, null, 2));

    // Try to create a symlink escaping agentDir
    let symlinkCreated = false;
    try {
      const outsideFile = join(dir, "secret.md");
      writeFileSync(outsideFile, "---\nmodel: leaked\n---\n");
      symlinkSync(outsideFile, join(agentDir, "escape-agent.md"));
      symlinkCreated = true;
    } catch {
      // Symlink creation not supported; skip that assertion
    }

    const result = discoverAssignableAgents(agentDir, opencodePath, new Set());
    const names = result.map(r => r.name);

    assert.ok(!names.includes("big-agent"), "oversized file must be excluded");
    assert.ok(names.includes("normal-agent"), "normal agent must be included");

    if (symlinkCreated) {
      assert.ok(!names.includes("escape-agent"), "symlink escaping agentDir must be excluded");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── P2-2: replaceModelLine must not expand $ replacement patterns ────────────

test("applyRegistryAssignments: model ID containing $ replacement patterns is written verbatim", () => {
  const dir = mkdtempSync(join(tmpdir(), "sync-dollar-model-"));
  try {
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir);

    writeFileSync(join(agentDir, "dollar-agent.md"), [
      "---",
      "model: old/model",
      "---",
      "Body.",
    ].join("\n") + "\n");
    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ agent: {} }, null, 2));

    // Model IDs containing $& and $` are valid replacement pattern characters
    // in String.prototype.replace; without a replacer function they would expand.
    const assignments = { "dollar-agent": "weird/$&model" };
    applyRegistryAssignments(assignments, agentDir, join(dir, "opencode.json"), new Set());

    const updated = readFileSync(join(agentDir, "dollar-agent.md"), "utf-8");
    assert.ok(
      updated.includes("model: weird/$&model"),
      `model value must be written verbatim; got:\n${updated}`
    );
    assert.ok(!updated.includes("model: old/model"), "old model value must be gone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── P2-3: apply stage size guard for custom agent file ───────────────────────

test("applyRegistryAssignments: rejects oversized custom agent file during apply without mutation", () => {
  const dir = mkdtempSync(join(tmpdir(), "sync-apply-oversize-"));
  try {
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir);

    // Safe name but content over 1 MiB — write enough to exceed the 1 MiB guard
    const header = "---\nmodel: old/model\n---\n";
    const body = "x".repeat(1024 * 1024 + 1);
    const originalContent = header + body;
    writeFileSync(join(agentDir, "big-apply-agent.md"), originalContent);
    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ agent: {} }, null, 2));

    const assignments = { "big-apply-agent": "new/model" };

    assert.throws(
      () => applyRegistryAssignments(assignments, agentDir, join(dir, "opencode.json"), new Set()),
      (err) => {
        assert.ok(typeof err.message === "string" && err.message.length > 0, "Must have an error message");
        return true;
      },
      "Must throw when custom agent file exceeds 1 MiB during apply stage"
    );

    // File must not have been mutated
    const afterContent = readFileSync(join(agentDir, "big-apply-agent.md"), "utf-8");
    assert.equal(afterContent, originalContent, "Oversized file must not be mutated");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── applyRegistryAssignments: reject unsafe agent names ─────────────────────

test("applyRegistryAssignments: rejects unsafe agent names before writing outside agentDir", () => {
  const dir = mkdtempSync(join(tmpdir(), "apply-unsafe-name-"));
  try {
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir);
    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ agent: {} }, null, 2));

    // Unsafe agent name that could be a path traversal
    const assignments = { "../escape": "some/model" };

    assert.throws(
      () => applyRegistryAssignments(assignments, agentDir, join(dir, "opencode.json"), new Set()),
      (err) => {
        assert.ok(typeof err.message === "string" && err.message.length > 0);
        return true;
      },
      "Must throw when an unsafe agent name is in assignments"
    );

    // Ensure no file was created outside agentDir
    try {
      statSync(join(dir, "escape.md"));
      assert.fail("escape.md must not have been created outside agentDir");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
