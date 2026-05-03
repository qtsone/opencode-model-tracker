// model-tracker/tests/ui.test.js
import { strict as assert } from "assert";
import { test } from "node:test";
import { UI_HTML, generateUI } from "../src/ui.js";

// Extract the inline script once. Use non-greedy match so multiple script tags
// (if ever added) don't bleed into each other.
const scriptMatch = UI_HTML.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(scriptMatch, "UI_HTML must include an inline <script> block");
const SCRIPT = scriptMatch[1];

// Evaluate the script in a sandbox that stubs the browser globals the script
// calls at the top level (showPage -> loadHealth -> apiFetch -> fetch).
function evalScript() {
  const sandbox = new Function(
    "fetch", "document", "location", "alert", "confirm", "prompt",
    SCRIPT
  );
  const noop = () => {};
  const fakePromise = { then: () => fakePromise, catch: () => fakePromise };
  const fakeFetch = () => fakePromise;
  const fakeDoc = {
    querySelectorAll: () => ({ forEach: noop }),
    addEventListener: noop,
    getElementById: () => ({
      classList: { remove: noop, add: noop },
      style: {},
      options: [{}],
      innerHTML: "",
      textContent: "",
      appendChild: noop,
      value: "",
    }),
    createElement: () => ({ value: "", textContent: "", selected: false }),
  };
  const fakeLocation = { port: "4700" };
  sandbox(fakeFetch, fakeDoc, fakeLocation, noop, noop, noop);
  return sandbox;
}

// Pull individual functions out of the script text for unit testing without
// browser globals. We wrap just the function body in a new Function.
function extractFn(name) {
  // Match "function <name>(...) { ... }" allowing nested braces.
  // Walk the source to find the matching closing brace.
  const header = new RegExp(`function ${name}\\s*\\([^)]*\\)\\s*\\{`);
  const m = header.exec(SCRIPT);
  if (!m) throw new Error(`function ${name} not found in script`);
  let depth = 0;
  let start = m.index;
  let i = start + m[0].length - 1; // points at opening '{'
  for (; i < SCRIPT.length; i++) {
    if (SCRIPT[i] === "{") depth++;
    else if (SCRIPT[i] === "}") { depth--; if (depth === 0) break; }
  }
  const body = SCRIPT.slice(start, i + 1);
  // Return the extracted source so the caller can wrap it.
  return body;
}

function makeEscFn() {
  const src = extractFn("esc");
  // Strip the outer "function esc(...) {" and closing "}" to get just the body
  const inner = src.replace(/^function\s+esc\s*\([^)]*\)\s*\{/, "").replace(/\}$/, "");
  return new Function("s", inner);
}

function makeFmtDurFn() {
  const src = extractFn("fmtDur");
  const inner = src.replace(/^function\s+fmtDur\s*\([^)]*\)\s*\{/, "").replace(/\}$/, "");
  return new Function("ms", inner);
}

function makeFmtTokensFn() {
  const src = extractFn("fmtTokens");
  const inner = src.replace(/^function\s+fmtTokens\s*\([^)]*\)\s*\{/, "").replace(/\}$/, "");
  return new Function("value", inner);
}

function makeRowAgentLabelFn() {
  const escSrc = extractFn("esc");
  const agentHueSrc = extractFn("agentHue");
  const agentSrc = extractFn("rowAgentLabel");
  return new Function(`${escSrc}\n${agentHueSrc}\n${agentSrc}\nreturn rowAgentLabel;`)();
}

// ─── existing tests ───────────────────────────────────────────────────────────

test("embedded admin UI script parses as browser JavaScript", () => {
  assert.doesNotThrow(() => evalScript());
});

test("admin UI uses per-1M registry cost keys", () => {
  assert.ok(UI_HTML.includes("input_per_1m"));
  assert.ok(UI_HTML.includes("output_per_1m"));
  assert.ok(UI_HTML.includes("cache_read_per_1m"));
  assert.ok(UI_HTML.includes("cache_write_per_1m"));
  assert.ok(!UI_HTML.includes("input_per_1k"));
  assert.ok(!UI_HTML.includes("output_per_1k"));
});

test("admin UI includes dashboard sections with correct labels", () => {
  assert.ok(UI_HTML.includes("Parent Sessions"), "UI must include 'Parent Sessions' section");
  assert.ok(UI_HTML.includes("Agents"), "UI must include 'Agents' section");
  assert.ok(UI_HTML.includes("Fresh input"), "UI must include 'Fresh input' label");
  assert.ok(UI_HTML.includes("Cached input"), "UI must include 'Cached input' label");
  assert.ok(UI_HTML.includes("Cache write"), "UI must include 'Cache write' label");
  assert.ok(UI_HTML.includes("Output"), "UI must include 'Output' label");
  assert.ok(UI_HTML.includes("Total tokens"), "UI must include 'Total tokens' label");
  assert.ok(UI_HTML.includes("Total cost"), "UI must include 'Total cost' label");
  assert.ok(!UI_HTML.includes("Unique Tokens"), "UI must not include default 'Unique Tokens' label");
  assert.ok(!UI_HTML.includes("Attributed Tokens"), "UI must not include default 'Attributed Tokens' label");
});

test("stats UI includes dashboard renderers and lazy child loader", () => {
  assert.ok(SCRIPT.includes("renderParentSessions"), "script must include renderParentSessions");
  assert.ok(SCRIPT.includes("renderAgents"), "script must include renderAgents");
  assert.ok(SCRIPT.includes("toggleDashboardRow"), "script must include toggleDashboardRow");
  assert.ok(SCRIPT.includes("/api/stats/children"), "script must reference /api/stats/children endpoint");
});

