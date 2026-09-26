import { ChatGptBrowserWorker } from "../../src/adapters/chatgpt-web/browser-worker";
import { ChatGptMirroredTurnProgress } from "../../src/adapters/chatgpt-web/turn-progress";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  for (const scenario of ["already-aborted", "abort-during-dom", "late-dom-rejection", "no-progress-reader"]) {
    const controller = new AbortController();
    const progress = new ChatGptMirroredTurnProgress();
    const sibling = new ChatGptMirroredTurnProgress();
    const siblingWait = sibling.waitForChange(0);
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
      waitForTurnDomMutation: () => {
        if (scenario === "abort-during-dom") controller.abort();
        return scenario === "late-dom-rejection" || scenario === "no-progress-reader"
          ? delay(10).then(() => { throw new Error("cancelled page closed later"); })
          : delay(10);
      },
    });
    if (scenario !== "abort-during-dom") controller.abort();
    let aborted = false;
    try {
      await worker.waitForTurnDomOrExternalProgress({}, 0,
        scenario === "no-progress-reader" ? undefined : progress, controller.signal);
    } catch (error) { aborted = error instanceof Error && error.name === "AbortError"; }
    if (!aborted) throw new Error(`${scenario}: cancellation was lost`);
    await delay(30);
    sibling.apply({ revision: 1, lastToolBatchRevision: 1, activeToolCalls: 1, lastProgressAt: Date.now() });
    if ((await siblingWait).revision !== 1) throw new Error("unrelated turn stopped");
    console.log(`${scenario}: sibling survived`);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
