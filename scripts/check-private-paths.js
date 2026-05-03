#!/usr/bin/env node
// scripts/check-private-paths.js
// Scans publication-relevant text files for forbidden private-path patterns.
// Exits 1 with listed matches if any forbidden pattern is found.

import { readFileSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";
import { glob } from "node:fs/promises";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

// Sensitive pattern strings are assembled via concatenation so this scanner
// file does not trigger its own rules when scanned.
const forbidden = [
  new RegExp("/" + "Users" + "/[A-Za-z0-9._-]+"),
  new RegExp("Sea" + "file"),
  new RegExp("ic" + "loud" + "\\.com", "i"),
  /BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY/,
  // Matches the admin token variable in bare assignments, shell exports,
  // and JSON-style key-value pairs. Pattern split to avoid self-match.
  new RegExp("MODEL_TRACKER_ADMIN" + '_TOKEN["\']?\\s*[=:]\\s*["\']?\\S'),
];

// Patterns for files to ignore
const IGNORE_DIRS = [
  /^\.git\//,
  /^node_modules\//,
  /^docs\//,
];

const IGNORE_FILE_PATTERNS = [
  /\.sqlite(-[a-z]+)?$/i,
  /\.tgz$/,
  /\.log$/,
  /\.lock$/,
];

// Binary file detection: check for null bytes in first 8kb
function isBinary(filePath) {
  try {
    const buf = readFileSync(filePath);
    const sample = buf.slice(0, 8192);
    return sample.includes(0);
  } catch {
    return true;
  }
}

// Explicit list of root-level files to include
const ROOT_FILES = [
  "models.example.json",
  "package.json",
  "README.md",
  "LICENSE",
  ".gitignore",
  "package-lock.json",
];

// Glob patterns for directory subtrees to scan
const GLOB_PATTERNS = [
  "src/**",
  "tests/**",
  "scripts/**",
  ".github/**",
];

async function collectFiles() {
  const files = new Set();

  // Add root files that exist
  for (const name of ROOT_FILES) {
    const full = resolve(REPO_ROOT, name);
    try {
      statSync(full);
      files.add(full);
    } catch {
      // file not present, skip
    }
  }

  // Glob directory subtrees
  for (const pattern of GLOB_PATTERNS) {
    for await (const entry of glob(pattern, { cwd: REPO_ROOT })) {
      const full = resolve(REPO_ROOT, entry);
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
      } catch {
        continue;
      }
      files.add(full);
    }
  }

  return [...files];
}

function shouldIgnore(filePath) {
  const rel = relative(REPO_ROOT, filePath).replace(/\\/g, "/");

  for (const dir of IGNORE_DIRS) {
    if (dir.test(rel)) return true;
  }
  for (const pat of IGNORE_FILE_PATTERNS) {
    if (pat.test(rel)) return true;
  }
  return false;
}

async function main() {
  const files = await collectFiles();
  const matches = [];

  for (const filePath of files) {
    if (shouldIgnore(filePath)) continue;
    if (isBinary(filePath)) continue;

    let content;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const rel = relative(REPO_ROOT, filePath);
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const pattern of forbidden) {
        if (pattern.test(lines[i])) {
          matches.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
  }

  if (matches.length > 0) {
    process.stderr.write("FAIL: forbidden patterns found:\n");
    for (const m of matches) {
      process.stderr.write(`  ${m}\n`);
    }
    process.exit(1);
  }

  console.log(`check:private-paths ok (${files.length} files scanned)`);
}

main().catch((err) => {
  process.stderr.write(`check-private-paths error: ${err.message}\n`);
  process.exit(1);
});