test("loadStats renders dashboard parent sessions and agents from API payload", () => {
  const src = extractFn("loadStats");
  assert.ok(src.includes("data.dashboard.parent_sessions"), "loadStats must reference data.dashboard.parent_sessions");
  assert.ok(src.includes("data.dashboard.agents"), "loadStats must reference data.dashboard.agents");
  assert.ok(src.includes("renderParentSessions"), "loadStats must call renderParentSessions");
  assert.ok(src.includes("renderAgents"), "loadStats must call renderAgents");
});

// ─── legacy sections must be removed ─────────────────────────────────────────

test("legacy Per Agent/Model section is removed from stats HTML", () => {
  assert.ok(
    !UI_HTML.includes("Per Agent/Model"),
    "UI must not include legacy 'Per Agent/Model' section heading"
  );
  assert.ok(
    !UI_HTML.includes("pam-body"),
    "UI must not include legacy pam-body table id"
  );
});

test("legacy Per Session section is removed from stats HTML", () => {
  assert.ok(
    !UI_HTML.includes("<h2>Per Session</h2>"),
    "UI must not include legacy '<h2>Per Session</h2>' heading"
  );
  assert.ok(
    !UI_HTML.includes("session-body"),
    "UI must not include legacy session-body table id"
  );
});

test("renderPAM and renderSessions are not defined in the script", () => {
  assert.ok(
    !SCRIPT.includes("function renderPAM("),
    "script must not define renderPAM after legacy removal"
  );
  assert.ok(
    !SCRIPT.includes("function renderSessions("),
    "script must not define renderSessions after legacy removal"
  );
});

// ─── dashboard pagination controls ───────────────────────────────────────────

test("Parent Sessions section includes pagination controls in HTML", () => {
  assert.ok(UI_HTML.includes("parent-prev"), "UI must include parent-prev pager control");
  assert.ok(UI_HTML.includes("parent-page-info"), "UI must include parent-page-info element");
  assert.ok(UI_HTML.includes("parent-next"), "UI must include parent-next pager control");
});

test("Agents section includes pagination controls in HTML", () => {
  assert.ok(UI_HTML.includes("agent-prev"), "UI must include agent-prev pager control");
  assert.ok(UI_HTML.includes("agent-page-info"), "UI must include agent-page-info element");
  assert.ok(UI_HTML.includes("agent-next"), "UI must include agent-next pager control");
});

test("changeParentPage and changeAgentPage functions are defined in script", () => {
  assert.ok(SCRIPT.includes("function changeParentPage("), "script must define changeParentPage");
  assert.ok(SCRIPT.includes("function changeAgentPage("), "script must define changeAgentPage");
});

test("renderParentSessions updates parent pagination controls", () => {
  const src = extractFn("renderParentSessions");
  assert.ok(
    src.includes("parent-prev") || src.includes("parent-page-info") || src.includes("parent-next"),
    "renderParentSessions must update parent pagination control elements"
  );
});

test("renderAgents updates agent pagination controls", () => {
  const src = extractFn("renderAgents");
  assert.ok(
    src.includes("agent-prev") || src.includes("agent-page-info") || src.includes("agent-next"),
    "renderAgents must update agent pagination control elements"
  );
});

// ─── dashboard renderer token/colspan coverage ───────────────────────────────

test("renderDashboardRow renders total tokens via fmtTokens", () => {
  const src = extractFn("renderDashboardRow");
  assert.ok(src.includes("fmtTokens(row.total_tokens)"), "renderDashboardRow must render total_tokens via fmtTokens");
});

test("renderParentSessions uses colspan 10 for empty/error rows", () => {
  const src = extractFn("renderParentSessions");
  assert.ok(src.includes('colspan="10"'), "renderParentSessions empty row must use colspan 10");
  assert.ok(!src.includes('colspan="11"'), "renderParentSessions must not use old colspan 11");
});

test("renderAgents uses colspan 10 for empty/error rows", () => {
  const src = extractFn("renderAgents");
  assert.ok(src.includes('colspan="10"'), "renderAgents empty row must use colspan 10");
  assert.ok(!src.includes('colspan="11"'), "renderAgents must not use old colspan 11");
});

test("renderRecent renders total tokens and uses correct colspan", () => {
  const src = extractFn("renderRecent");
  assert.ok(src.includes("fmtTokens(r.total_tokens)"), "renderRecent should render total tokens");
  assert.ok(src.includes('colspan="7"'), "renderRecent empty row must use colspan 7");
});

test("loadStats sets kpi-tokens and has catch handler resetting it", () => {
  const src = extractFn("loadStats");
  assert.ok(
    src.includes("kpi-tokens") && src.includes("total_tokens"),
    "loadStats should set kpi-tokens from total_tokens"
  );
  assert.ok(src.includes(".catch("), "loadStats must have a .catch() handler");
  assert.ok(
    src.includes("document.getElementById('kpi-tokens').textContent = '—'"),
    "loadStats catch should reset kpi-tokens to em dash"
  );
});

// ─── fmtTokens ────────────────────────────────────────────────────────────────

test("fmtTokens formats compact token counts", () => {
  const fmtTokens = makeFmtTokensFn();
  assert.equal(fmtTokens(null), "—");
  assert.equal(fmtTokens(1234), "1,234");
  assert.equal(fmtTokens(45_300), "45.3K");
  assert.equal(fmtTokens(1_200_000), "1.2M");
});

// ─── esc() single-quote escaping ─────────────────────────────────────────────

test("esc() escapes single quotes to &#39;", () => {
  const esc = makeEscFn();
  assert.equal(esc("it's"), "it&#39;s");
});

