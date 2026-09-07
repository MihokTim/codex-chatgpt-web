import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { getConfigDir } from "./config";
import { getCodexHome, inspectCodexIntegration } from "./codex-integration";

/** Native Codex owns all model selection and subagent semantics after this environment handoff. */
export function webCodexEnvironment(): NodeJS.ProcessEnv {
  const home = getCodexHome();
  return { ...process.env,
    CODEX_WEB_GPT_NATIVE_HOME: process.env.CODEX_WEB_GPT_NATIVE_HOME || process.env.CODEX_HOME || join(homedir(), ".codex"),
    CODEX_WEB_GPT_CODEX_HOME: home,
    CODEX_HOME: home,
    CODEX_ELECTRON_USER_DATA_PATH: join(getConfigDir(), "desktop"),
  };
}
export async function startWebCodex(executable: string, args: string[], desktop: boolean): Promise<number> {
  const status = inspectCodexIntegration();
  if (!status.active || status.errors.length) throw new Error("Web integration is not ready; run setup first");
  const env = webCodexEnvironment();
  const child = spawn(executable, desktop ? [`--user-data-dir=${env.CODEX_ELECTRON_USER_DATA_PATH}`, ...args] : args,
    { env, stdio: desktop ? "ignore" : "inherit", windowsHide: true, detached: desktop });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    if (desktop) child.once("spawn", () => { child.unref(); resolve(0); });
    else child.once("exit", code => resolve(code ?? 1));
  });
}
