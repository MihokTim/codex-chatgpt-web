import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandUserPath } from "./config";

/**
 * Resolve the native Codex home that owns task rollouts, SQLite state and visualization outputs.
 *
 * Web Codex runs with an isolated CODEX_HOME. Its launcher preserves the user's native home in
 * CODEX_WEB_GPT_NATIVE_HOME so the bridge can authenticate task artifacts without reading them
 * from the Web configuration home.
 */
export function getNativeCodexHome(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.CODEX_WEB_GPT_NATIVE_HOME?.trim()
    || environment.CODEX_HOME?.trim();
  return resolve(configured ? expandUserPath(configured) : join(homedir(), ".codex"));
}