test("esc() source contains single-quote escape pattern", () => {
  assert.ok(
    SCRIPT.includes("&#39;") || SCRIPT.includes("&#x27;"),
    "esc() must escape single quotes (&#39; or &#x27;)"
  );
});

test("esc() still escapes &, <, >, and \"", () => {
  const esc = makeEscFn();
  assert.equal(esc('a&b<c>d"e'), "a&amp;b&lt;c&gt;d&quot;e");
});

// ─── fmtDur boundary correctness ─────────────────────────────────────────────

test("fmtDur: 59999ms renders as integer seconds (not 60.0s)", () => {
  const fmtDur = makeFmtDurFn();
  const result = fmtDur(59999);
  assert.ok(result !== "60.0s", `fmtDur(59999) must not be '60.0s', got '${result}'`);
  // Should be 59s
  assert.equal(result, "59s");
});

test("fmtDur: 60000ms renders as 1m 0s", () => {
  const fmtDur = makeFmtDurFn();
  assert.equal(fmtDur(60000), "1m 0s");
});

test("fmtDur: 119999ms does not render 1m 60.0s", () => {
  const fmtDur = makeFmtDurFn();
  const result = fmtDur(119999);
  assert.ok(result !== "1m 60.0s", `fmtDur(119999) must not be '1m 60.0s', got '${result}'`);
  assert.equal(result, "1m 59s");
});

test("fmtDur: 90500ms renders as 1m 30s", () => {
  const fmtDur = makeFmtDurFn();
  assert.equal(fmtDur(90500), "1m 30s");
});

test("fmtDur: null/NaN returns em dash", () => {
  const fmtDur = makeFmtDurFn();
  assert.equal(fmtDur(null), "—");
  assert.equal(fmtDur(NaN), "—");
});

// ─── loadStats params ─────────────────────────────────────────────────────────

test("loadStats sends parent_page and agent_page params to API", () => {
  const src = extractFn("loadStats");
  assert.ok(src.includes("parent_page"), "loadStats must include parent_page in query params");
  assert.ok(src.includes("parent_page_size"), "loadStats must include parent_page_size in query params");
  assert.ok(src.includes("agent_page"), "loadStats must include agent_page in query params");
  assert.ok(src.includes("agent_page_size"), "loadStats must include agent_page_size in query params");
});

test("loadStats does not send group_session_by param after Per Session removal", () => {
  const src = extractFn("loadStats");
  assert.ok(
    !src.includes("group_session_by"),
    "loadStats must not include group_session_by after legacy Per Session removal"
  );
});

test("loadStats does not send session_page or session_page_size params after Per Session removal", () => {
  const src = extractFn("loadStats");
  assert.ok(!src.includes("session_page"), "loadStats must not include session_page param");
  assert.ok(!src.includes("session_page_size"), "loadStats must not include session_page_size param");
});

test("UI updates parent and agent page state variables", () => {
  assert.ok(SCRIPT.includes("_parentPage"), "script must maintain _parentPage state variable");
  assert.ok(SCRIPT.includes("_agentPage"), "script must maintain _agentPage state variable");
  assert.ok(SCRIPT.includes("_expandedRows"), "script must maintain _expandedRows state variable");
  assert.ok(!SCRIPT.includes("_sessionPage"), "script must not maintain _sessionPage after Per Session removal");
  assert.ok(!SCRIPT.includes("_sessionTotalPages"), "script must not maintain _sessionTotalPages after Per Session removal");
  assert.ok(!SCRIPT.includes("_sessionPageSize"), "script must not maintain _sessionPageSize after Per Session removal");
});

// ─── renderBars ───────────────────────────────────────────────────────────────

