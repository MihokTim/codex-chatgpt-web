import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { defaultChromeExecutable } from "../src/config";
import { ChatGptBrowserWorker, ChatGptCompletionTracker } from "../src/adapters/chatgpt-web/browser-worker";
import { formatChatGptWebMultipartStage } from "../src/adapters/chatgpt-web/prompt";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let browser: Browser;
let context: BrowserContext;
beforeAll(async () => {
  browser = await chromium.launch({ executablePath: defaultChromeExecutable(), headless: true });
  context = await browser.newContext();
});
afterAll(async () => { await browser?.close(); });
const stage = formatChatGptWebMultipartStage(JSON.stringify({ context: "fixture context" }), "ctx_0123456789abcdef0123456789abcdef", 1, 2);
const user = '<div data-turn-id-container="sent-user"><section data-turn-id="sent-user" data-testid="conversation-turn-0" data-turn="user">fixture context</section></div>';
const assistant = (id: string, text: string) => `<div data-turn-id-container="${id}"><section data-turn-id="${id}" data-testid="conversation-turn-${id}" data-turn="assistant"><div class="markdown">${text}</div><button data-testid="copy-turn-action-button">Copy</button></section></div>`;

async function submitted(page: Page) {
  const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
  await page.setContent('<main></main>');
  const baseline = await worker.captureSubmissionBaseline(page, "fixture context");
  await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, user);
  expect(await worker.currentSubmissionEvidence(page, baseline)).toBe("user_turn");
  return { worker, baseline };
}

test("multipart ACK survives removal of the proven user container and permits the next part", async () => {
  const page = await context.newPage();
  try {
    const { worker, baseline } = await submitted(page);
    await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, assistant("ack", stage.acknowledgement));
    const binding = await worker.waitForNewAssistantTurn(page, baseline, undefined, undefined, undefined, 300, undefined, undefined, stage.acknowledgement);
    expect(binding.identity).toBe("ack");
    await worker.waitForMultipartAcknowledgement(page, binding, baseline, stage, Date.now() + 1_000, undefined, undefined, new ChatGptCompletionTracker(0));
    // A successful ACK is the prerequisite to preparing the second physical message.
    const next = await worker.captureSubmissionBaseline(page, "second part");
    expect(next.initialTurnIdentities).toEqual(["ack"]);
  } finally { await page.close(); }
}, 30_000);

test.each(["ordinary", "wrong-transaction", "wrong-part", "wrong-hash", "extra-text", "quoted-user", "new-user"])("detached user never grants ownership to %s", async scenario => {
  const page = await context.newPage();
  try {
    const { worker, baseline } = await submitted(page);
    const text = scenario === "wrong-transaction" ? stage.acknowledgement.replace("ctx_", "ctx_other_")
      : scenario === "wrong-part" ? stage.acknowledgement.replace("1/2", "2/2")
      : scenario === "wrong-hash" ? stage.acknowledgement.replace(stage.sha256, "0".repeat(64))
      : scenario === "extra-text" ? stage.acknowledgement + " unexpected text" : stage.acknowledgement;
    const markup = scenario === "quoted-user" ? user.replace("fixture context", text)
      : (scenario === "new-user" ? user.replaceAll("sent-user", "unowned-user") : "") + assistant("ack", text);
    await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, markup);
    await expect(worker.waitForNewAssistantTurn(page, baseline, undefined, undefined, undefined, 120, undefined, undefined,
      scenario === "ordinary" ? undefined : stage.acknowledgement)).rejects.toThrow();
  } finally { await page.close(); }
}, 30_000);

test.each([2, 6])("the %s-part worker advances through detached-user ACKs exactly once", async count => {
  const page = await context.newPage();
  const root = mkdtempSync(join(tmpdir(), "multipart-ack-fixture-"));
  const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const finalReached = new Error("fixture: final part submitted");
  let draft = "";
  const sends: string[] = [];
  const acknowledgements: number[] = [];
  const selections: string[] = [];
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { appName: "fixture", browserDiagnosticsPath: root },
    prepareChatSurface: async () => { await page.setContent('<main></main>'); },
    selectModelAndEffort: async (_page: Page, model: string, effort: string) => {
      selections.push(effort); return resolveChatGptWebModelMode(model, effort, capabilities);
    },
    attachPrompt: async (_page: Page, text: string) => { draft = text; },
    attachPromptWithCompactionRetry: async (_page: Page, text: string) => { draft = text; },
    attachFiles: async () => {}, assertSelectedEffort: async () => {},
    sendAttachedPrompt: async (_page: Page, baseline: unknown, _capture: unknown, _signal: unknown, _progress: unknown, lifecycle: any) => {
      await lifecycle.onSendActivated?.();
      sends.push(draft);
      const index = sends.length;
      if (index === count) throw finalReached;
      const ack = draft.match(/CODEX_MULTIPART_ACK ctx_[a-f0-9]{32} \d\/\d [a-f0-9]{64}/)![0];
      await page.locator("main").evaluate((node, html) => { node.insertAdjacentHTML("beforeend", html); }, user.replaceAll("sent-user", `user-${index}`));
      expect(await worker.currentSubmissionEvidence(page, baseline)).toBe("user_turn");
      await lifecycle.onSubmitted?.();
      // Same document; the virtualized user anchor vanishes while the ACK remains visible.
      await page.locator("main").evaluate((node, data) => {
        node.querySelector(`[data-turn-id-container="user-${data.index}"]`)!.remove();
        node.insertAdjacentHTML("beforeend", data.html);
      }, { index, html: assistant(`ack-${index}`, ack) });
      return "user_turn";
    },
  });
  try {
    await expect(worker.runBrowserTurn({
      traceId: `multipart_ack_${count}`, modelId: "gpt-5.6-sol", reasoning: "high", capabilities,
      onTextDelta() {}, onMultipartStageAcknowledged: (part: number) => { acknowledgements.push(part); },
      prepare: async () => ({ text: "fixture final", images: [], multipart: {
        parts: Array.from({ length: count }, (_, i) => JSON.stringify({ part: i + 1 })), commit: "Finish the fixture",
      }, release() {} }),
    }, undefined, page)).rejects.toBe(finalReached);
    expect(sends).toHaveLength(count);
    expect(new Set(sends).size).toBe(count);
    expect(acknowledgements).toEqual(Array.from({ length: count - 1 }, (_, i) => i + 1));
    expect(selections.at(-1)).toBe("high");
  } finally { await page.close(); rmSync(root, { recursive: true, force: true }); }
}, 180_000);

test("duplicate exact multipart ACKs are rejected instead of choosing the last response", async () => {
  const page = await context.newPage();
  try {
    const { worker, baseline } = await submitted(page);
    await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, assistant("a", stage.acknowledgement) + assistant("b", stage.acknowledgement));
    await expect(worker.waitForNewAssistantTurn(page, baseline, undefined, undefined, undefined, 120, undefined, undefined, stage.acknowledgement))
      .rejects.toThrow("ambiguous multipart acknowledgement");
  } finally { await page.close(); }
}, 30_000);
