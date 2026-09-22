import { expect, test } from "bun:test";
import { browserViewportUnavailable, recoverOwnedBrowserPage } from "../src/adapters/chatgpt-web/browser-observation-recovery";
import { connectAfterClosingBrowserConnection } from "../src/adapters/chatgpt-web/browser-worker";

test("a first rebind viewport failure closes its transport before the second owned attachment", async () => {
  const order: string[] = [];
  let connection = { close: async () => { order.push("close-old"); } };
  const page = {};
  const result = await recoverOwnedBrowserPage(1, 2, attempt => connectAfterClosingBrowserConnection(connection, async () => {
    order.push(`attach-${attempt}`);
    connection = { close: async () => { order.push(`close-${attempt}`); } };
    if (attempt === 1) throw browserViewportUnavailable(new Error("renderer timeout"));
    return page;
  }));
  expect(result).toBe(page);
  expect(order).toEqual(["close-old", "attach-1", "close-1", "attach-2"]);
});

test("persistent viewport loss uses the remaining budget and preserves an explicit terminal cause", async () => {
  for (const start of [1, 2]) {
    const attempts: number[] = [];
    const error = browserViewportUnavailable(new Error("renderer timeout"));
    await expect(recoverOwnedBrowserPage(start, 2, async attempt => { attempts.push(attempt); throw error; }))
      .rejects.toBe(error);
    expect(attempts).toEqual(start === 1 ? [1, 2] : [2]);
    expect(error).toMatchObject({ code: "chatgpt_browser_viewport_unavailable", retryable: false });
  }
});

test("operator cancellation and ownership errors never open another attachment", async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController(); let attempts = 0;
    const failure = new Error(cancel ? "cancelled" : "ownership mismatch");
    await expect(recoverOwnedBrowserPage(1, 2, async () => {
      attempts++;
      if (cancel) { controller.abort(failure); throw browserViewportUnavailable(failure); }
      throw failure;
    }, controller.signal)).rejects.toBe(failure);
    expect(attempts).toBe(1);
  }
});
