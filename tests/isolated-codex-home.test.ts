import { plist } from "../src/service";
import { webCodexEnvironment } from "../src/web-codex";
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, saveConfig } from "../src/config";
import { installCodexIntegration, uninstallCodexIntegration, preflightCodexIntegration, inspectCodexIntegration } from "../src/codex-integration";
import { installRoute } from "../src/codex-integration-route";
import { installCompatibilityV1Features, textFormat } from "../src/codex-integration-document";
import { CODEX_REALTIME_WEBRTC_CALL_BASE_URL, getCodexJournalPath, getCodexJournalRecoveryPath } from "../src/codex-integration-shared";
import { planHomeMigration, migrateHome } from "../src/codex-home-migration";
import { resolveWebHome } from "../launcher/electron/web-home.cjs";

function fixture(action: (f: { native: string; web: string; core: string; original: string; config: ReturnType<typeof defaultConfig>; legacy: () => void }) => void) {
  const root = mkdtempSync(join(tmpdir(), "web-home-lifecycle-"));
  const native = join(root, "native"), core = join(root, "core"), web = join(core, "codex-home");
  const old = { ...process.env };
  try {
    mkdirSync(native);
    process.env.CODEX_HOME = native;
    process.env.CODEX_CHATGPT_WEB_HOME = core;
    delete process.env.CODEX_WEB_GPT_CODEX_HOME;
    const original = 'model = "gpt-6-astra"\nmodel_reasoning_effort = "medium"\n';
    writeFileSync(join(native, "config.toml"), original);
    const config = defaultConfig("browser-only");
    config.solAvailable = true; config.proAvailable = true;
    saveConfig(config);
    const legacy = () => {
      // Released v9 format, before profile ownership and home isolation.
      const route = installRoute(readFileSync(join(native, "config.toml"), "utf8"), `http://${config.host}:${config.port}/v1`, false, false);
      const features = installCompatibilityV1Features(route.text);
      const journal = { version: 9, active: true, configPath: join(native, "config.toml"),
        installed: { openai_base_url: `http://${config.host}:${config.port}/v1`, experimental_realtime_webrtc_call_base_url: CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
          subagent_protocol: "compatibility-v1", agent_max_depth: features.installedAgentMaxDepth },
        previous: route.previous, previousRealtimeWebrtcCallBaseUrl: route.previousRealtimeWebrtcCallBaseUrl,
        previousMultiAgent: features.previousMultiAgent, previousMultiAgentV2: features.previousMultiAgentV2, previousAgentMaxDepth: features.previousAgentMaxDepth,
        format: textFormat(original) };
      writeFileSync(join(native, "config.toml"), features.text);
      mkdirSync(join(core, "codex"), { recursive: true });
      for (const path of [getCodexJournalPath(), getCodexJournalRecoveryPath()]) writeFileSync(path, JSON.stringify(journal));
    };
    action({ native, web, core, config, original, legacy });
  } finally {
    for (const key of ["CODEX_HOME", "CODEX_CHATGPT_WEB_HOME", "CODEX_WEB_GPT_CODEX_HOME"]) {
      if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
    }
    rmSync(root, { recursive: true, force: true });
  }
}
function assertWeb(web: string) {
  const value: any = Bun.TOML.parse(readFileSync(join(web, "config.toml"), "utf8"));
  expect(value.model).toBe("chatgpt-web/pro");
  expect(value.model_reasoning_effort).toBe("ultra");
  expect(value.agents.default_subagent_model).toBe("chatgpt-web/extra-high");
  expect(value.agents.default_subagent_reasoning_effort).toBeUndefined();
  expect(value.developer_instructions).toBeUndefined();
  expect(value.windows).toBeUndefined();
  expect(value.features.multi_agent_v2).toBe(false);
}
test("fresh setup ignores ambient native home, installs defaults idempotently and restores ownership", () => fixture(({ native, web, original, config }) => {
  preflightCodexIntegration(config);
  expect(existsSync(join(web, "config.toml"))).toBe(false);
  const journal = installCodexIntegration(config);
  assertWeb(web);
  expect(readFileSync(join(native, "config.toml"), "utf8")).toBe(original);
  const text = readFileSync(join(web, "config.toml"), "utf8");
  expect(installCodexIntegration(config)).toEqual(journal);
  expect(readFileSync(join(web, "config.toml"), "utf8")).toBe(text);
  uninstallCodexIntegration();
  expect(readFileSync(join(web, "config.toml"), "utf8")).toBe("");
}));
test("normal install migrates released journal, native cache and local auth; re-entry is safe", () => fixture(({ native, web, original, config, legacy }) => {
  legacy();
  writeFileSync(join(native, "models_cache.json"), "old-web-catalog");
  writeFileSync(join(native, "auth.json"), "private-fixture");
  preflightCodexIntegration(config);
  expect(existsSync(join(web, "config.toml"))).toBe(false);
  installCodexIntegration(config);
  expect(readFileSync(join(native, "config.toml"), "utf8")).toBe(original);
  expect(existsSync(join(native, "models_cache.json"))).toBe(false);
  expect(readFileSync(join(web, "auth.json"), "utf8")).toBe("private-fixture");
  assertWeb(web);
  installCodexIntegration(config);
  expect(inspectCodexIntegration().errors).toEqual([]);
}));
for (const step of ["native-restored", "web-installed"]) test(`migration compensates failure at ${step}`, () => fixture(({ native, web, config, legacy }) => {
  legacy();
  writeFileSync(join(native, "models_cache.json"), "cache-before");
  const before = readFileSync(join(native, "config.toml"), "utf8");
  const journalBefore = readFileSync(getCodexJournalPath(), "utf8");
  expect(() => migrateHome(planHomeMigration()!, () => installCodexIntegration(config), point => { if (point === step) throw new Error("injected"); })).toThrow("injected");
  expect(readFileSync(join(native, "config.toml"), "utf8")).toBe(before);
  expect(readFileSync(getCodexJournalPath(), "utf8")).toBe(journalBefore);
  expect(readFileSync(join(native, "models_cache.json"), "utf8")).toBe("cache-before");
  expect(existsSync(join(web, "config.toml"))).toBe(false);
  expect(existsSync(join(web, "models_cache.json"))).toBe(false);
  installCodexIntegration(config);
  assertWeb(web);
}));
for (const file of ["auth.json", "AGENTS.md", "models_cache.json"]) test(`migration preserves partial target ${file}`, () => fixture(({ web, config, legacy }) => {
  legacy(); mkdirSync(web, { recursive: true }); writeFileSync(join(web, file), "existing");
  expect(() => installCodexIntegration(config)).toThrow("not empty");
  expect(readFileSync(join(web, file), "utf8")).toBe("existing");
}));
test("migration refuses unmanaged Web settings in native config", () => fixture(({ native, config, legacy }) => {
  writeFileSync(join(native, "config.toml"), 'model = "chatgpt-web/pro"\n'); legacy();
  expect(() => installCodexIntegration(config)).toThrow("unmanaged Web model");
}));
test("Web profile refuses post-install model drift and preserves unrelated user preferences", () => fixture(({ web, config }) => {
  mkdirSync(web, { recursive: true });
  const original = 'model = "chatgpt-web/high" # user\n[windows]\nsandbox = "unelevated"\n';
  writeFileSync(join(web, "config.toml"), original);
  installCodexIntegration(config);
  const managed = readFileSync(join(web, "config.toml"), "utf8");
  writeFileSync(join(web, "config.toml"), managed.replace('model = "chatgpt-web/pro"', 'model = "chatgpt-web/light"'));
  expect(() => installCodexIntegration(config)).toThrow("changed");
  writeFileSync(join(web, "config.toml"), managed);
  uninstallCodexIntegration();
  expect(readFileSync(join(web, "config.toml"), "utf8")).toBe(original);
}));
test("Web home resolver rejects default native, custom native and junction aliases", () => fixture(({ native, core }) => {
  expect(() => resolveWebHome(core, { CODEX_WEB_GPT_CODEX_HOME: native, CODEX_HOME: native })).toThrow("must differ");
  expect(() => resolveWebHome(core, { CODEX_WEB_GPT_CODEX_HOME: join(core, ".codex") }, core)).toThrow("must differ");
  const alias = join(core, "alias"); symlinkSync(native, alias, process.platform === "win32" ? "junction" : "dir");
  expect(() => resolveWebHome(core, { CODEX_WEB_GPT_CODEX_HOME: alias, CODEX_HOME: native })).toThrow("must differ");
}));