test("renderBars zero-count: esc and renderBars source guards against max=0", () => {
  // Structural assertion: the source must contain a guard for max === 0 or
  // use a safe divisor expression so NaN% never appears in the output.
  const hasDivGuard =
    SCRIPT.includes("max === 0") ||
    SCRIPT.includes("max == 0") ||
    SCRIPT.includes("max || 1") ||
    SCRIPT.includes("max ? ") ||
    SCRIPT.includes("max)? ") ||
    /Math\.round\(item\.count\s*\/\s*\(max\s*\|\|\s*1\)/.test(SCRIPT) ||
    /max\s*\|\|\s*1/.test(SCRIPT);
  assert.ok(hasDivGuard, "renderBars must guard against division by zero when max is 0");
});

// ─── orphaned legacy session subsystem removal ────────────────────────────────

test("script does not reference orphaned element group-session-by", () => {
  assert.ok(!SCRIPT.includes("group-session-by"), "script must not reference removed group-session-by element");
});

test("script does not reference orphaned elements session-page-info, session-prev, session-next", () => {
  assert.ok(!SCRIPT.includes("session-page-info"), "script must not reference removed session-page-info element");
  assert.ok(!SCRIPT.includes("session-prev"), "script must not reference removed session-prev element");
  assert.ok(!SCRIPT.includes("session-next"), "script must not reference removed session-next element");
});

test("changeSessionPage is not defined after Per Session removal", () => {
  assert.ok(!SCRIPT.includes("function changeSessionPage("), "script must not define changeSessionPage after Per Session removal");
});

// ─── toggleDashboardRow query construction ────────────────────────────────────

test("toggleDashboardRow uses URLSearchParams to build child query, not child_query= param", () => {
  const src = extractFn("toggleDashboardRow");
  assert.ok(
    src.includes("new URLSearchParams("),
    "toggleDashboardRow must use new URLSearchParams() to build the child query string"
  );
  assert.ok(
    !src.includes("child_query="),
    "toggleDashboardRow must not use legacy child_query= query param"
  );
});

// ─── catch handlers ───────────────────────────────────────────────────────────

test("loadRegistryPage has a .catch() handler", () => {
  // Find the loadRegistryPage function body and confirm it catches errors.
  const src = extractFn("loadRegistryPage");
  assert.ok(src.includes(".catch("), "loadRegistryPage must have a .catch() handler");
});

test("loadAssignments has a .catch() handler", () => {
  const src = extractFn("loadAssignments");
  assert.ok(src.includes(".catch("), "loadAssignments must have a .catch() handler");
});

test("loadStats has a .catch() handler", () => {
  const src = extractFn("loadStats");
  assert.ok(src.includes(".catch("), "loadStats must have a .catch() handler");
});

// ─── dynamic inline handler removal ──────────────────────────────────────────

test("renderRegistry does not embed model IDs in inline onclick handlers", () => {
  assert.ok(
    !SCRIPT.includes('onclick="editModel'),
    'renderRegistry must not use onclick="editModel(...)" inline handlers'
  );
});

test("renderAssignments does not embed agent names in inline onchange handlers", () => {
  assert.ok(
    !SCRIPT.includes('onchange="onAssignChange'),
    'renderAssignments must not use onchange="onAssignChange(...)" inline handlers'
  );
});

test("renderRegistry emits data-model-id attributes on Edit buttons", () => {
  assert.ok(
    SCRIPT.includes("data-model-id"),
    "renderRegistry must set data-model-id on Edit buttons"
  );
});

test("renderAssignments emits data-agent attributes on select elements", () => {
  assert.ok(
    SCRIPT.includes("data-agent"),
    "renderAssignments must set data-agent on select elements"
  );
});

test("renderRegistry attaches click listener via addEventListener after setting innerHTML", () => {
  const src = extractFn("renderRegistry");
  assert.ok(
    src.includes("addEventListener"),
    "renderRegistry must wire click handlers via addEventListener"
  );
  assert.ok(
    src.includes("dataset.modelId") || src.includes("dataset["),
    "renderRegistry must read modelId from dataset"
  );
});

test("renderAssignments attaches change listener via addEventListener after setting innerHTML", () => {
  const src = extractFn("renderAssignments");
  assert.ok(
    src.includes("addEventListener"),
    "renderAssignments must wire change handlers via addEventListener"
  );
  assert.ok(
    src.includes("dataset.agent") || src.includes("dataset["),
    "renderAssignments must read agent from dataset"
  );
});

// ─── Admin token embedding (Slice 4) ─────────────────────────────────────────

test("generateUI is exported from ui.js", () => {
  assert.equal(typeof generateUI, "function", "generateUI must be an exported function");
});

test("generateUI embeds the admin token in the returned HTML", () => {
  const token = "deadbeefcafe1234";
  const html = generateUI(token);
  assert.ok(typeof html === "string", "generateUI must return a string");
  assert.ok(html.includes(token), "generated HTML must contain the admin token");
});

test("generateUI embeds token in a JS variable, not in a JSON API endpoint", () => {
  const token = "abcdef0123456789";
  const html = generateUI(token);
  // Token must appear inside a <script> tag as a JS variable assignment
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, "generated HTML must contain a <script> block");
  const script = scriptMatch[1];
  assert.ok(script.includes(token), "token must be embedded in the inline script");
});

test("generateUI mutating fetch calls include x-model-tracker-admin-token header", () => {
  const token = "f00dface12345678";
  const html = generateUI(token);
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, "generated HTML must contain a <script> block");
  const script = scriptMatch[1];
  // The script must reference the admin token header for PUT and POST requests
  assert.ok(
    script.includes("x-model-tracker-admin-token"),
    "inline script must include x-model-tracker-admin-token header in mutating requests"
  );
});

test("generateUI does not log the admin token (no console.log of token)", () => {
  const token = "cafe0011deadbeef";
  const html = generateUI(token);
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, "generated HTML must contain a <script> block");
  const script = scriptMatch[1];
  // Ensure console.log is not present (or at least token isn't passed to it)
  const logPattern = /console\.log\s*\([^)]*cafe0011deadbeef/.test(script);
  assert.ok(!logPattern, "admin token must not be passed to console.log");
});

test("UI_HTML static export still works for backward compatibility", () => {
  // UI_HTML may be the no-token default HTML - it still must be a non-empty string
  assert.ok(typeof UI_HTML === "string" && UI_HTML.length > 0,
    "UI_HTML must remain a non-empty string export");
});

// ─── generateUI token input validation ───────────────────────────────────────

test("generateUI throws TypeError for token containing a single quote", () => {
  assert.throws(
    () => generateUI("abc'def"),
    TypeError,
    "generateUI must throw TypeError for token containing a single quote"
  );
});

test("generateUI throws TypeError for token containing </script>", () => {
  assert.throws(
    () => generateUI("</script>"),
    TypeError,
    "generateUI must throw TypeError for token containing </script>"
  );
});

test("generateUI throws TypeError for token containing uppercase hex chars", () => {
  assert.throws(
    () => generateUI("ABCDEF1234567890"),
    TypeError,
    "generateUI must throw TypeError for token with uppercase characters"
  );
});

test("generateUI throws TypeError for token containing spaces", () => {
  assert.throws(
    () => generateUI("abc def"),
    TypeError,
    "generateUI must throw TypeError for token containing spaces"
  );
});

test("generateUI accepts empty string token without throwing", () => {
  assert.doesNotThrow(() => generateUI(""), "generateUI must accept empty string token");
});

