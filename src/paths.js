// src/paths.js
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const EXAMPLE_REGISTRY_PATH = join(PACKAGE_DIR, "models.example.json");

export function getDefaultOpenCodeConfigDir() {
  return process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode");
}

export const CONFIG_DIR = getDefaultOpenCodeConfigDir();
export const REGISTRY_PATH = process.env.MODEL_TRACKER_REGISTRY_PATH || join(CONFIG_DIR, "model-tracker", "models.json");
export const PERFORMANCE_DB_PATH = process.env.MODEL_TRACKER_DB_PATH || join(CONFIG_DIR, "model-tracker", "model-performance.sqlite");
export const AGENT_DIR = process.env.MODEL_TRACKER_AGENT_DIR || join(CONFIG_DIR, "agent");
export const OPENCODE_JSON = process.env.MODEL_TRACKER_OPENCODE_JSON || join(CONFIG_DIR, "opencode.json");

export function ensureParentDir(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

export function registryExists(registryPath = REGISTRY_PATH) {
  return existsSync(registryPath);
}
