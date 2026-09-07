import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfig, saveConfig } from "../src/config";
import { installCodexIntegration } from "../src/codex-integration";

test("migration restores native settings and confines Web defaults and hooks to its own home", () => {
  const root = mkdtempSync(join(tmpdir(), "web-home-migration-"));
  const native = join(root, "native");
  const web = join(root, "web");
  const previous = { native: process.env.CODEX_HOME, web: process.env.CODEX_CHATGPT_WEB_HOME };
  try {
    mkdirSync(native);
    const original = 'model = "gpt-6-astra"\nmodel_reasoning_effort = "medium"\n';
    writeFileSync(join(native, "config.toml"), original);
    process.env.CODEX_HOME = native;
    process.env.CODEX_CHATGPT_WEB_HOME = web;
    const config = defaultConfig("browser-only");
    config.proAvailable = true;
    config.solAvailable = true;
    saveConfig(config);
    installCodexIntegration(config);
    const script = resolve(import.meta.dir, "../scripts/migrate-isolated-codex-home.ts");
    const run = Bun.spawnSync([process.execPath, script, native], { stdout: "pipe", stderr: "pipe", env: { ...process.env, CODEX_HOME: native, CODEX_CHATGPT_WEB_HOME: web } });
    if (run.exitCode !== 0) throw new Error(run.stderr.toString());
    expect(readFileSync(join(native, "config.toml"), "utf8")).toBe(original);
    const webHome = join(web, "codex-home");
    const result = Bun.TOML.parse(readFileSync(join(webHome, "config.toml"), "utf8")) as any;
    expect(result.model).toBe("chatgpt-web/pro");
    expect(result.agents.default_subagent_model).toBe("chatgpt-web/extra-high");
    expect(result.agents.default_subagent_reasoning_effort).toBeUndefined();
    expect(result.features.multi_agent_v2).toBe(false);
    expect(result.hooks.Interrupt).toHaveLength(1);
    const journal = JSON.parse(readFileSync(join(web, "codex/integration-journal.json"), "utf8"));
    expect(journal.configPath).toBe(join(webHome, "config.toml"));
    const second = Bun.spawnSync([process.execPath, script, native], { stdout: "pipe", stderr: "pipe", env: { ...process.env, CODEX_HOME: native, CODEX_CHATGPT_WEB_HOME: web } });
    expect(second.exitCode).not.toBe(0);
    expect(readFileSync(join(native, "config.toml"), "utf8")).toBe(original);
  } finally {
    if (previous.native === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous.native;
    if (previous.web === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME = previous.web;
    rmSync(root, { recursive: true, force: true });
  }
});