test("generateUI accepts valid lowercase hex token without throwing", () => {
  assert.doesNotThrow(
    () => generateUI("a1b2c3d4e5f67890"),
    "generateUI must accept valid lowercase hex token"
  );
});

// ─── Fix 1: renderDashboardRow uses row.run_count, not row.runs ───────────────

test("renderDashboardRow source uses row.run_count and does not use row.runs", () => {
  const src = extractFn("renderDashboardRow");
  assert.ok(
    src.includes("row.run_count"),
    "renderDashboardRow must reference row.run_count for the Runs column"
  );
  assert.ok(
    !src.includes("row.runs"),
    "renderDashboardRow must not reference row.runs (stats rows emit run_count)"
  );
});

// ─── Fix 2: renderDashboardRow row key uses stable fallback ───────────────────

test("renderDashboardRow source includes fallback using row.row_type and row.id for row key", () => {
  const src = extractFn("renderDashboardRow");
  assert.ok(
    src.includes("row.row_type"),
    "renderDashboardRow must use row.row_type in the row key fallback"
  );
  assert.ok(
    src.includes("row.id"),
    "renderDashboardRow must use row.id in the row key fallback"
  );
});

// ─── Cache write column ───────────────────────────────────────────────────────

test("renderDashboardRow includes cache-write-col cell referencing cache_write_tokens and cache_write_cost_usd", () => {
  const src = extractFn("renderDashboardRow");
  assert.ok(
    src.includes("cache_write_tokens"),
    "renderDashboardRow must reference cache_write_tokens for Cache write cell"
  );
  assert.ok(
    src.includes("cache_write_cost_usd"),
    "renderDashboardRow must reference cache_write_cost_usd for Cache write cell"
  );
  assert.ok(
    src.includes("cache-write-col"),
    "renderDashboardRow must emit a cell with class cache-write-col"
  );
});

test("script defines hasCacheWriteUsage helper", () => {
  assert.ok(
    SCRIPT.includes("hasCacheWriteUsage"),
    "script must define hasCacheWriteUsage helper"
  );
});

test("script defines setCacheWriteColumnVisibility helper", () => {
  assert.ok(
    SCRIPT.includes("setCacheWriteColumnVisibility"),
    "script must define setCacheWriteColumnVisibility helper"
  );
});

test("renderParentSessions calls setCacheWriteColumnVisibility", () => {
  const src = extractFn("renderParentSessions");
  assert.ok(
    src.includes("setCacheWriteColumnVisibility"),
    "renderParentSessions must call setCacheWriteColumnVisibility"
  );
});

test("renderAgents calls setCacheWriteColumnVisibility", () => {
  const src = extractFn("renderAgents");
  assert.ok(
    src.includes("setCacheWriteColumnVisibility"),
    "renderAgents must call setCacheWriteColumnVisibility"
  );
});

// ─── attachDashboardToggles idempotency (duplicate-row regression) ────────────

// Build a minimal DOM-like environment to run attachDashboardToggles and
// toggleDashboardRow in isolation, using real extracted function source.
function makeToggleEnv() {
  // Extract function sources
  const attachSrc = extractFn("attachDashboardToggles");
  const removeSrc = extractFn("removeChildRows");
  const toggleSrc = extractFn("toggleDashboardRow");

  // Create a simple event-target shim for a tr row (replaces old button shim)
  function makeRow(rowKey, childQuery) {
    const listeners = [];
    const row = {
      dataset: {
        toggleKind: "parent",
        rowKey: rowKey,
        childQuery: encodeURIComponent(JSON.stringify(childQuery || null)),
        toggleAttached: "",
      },
      _listeners: listeners,
      addEventListener(evt, fn) {
        listeners.push(fn);
      },
      click() {
        // Invoke all registered click listeners (simulates accumulated listeners)
        listeners.forEach(function(fn) { fn(); });
      },
      querySelector() { return null; }, // no icon span in this minimal test
      parentNode: null,
    };
    return row;
  }

  // Minimal tbody shim
  function makeTbody(rows) {
    const tbody = {
      _rows: rows,
      querySelectorAll(sel) {
        if (sel === "tr[data-child-query]") return this._rows;
        if (sel === "tr[data-parent-key]") return [];
        return [];
      },
      appendChild() {},
    };
    return tbody;
  }

  // Wrap all extracted functions in a factory that returns the functions we need.
  const factory = new Function(
    `
    var _expandedRows = {};
    ${attachSrc}
    ${removeSrc}
    var toggleCallCount = 0;
    function toggleDashboardRow(tbody, row) {
      toggleCallCount++;
      var rowKey = row.dataset.rowKey;
      if (_expandedRows[rowKey]) {
        _expandedRows[rowKey] = false;
        removeChildRows(tbody, rowKey);
      } else {
        _expandedRows[rowKey] = true;
      }
    }
    return { attachDashboardToggles, removeChildRows, getCallCount: function() { return toggleCallCount; } };
    `
  );

  const env = factory();
  return { makeButton: makeRow, makeRow, makeTbody, env };
}

test("attachDashboardToggles called twice on same tbody must result in exactly one toggle call per click", () => {
  const { makeRow, makeTbody, env } = makeToggleEnv();

  const row = makeRow("session:abc", { session_id: "abc" });
  const tbody = makeTbody([row]);

  // Simulate what the real code does: attach twice (e.g. initial render + after child insert)
  env.attachDashboardToggles(tbody);
  env.attachDashboardToggles(tbody);

  // Click once — should call toggleDashboardRow exactly once
  row.click();

  assert.equal(
    env.getCallCount(),
    1,
    `Expected exactly 1 toggleDashboardRow call after one click, but got ${env.getCallCount()}. ` +
    "Attaching listeners twice accumulates duplicate handlers."
  );
});

