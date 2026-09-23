import { expect, test } from "bun:test";
import { readJsonRequestBody } from "../src/http-body";

test("decodes Codex zstd-compressed JSON request bodies", async () => {
  const body = { model: "chatgpt-web/pro", reasoning: { effort: "ultra" }, input: [{ role: "user", content: "hello" }] };
  const compressed = Bun.zstdCompressSync(Buffer.from(JSON.stringify(body)));
  const encoded = new ArrayBuffer(compressed.byteLength);
  new Uint8Array(encoded).set(compressed);
  const request = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "zstd" },
    body: encoded,
  });

  expect(await readJsonRequestBody(request)).toEqual(body);
});

test("rejects unsupported request content encodings", async () => {
  const request = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "br" },
    body: "{}",
  });

  await expect(readJsonRequestBody(request)).rejects.toThrow("Unsupported Content-Encoding: br");
});

test("the default encoded limit accepts former limits and rejects oversized declarations", async () => {
  const make = (size: number) => new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: "{}", headers: { "content-length": String(size) },
  });
  expect(await readJsonRequestBody(make(65 * 1024 * 1024))).toEqual({});
  await expect(readJsonRequestBody(make(129 * 1024 * 1024))).rejects.toThrow("Encoded request body exceeds");
});

for (const encoding of ["identity", "zstd"] as const) {
  test(`${encoding} checks actual encoded and decoded byte boundaries`, async () => {
    const body = { text: "日本語のサイズ境界".repeat(30) };
    const decoded = Buffer.from(JSON.stringify(body));
    const encoded = encoding === "zstd" ? Bun.zstdCompressSync(decoded) : decoded;
    // No Content-Length: the byte count must come from the actual body.
    const make = () => new Request("http://127.0.0.1/v1/responses", {
      method: "POST", headers: { "content-encoding": encoding }, body: new Uint8Array(encoded),
    });
    expect(await readJsonRequestBody(make(), {
      encodedBytes: encoded.byteLength, decodedBytes: decoded.byteLength,
    })).toEqual(body);
    await expect(readJsonRequestBody(make(), {
      encodedBytes: encoded.byteLength - 1, decodedBytes: decoded.byteLength,
    })).rejects.toThrow("Encoded request body exceeds");
    await expect(readJsonRequestBody(make(), {
      encodedBytes: encoded.byteLength, decodedBytes: decoded.byteLength - 1,
    })).rejects.toThrow("Decoded request body exceeds");
  });
}

test("an understated Content-Length cannot bypass the actual encoded limit", async () => {
  const request = new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: '{"value":true}', headers: { "content-length": "2" },
  });
  await expect(readJsonRequestBody(request, { encodedBytes: 8, decodedBytes: 64 }))
    .rejects.toThrow("Encoded request body exceeds 8 bytes");
});
