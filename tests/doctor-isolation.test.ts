import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultConfig, getConfigPath, saveConfig } from "../src/config";
import {
  getCodexJournalPath, getCodexJournalRecoveryPath, installCodexIntegration,
} from "../src/codex-integration";
import { runDoctor } from "../src/doctor";
import * as serviceModule from "../src/service";
import * as tunnelServiceModule from "../src/tunnel-service";
import * as tunnelModule from "../src/tunnel";

const originalHome = process.env.CODEX_HOME;
const originalAppHome = process.env.CODEX_CHATGPT_WEB_HOME;
const roots: string[] = [];
const restoreMocks: Array<() => void> = [];

afterEach(() => {
  for (const restore of restoreMocks.splice(0).reverse()) restore();
  if (originalHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalHome;
  if (originalAppHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
  else process.env.CODEX_CHATGPT_WEB_HOME = originalAppHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("doctor integration failure isolation", () => {
  for (const mode of ["browser-only", "full"] as const) {
    for (const failure of ["malformed", "different-home"] as const) {
      test(`${mode} continues independent checks after a ${failure} journal inspection error`, async () => {
        const root = mkdtempSync(join(tmpdir(), "doctor-isolation-"));
        roots.push(root);
        const codexHome = join(root, "codex");
        mkdirSync(codexHome);
        process.env.CODEX_HOME = codexHome;
        process.env.CODEX_CHATGPT_WEB_HOME = join(root, "app");
        const config = defaultConfig(mode);
        config.subagentProtocol = "native";
        config.chromeExecutablePath = join(root, "chrome.exe");
        writeFileSync(config.chromeExecutablePath, "fixture, never executed");
        if (mode === "full") {
          config.tunnel = {
            binaryPath: join(root, "tunnel-client.exe"),
            tunnelId: `tunnel_${"0".repeat(32)}`,
            runtimeKeyFile: join(root, "tunnel-key"),
            profileDir: join(root, "tunnel-profile"),
            profileName: "fixture", alias: "fixture",
          };
        }
        saveConfig(config);
        const configPath = join(codexHome, "config.toml");
        const hooksPath = join(codexHome, "hooks.json");
        writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
        writeFileSync(hooksPath, '{"hooks":{}}\n');
        const primary = getCodexJournalPath();
        const recovery = getCodexJournalRecoveryPath();
        let expectedDetail: string;
        if (failure === "malformed") {
          mkdirSync(dirname(primary), { recursive: true });
          writeFileSync(primary, '{"version":10}');
          expectedDetail = "Invalid Codex integration journal";
        } else {
          installCodexIntegration(config);
          rmSync(recovery);
          const otherHome = join(root, "orca-codex");
          mkdirSync(otherHome);
          process.env.CODEX_HOME = otherHome;
          expectedDetail = `Codex integration journal belongs to ${configPath}, not the active config ${join(otherHome, "config.toml")}`;
        }
        const paths = [getConfigPath(), configPath, hooksPath, primary, recovery];
        const snapshot = () => paths.map(path => existsSync(path) ? readFileSync(path) : null);
        const before = snapshot();

        // OS status and HTTP are isolated too: no live service, proxy, or tunnel is queried.
        const service = spyOn(serviceModule, "getServiceStatus").mockReturnValue({
          supported: false, installed: false, loaded: false, label: "fixture",
        });
        restoreMocks.push(() => service.mockRestore());
        const proxy = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
          service: "codex-chatgpt-web", status: "ok", mode,
          version: config.releaseVersion, accepting_turns: true,
        }));
        restoreMocks.push(() => proxy.mockRestore());
        const tunnelService = spyOn(tunnelServiceModule, "getTunnelServiceStatus").mockReturnValue({
          supported: false, installed: false, loaded: false, running: false, label: "fixture",
        });
        restoreMocks.push(() => tunnelService.mockRestore());
        const tunnel = spyOn(tunnelModule, "tunnelStatus").mockReturnValue({
          ok: false, processRunning: false, healthy: false, ready: false, detail: "fixture unavailable",
        });
        restoreMocks.push(() => tunnel.mockRestore());

        const report = await runDoctor();
        expect(report.ok).toBe(false);
        expect(report.mode).toBe(mode);
        expect(report.checks.filter(check => check.id === "codex")).toEqual([{
          id: "codex", status: "error", message: "Codex integration inspection failed",
          detail: expect.stringContaining(expectedDetail),
        }]);
        expect(service).toHaveBeenCalledTimes(1);
        expect(proxy).toHaveBeenCalledTimes(1);
        expect(report.checks.find(check => check.id === "proxy")?.status).toBe("ok");
        const ids = report.checks.map(check => check.id);
        expect(ids.indexOf("service")).toBeGreaterThan(ids.indexOf("codex"));
        if (mode === "full") {
          expect(tunnelService).toHaveBeenCalledTimes(1);
          expect(tunnel).toHaveBeenCalledTimes(1);
          for (const id of ["tunnel-binary", "tunnel-key", "tunnel-service", "tunnel-runtime", "connector"]) {
            expect(ids).toContain(id);
          }
        } else {
          expect(tunnelService).not.toHaveBeenCalled();
          expect(tunnel).not.toHaveBeenCalled();
          expect(ids).toContain("tools");
        }
        expect(snapshot()).toEqual(before);
      });
    }
  }
});