test("attachDashboardToggles on mixed tbody attaches listener to new button without adding duplicate to already-attached button", () => {
  const { makeRow, makeTbody, env } = makeToggleEnv();

  const existing = makeRow("session:existing", { session_id: "existing" });
  const newRow = makeRow("session:new", { session_id: "new" });

  // First attach: existing row gets its listener
  const tbody = makeTbody([existing]);
  env.attachDashboardToggles(tbody);

  // Simulate inserting a new row into the tbody (replace rows list)
  tbody._rows = [existing, newRow];

  // Second attach: should skip existing, attach to new
  env.attachDashboardToggles(tbody);

  // Click existing once - must still be exactly 1 call (no duplicate)
  existing.click();
  assert.equal(
    env.getCallCount(),
    1,
    `Expected 1 call after clicking existing row, got ${env.getCallCount()}`
  );

  // Click new row once - must fire exactly 1 additional call
  newRow.click();
  assert.equal(
    env.getCallCount(),
    2,
    `Expected 2 total calls after clicking both rows once each, got ${env.getCallCount()}. ` +
    "New row must receive a listener on the second attach call."
  );
});

// ─── Hierarchy row-click toggle: no <button>, tr[data-child-query], inline icon ─

test("renderDashboardRow does not emit a hierarchy toggle <button> element", () => {
  // Expandable rows must use a span icon, not a button, for the toggle affordance.
  const src = extractFn("renderDashboardRow");
  assert.ok(
    !src.includes("<button") || !src.includes("data-toggle-kind"),
    "renderDashboardRow must not emit a <button> with data-toggle-kind for hierarchy toggles"
  );
});

test("renderDashboardRow emits data-child-query on the <tr> element when row has child_query", () => {
  const src = extractFn("renderDashboardRow");
  assert.ok(
    src.includes("data-child-query"),
    "renderDashboardRow must emit data-child-query attribute on the <tr> for expandable rows"
  );
  // The data-child-query must be on the tr, not only on a button inside it
  const trSection = src.match(/<tr[^>]*>/)?.[0] ?? src.slice(src.indexOf("'<tr"), src.indexOf("'<tr") + 200);
  assert.ok(
    src.indexOf("data-child-query") < src.indexOf("</tr>") + 10,
    "data-child-query attribute must be part of the <tr> opening tag"
  );
});

test("renderDashboardRow does not emit button elements for expand/collapse", () => {
  const src = extractFn("renderDashboardRow");
  assert.ok(
    !src.includes('<button') && !src.includes("'button'"),
    "renderDashboardRow must not emit button elements for expand/collapse"
  );
});

test("attachDashboardToggles uses tr[data-child-query] selector, not button[data-toggle-kind]", () => {
  const src = extractFn("attachDashboardToggles");
  assert.ok(
    src.includes("tr[data-child-query]") || src.includes("[data-child-query]"),
    "attachDashboardToggles must use tr[data-child-query] selector for expandable rows"
  );
  assert.ok(
    !src.includes("button[data-toggle-kind]"),
    "attachDashboardToggles must not use the old button[data-toggle-kind] selector"
  );
});

test("toggleDashboardRow reads child_query from row dataset (tr), not from a button's dataset", () => {
  const src = extractFn("toggleDashboardRow");
  // The function must accept (tbody, row) and read from row.dataset.childQuery.
  // The old code used btn.dataset - the new code must use the tr row directly.
  assert.ok(
    !src.includes("btn.dataset"),
    "toggleDashboardRow must not read dataset from a 'btn' variable (old button-based code)"
  );
});

// ─── Recursive child removal and _expandedRows cleanup (regression) ──────────

// Build a minimal DOM environment that simulates a two-level hierarchy:
//   parentRow (expandable) -> childRow (also expandable, pre-expanded in _expandedRows)
//     -> grandchildRow (concrete leaf)
// Collapsing parentRow must:
//   1. Remove childRow and grandchildRow from tbody
//   2. Clear _expandedRows for childRow's rowKey so re-expanding parent then
//      clicking child once expands it (not a stale collapse no-op)
function makeRecursiveEnv() {
  const removeSrc = extractFn("removeChildRows");

  function makeRow(rowKey, parentKey, isExpandable) {
    const row = {
      dataset: {
        rowKey: rowKey,
        parentKey: parentKey || "",
        toggleAttached: "",
        childQuery: isExpandable
          ? encodeURIComponent(JSON.stringify({ key: rowKey }))
          : "",
      },
      _removed: false,
      parentNode: null,
    };
    return row;
  }

  function makeTbody(rows) {
    const tbody = {
      _rows: rows.slice(),
      querySelectorAll(sel) {
        if (sel === "tr[data-parent-key]") {
          return this._rows.filter(function(r) { return r.dataset.parentKey; });
        }
        return [];
      },
      removeChild(row) {
        row._removed = true;
        this._rows = this._rows.filter(function(r) { return r !== row; });
        row.parentNode = null;
      },
    };
    rows.forEach(function(r) { r.parentNode = tbody; });
    return tbody;
  }

  // Build env with real removeChildRows but _expandedRows we control
  const factory = new Function(
    `
    var _expandedRows = {};
    ${removeSrc}
    return {
      removeChildRows,
      getExpanded: function() { return _expandedRows; },
      setExpanded: function(key, val) { _expandedRows[key] = val; }
    };
    `
  );

  const env = factory();
  return { makeRow, makeTbody, env };
}