test("service restart and Codex child hooks resolve the same dedicated home", () => fixture(({ native, web, core, config }) => {
  const custom = join(core, "custom-web");
  process.env.CODEX_WEB_GPT_CODEX_HOME = custom;
  installCodexIntegration(config);
  const definition = plist(config);
  expect(definition).toContain(`<key>CODEX_WEB_GPT_CODEX_HOME</key>\n    <string>${custom}</string>`);
  const client = webCodexEnvironment();
  expect(client.CODEX_HOME).toBe(custom);
  expect(client.CODEX_WEB_GPT_NATIVE_HOME).toBe(native);
  expect(resolveWebHome(core, client)).toBe(custom);
  expect(client.CODEX_ELECTRON_USER_DATA_PATH).toBe(join(core, "desktop"));
}));
test("a custom Web override cannot adopt an existing legacy native journal target", () => fixture(({ native, config, legacy }) => {
  legacy(); delete process.env.CODEX_HOME;
  process.env.CODEX_WEB_GPT_CODEX_HOME = native;
  expect(() => installCodexIntegration(config)).toThrow("legacy native journal target");
}));

test("profile ensure preserves recovery from a corrupt primary journal", () => fixture(({ config }) => {
  installCodexIntegration(config);
  writeFileSync(getCodexJournalPath(), "invalid-json");
  installCodexIntegration(config);
  expect(inspectCodexIntegration().errors).toEqual([]);
}));

test("profile ownership cannot mistake a multiline prompt example for a root model", () => fixture(({ web, config }) => {
  mkdirSync(web, { recursive: true });
  const original = `developer_instructions = '''\nmodel = "example-only"\n'''\n`;
  writeFileSync(join(web, "config.toml"), original);
  expect(() => installCodexIntegration(config)).toThrow("plain TOML assignment");
  expect(readFileSync(join(web, "config.toml"), "utf8")).toBe(original);
  expect(existsSync(getCodexJournalPath())).toBe(false);
}));


test("model selection does not invalidate read-only readiness or weaken write conflict protection", () => fixture(({ web, config }) => {
  installCodexIntegration(config);
  const path = join(web, "config.toml");
  const changed = readFileSync(path, "utf8").replace('model = "chatgpt-web/pro"', 'model = "chatgpt-web/extra-high"').replace('model_reasoning_effort = "ultra"', 'model_reasoning_effort = "xhigh"');
  writeFileSync(path, changed);
  expect(inspectCodexIntegration()).toMatchObject({ active: true, errors: [] });
  expect(() => installCodexIntegration(config)).toThrow("Web profile model changed");
  expect(() => uninstallCodexIntegration()).toThrow("Web profile model changed");
  expect(readFileSync(path, "utf8")).toBe(changed);
  writeFileSync(path, changed.replace('http://127.0.0.1:', 'http://localhost:'));
  expect(inspectCodexIntegration().errors.length).toBeGreaterThan(0);
}));
