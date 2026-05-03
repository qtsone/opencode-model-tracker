// tests/package-exports.test.js
//
// Regression test: the npm package must expose the OpenCode server plugin
// entrypoint via exports["./server"] so that OpenCode can auto-detect and
// start the plugin server (http://127.0.0.1:4747).
//
// Root cause: OpenCode resolves server plugins by looking for
//   exports["./server"]  OR  package.json#main
// Without this export the plugin server is never started.

import { strict as assert } from "assert";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, "..", "package.json");

const require = createRequire(import.meta.url);
const pkg = require(pkgPath);

test("package.json exports['./server'] exposes the OpenCode server plugin entrypoint", () => {
  assert.ok(
    pkg.exports != null && typeof pkg.exports === "object",
    "package.json must have an exports field"
  );

  assert.strictEqual(
    pkg.exports["./server"],
    "./src/index.js",
    "exports['./server'] must point to './src/index.js' so OpenCode can detect and start the server plugin"
  );
});