test("removeChildRows recursively removes descendant rows and clears _expandedRows for removed expandable rows", () => {
  const { makeRow, makeTbody, env } = makeRecursiveEnv();

  const parentRow = makeRow("session:parent", "", true);
  const childRow = makeRow("agent:child", "session:parent", true);
  const grandchildRow = makeRow("model:grandchild", "agent:child", false);

  const tbody = makeTbody([parentRow, childRow, grandchildRow]);

  // Simulate childRow was previously expanded
  env.setExpanded("agent:child", true);

  // Collapse parentRow: removeChildRows should remove childRow, grandchildRow,
  // and clear _expandedRows["agent:child"]
  env.removeChildRows(tbody, "session:parent");

  // Both descendant rows must be removed
  assert.ok(childRow._removed, "childRow must be removed when parent is collapsed");
  assert.ok(grandchildRow._removed, "grandchildRow must be removed when parent is collapsed");

  // _expandedRows for childRow must be cleared so next expand click works
  const expanded = env.getExpanded();
  assert.ok(
    !expanded["agent:child"],
    "removeChildRows must clear _expandedRows for removed expandable descendant rows; " +
    "stale true state would cause next click to be a no-op collapse instead of expand"
  );
});

// ─── MD-3: toggleDashboardRow must render children at parent level + 1 ────────

// Build an env where toggleDashboardRow is run with real apiFetch stubbed,
// and renderDashboardRow is intercepted to capture the level argument.
function makeHierarchyLevelEnv(parentLevel) {
  const attachSrc = extractFn("attachDashboardToggles");
  const removeSrc = extractFn("removeChildRows");
  const toggleSrc = extractFn("toggleDashboardRow");

  // Capture the level values passed to renderDashboardRow
  const capturedLevels = [];

  function makeParentRow(rowKey, childQuery) {
    const row = {
      dataset: {
        toggleKind: "parent",
        rowKey: rowKey,
        childQuery: encodeURIComponent(JSON.stringify(childQuery || {})),
        toggleAttached: "",
        level: String(parentLevel),
      },
      _listeners: [],
      addEventListener(evt, fn) { this._listeners.push(fn); },
      click() { this._listeners.forEach(function(fn) { fn(); }); },
      querySelector() { return null; },
      parentNode: null,
    };
    return row;
  }

  function makeTbody(rows) {
    const tbody = {
      _rows: rows,
      querySelectorAll(sel) {
        if (sel === "tr[data-child-query]") return this._rows.filter(function(r) { return r.dataset.childQuery; });
        if (sel === "tr[data-parent-key]") return [];
        return [];
      },
      appendChild(el) { this._rows.push(el); },
      insertBefore(el, ref) { this._rows.push(el); },
    };
    rows.forEach(function(r) { r.parentNode = tbody; r.nextSibling = null; });
    return tbody;
  }

  // Stub apiFetch to return one synthetic child row immediately
  const childRow = { label: "child", has_children: false, child_query: null, row_key: "child:1" };
  const fakeFetchData = { rows: [childRow] };

  // Minimal document stub needed by toggleDashboardRow's child row insertion
  const fakeDocument = {
    createElement: function(tag) {
      const el = {
        innerHTML: "",
        get firstChild() {
          // Return a minimal tr-like node
          return {
            dataset: {},
            setAttribute: function() {},
            getAttribute: function() { return null; },
            parentNode: null,
            nextSibling: null,
          };
        },
        setAttribute: function() {},
        getAttribute: function() { return null; },
      };
      return el;
    },
  };

  const factory = new Function(
    "apiFetch",
    "capturedLevels",
    "document",
    `
    var _expandedRows = {};
    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
    function fmtTokens(v) { return v == null ? '—' : String(v); }
    function fmtUsd(v) { return v == null ? '—' : '$' + Number(v).toFixed(6); }
    function fmtBucket(row) { return { fresh: '—', cached: '—', output: '—' }; }
    function rowModelLabel(row) { return '—'; }
    function rowAgentLabel(row) { return '—'; }
    function hasCacheWriteUsage() { return false; }
    function setCacheWriteColumnVisibility() {}
    function renderDashboardRow(row, level, toggleKind) {
      capturedLevels.push(level);
      return '<tr data-row-key="child:1" data-toggle-kind="" data-level="' + (level || 0) + '"></tr>';
    }
    ${attachSrc}
    ${removeSrc}
    ${toggleSrc}
    return {
      toggleDashboardRow,
      attachDashboardToggles,
      getCapturedLevels: function() { return capturedLevels; },
    };
    `
  );

  const fakeApiFetch = function() {
    return Promise.resolve(fakeFetchData);
  };

  const env = factory(fakeApiFetch, capturedLevels, fakeDocument);
  return { makeParentRow, makeTbody, env, capturedLevels };
}

test("toggleDashboardRow renders child rows at parent data-level + 1, not always level 1", async () => {
  // Parent is at level 1 (already a child row itself); children should be at level 2.
  const { makeParentRow, makeTbody, env, capturedLevels } = makeHierarchyLevelEnv(1);

  const parentRow = makeParentRow("session:parent", { session_id: "p1" });
  const tbody = makeTbody([parentRow]);

  // Attach toggles then click
  env.attachDashboardToggles(tbody);
  parentRow.click();

  // Wait for the async apiFetch to resolve
  await new Promise(function(resolve) { setTimeout(resolve, 10); });

  assert.ok(
    capturedLevels.length > 0,
    "renderDashboardRow must have been called at least once for child rows"
  );
  assert.equal(
    capturedLevels[0],
    2,
    `Expected child to be rendered at level 2 (parent level 1 + 1), but got level ${capturedLevels[0]}. ` +
    "toggleDashboardRow must compute child level from parent's data-level, not hardcode 1."
  );
});

