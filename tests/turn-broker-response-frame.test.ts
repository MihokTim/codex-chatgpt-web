import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint, isWindowsPipeEndpoint } from "../src/config";

async function fixture(respond: (socket: Socket, id: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "cgw-frame-"));
  const endpoint = defaultBrokerEndpoint(root);
  if (!isWindowsPipeEndpoint(endpoint)) mkdirSync(dirname(endpoint), { recursive: true });
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    let buffer = "";
    let handled = false;
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      if (handled) return;
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      respond(socket, JSON.parse(buffer.slice(0, newline)).id);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    endpoint,
    sockets,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("bounded call accepts a complete response before the peer closes", async () => {
  const peer = await fixture((socket, id) => {
    // Deliberately keep the server half open after delivering the entire response.
    socket.write(`${JSON.stringify({ id, result: { ready: true } })}\n`);
  });
  try {
    await expect(callTurnBroker(peer.endpoint, { method: "owner_status" }, 500))
      .resolves.toEqual({ ready: true });
  } finally {
    await peer.close();
  }
});

test("bounded call preserves a complete response error before the peer closes", async () => {
  const peer = await fixture((socket, id) => socket.write(`${JSON.stringify({ id, error: "claim rejected" })}\n`));
  try {
    await expect(callTurnBroker(peer.endpoint, { method: "owner_status" }, 500))
      .rejects.toThrow("claim rejected");
  } finally {
    await peer.close();
  }
});

test("complete response survives immediate cancellation and drains the connection", async () => {
  let sawClientEnd = false;
  const peer = await fixture((socket, id) => {
    socket.once("end", () => {
      sawClientEnd = true;
      socket.end();
    });
    socket.write(`${JSON.stringify({ id, result: "accepted" })}\n`);
  });
  const abort = new AbortController();
  try {
    expect(await callTurnBroker<string>(peer.endpoint, { method: "owner_status" }, 500, abort.signal)).toBe("accepted");
    abort.abort();
    const deadline = Date.now() + 2_000;
    while (peer.sockets.size > 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(sawClientEnd).toBe(true);
    expect(peer.sockets.size).toBe(0);
  } finally {
    await peer.close();
  }
});

test("an uncooperative peer cannot keep the client process alive after settlement", async () => {
  const peer = await fixture((socket, id) => socket.write(`${JSON.stringify({ id, result: true })}\n`));
  const moduleUrl = new URL("../src/adapters/chatgpt-web/turn-broker.ts", import.meta.url).href;
  const child = Bun.spawn([process.execPath, "--eval", `
    import { callTurnBroker } from ${JSON.stringify(moduleUrl)};
    const result = await callTurnBroker(${JSON.stringify(peer.endpoint)}, { method: "owner_status" }, 500);
    if (result !== true) throw new Error("missing response");
    console.log("settled");
  `], { stdout: "pipe", stderr: "pipe" });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitCode = await Promise.race([
      child.exited,
      new Promise<string>(resolve => { deadline = setTimeout(() => resolve("still running"), 5_000); }),
    ]);
    expect(exitCode).toBe(0);
    expect(await new Response(child.stdout).text()).toContain("settled");
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) child.kill();
    await child.exited;
    await peer.close();
  }
}, 10_000);

test("a fragmented UTF-8 response waits for its newline and preserves the whole result", async () => {
  const payload = "航海ゲーム🌊".repeat(30_000);
  let sentTail = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const peer = await fixture((socket, id) => {
    const line = Buffer.from(`${JSON.stringify({ id, result: payload })}\n`);
    // Split inside a multibyte character, then withhold the terminal newline.
    const split = line.indexOf(Buffer.from("航")) + 1;
    socket.write(line.subarray(0, split));
    socket.write(line.subarray(split, -1));
    timer = setTimeout(() => { sentTail = true; socket.end(line.subarray(-1)); }, 40);
  });
  try {
    expect(await callTurnBroker<string>(peer.endpoint, { method: "owner_status" }, 2_000)).toBe(payload);
    expect(sentTail).toBe(true);
  } finally {
    clearTimeout(timer);
    await peer.close();
  }
});

for (const [name, response, error] of [
  ["invalid JSON", "{broken}\n", "invalid JSON"],
  ["null frame", "null\n", "invalid response"],
  ["array frame", "[]\n", "invalid response"],
  ["mismatched request", '{"id":"wrong","result":true}\n', "id mismatch"],
  ["missing terminal newline", '{"id":"wrong","result":true}', "closed the connection"],
  ["empty response", "", "closed the connection"],
] as const) {
  test(`broker rejects ${name}`, async () => {
    const peer = await fixture(socket => socket.end(response));
    try {
      await expect(callTurnBroker(peer.endpoint, { method: "owner_status" }, 500)).rejects.toThrow(error);
    } finally {
      await peer.close();
    }
  });
}

test("cancelling an incomplete response rejects and closes the connection", async () => {
  const abort = new AbortController();
  const peer = await fixture((socket, id) => {
    socket.write(JSON.stringify({ id, result: true }));
    abort.abort();
  });
  try {
    await expect(callTurnBroker(peer.endpoint, { method: "owner_status" }, 500, abort.signal))
      .rejects.toMatchObject({ name: "AbortError" });
  } finally {
    await peer.close();
  }
});

test("broker can close immediately after a response and reopen its Windows pipe", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-frame-reopen-"));
  const endpoint = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(endpoint);
  try {
    for (let attempt = 0; attempt < 30; attempt++) {
      await broker.listen();
      await expect(callTurnBroker(endpoint, { method: "owner_status" }))
        .resolves.toMatchObject({ protocolVersion: 5 });
      await broker.close();
    }
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
