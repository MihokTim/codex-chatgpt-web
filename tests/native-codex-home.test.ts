import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getNativeCodexHome } from "../src/native-codex-home";

test("native Codex home stays separate from the isolated Web home", () => {
  const environment = {
    CODEX_WEB_GPT_NATIVE_HOME: join(homedir(), "native-codex"),
    CODEX_HOME: join(homedir(), "isolated-web-codex"),
  } as NodeJS.ProcessEnv;

  expect(getNativeCodexHome(environment)).toBe(resolve(homedir(), "native-codex"));
});

test("native Codex home falls back to CODEX_HOME and expands the user directory", () => {
  expect(getNativeCodexHome({ CODEX_HOME: "~/.codex-test" } as NodeJS.ProcessEnv))
    .toBe(resolve(homedir(), ".codex-test"));
  expect(getNativeCodexHome({} as NodeJS.ProcessEnv)).toBe(resolve(homedir(), ".codex"));
});