test("toggleDashboardRow renders child rows at level 1 when parent is a top-level row (level 0)", async () => {
  const { makeParentRow, makeTbody, env, capturedLevels } = makeHierarchyLevelEnv(0);

  const parentRow = makeParentRow("session:top", { session_id: "top1" });
  const tbody = makeTbody([parentRow]);

  env.attachDashboardToggles(tbody);
  parentRow.click();

  await new Promise(function(resolve) { setTimeout(resolve, 10); });

  assert.ok(capturedLevels.length > 0, "renderDashboardRow must be called for children");
  assert.equal(
    capturedLevels[0],
    1,
    `Expected child at level 1 (parent level 0 + 1), got ${capturedLevels[0]}`
  );
});

test("renderDashboardRow emits data-toggle-attached guard on tr level for idempotency", () => {
  // attachDashboardToggles must check data-toggle-attached on the tr to avoid duplicates
  const src = extractFn("attachDashboardToggles");
  // The guard must be checked on something that is NOT a button (old code checked btn.dataset)
  // It should check the tr row's dataset
  assert.ok(
    src.includes("data-toggle-attached") || src.includes("toggleAttached"),
    "attachDashboardToggles must check data-toggle-attached guard on the tr to avoid duplicate listeners"
  );
  // Must not check the guard only on a button
  assert.ok(
    !src.includes("btn.dataset.toggleAttached"),
    "attachDashboardToggles must not check toggleAttached on btn.dataset (no button selector)"
  );
});

// ─── Hierarchy visual/children fixes ─────────────────────────────────────────

test("renderDashboardRow with child_query but has_children:false emits no data-child-query, no pointer cursor", () => {
  const src = extractFn("renderDashboardRow");
  // The function source must check has_children === true, not just child_query != null
  assert.ok(
    src.includes("has_children === true") || src.includes("row.has_children"),
    "renderDashboardRow must check row.has_children to decide expandable affordance"
  );
  // The hasChildren variable must require has_children true, not just child_query presence
  assert.ok(
    !src.includes("var hasChildren = row.child_query != null"),
    "renderDashboardRow must not use child_query != null alone to determine expandability"
  );
});

test("renderDashboardRow with has_children:true emits data-level attribute on tr", () => {
  const src = extractFn("renderDashboardRow");
  assert.ok(
    src.includes("data-level"),
    "renderDashboardRow must emit data-level attribute on tr"
  );
});

test("renderDashboardRow no longer uses indentForLevel inline spacer in entity label", () => {
  const src = extractFn("renderDashboardRow");
  assert.ok(
    !src.includes("indentForLevel("),
    "renderDashboardRow must not call indentForLevel() — spacer replaced by CSS data-level"
  );
});

test("indentForLevel function is removed from script (dead code elimination)", () => {
  assert.ok(
    !SCRIPT.includes("function indentForLevel("),
    "indentForLevel must be removed from script — no longer used after CSS-based indentation"
  );
});

test("UI HTML contains hierarchy row level CSS for data-level attribute rows", () => {
  assert.ok(
    UI_HTML.includes("data-level") && (UI_HTML.includes("border-left") || UI_HTML.includes("padding-left")),
    "UI HTML must include CSS using data-level for hierarchy row visual grouping (border-left or padding-left)"
  );
});

test("renderParentSessions uses colspan 10 for empty/error rows", () => {
  const src = extractFn("renderParentSessions");
  assert.ok(src.includes('colspan="10"'), "renderParentSessions empty row must use colspan 10");
  assert.ok(!src.includes('colspan="11"'), "renderParentSessions must not use old colspan 11");
});

test("renderAgents uses colspan 10 for empty/error rows", () => {
  const src = extractFn("renderAgents");
  assert.ok(src.includes('colspan="10"'), "renderAgents empty row must use colspan 10");
  assert.ok(!src.includes('colspan="11"'), "renderAgents must not use old colspan 11");
});


test("rowAgentLabel renders agent-pill badge; sub-pill when sub_agents are present", () => {
  const rowAgentLabel = makeRowAgentLabelFn();

  // No agent → dash
  assert.equal(rowAgentLabel({}), '\u2014');

  // Agent with no sub_agents → single agent-pill only
  const soloHtml = rowAgentLabel({ agent: 'technical-lead' });
  assert.ok(soloHtml.includes('class="agent-pill"'), "must render agent-pill span");
  assert.ok(soloHtml.includes('technical-lead'), "must include agent name");
  assert.ok(!soloHtml.includes('sub'), "must not render sub badge when sub_agents absent");

  // Agent with empty sub_agents → no sub badge
  assert.ok(!rowAgentLabel({ agent: 'a', sub_agents: [] }).includes('sub'));

  // Agent + sub_agents → agent-pill + sub-pill with tooltip
  const html = rowAgentLabel({ agent: 'technical-lead', sub_agents: ['backend-engineer', 'qa'] });
  assert.ok(html.includes('class="agent-pill"'), "must render orchestrator agent-pill");
  assert.ok(html.includes('technical-lead'), "must include orchestrator name");
  assert.ok(html.includes('+2'), "must render sub count");
  assert.ok(html.includes('backend-engineer, qa'), "sub-pill title must list agent names");
  assert.ok(html.includes('sub-pill'), "must use sub-pill class");

  // XSS: sub_agent names with angle brackets must be HTML-escaped
  const xssHtml = rowAgentLabel({ agent: 'a', sub_agents: ['<script>alert(1)</script>'] });
  assert.ok(!xssHtml.includes('<script>'), 'raw <script> tag must not appear in output');
  assert.ok(xssHtml.includes('&lt;script&gt;'), 'angle brackets must be HTML-entity-escaped');
});
