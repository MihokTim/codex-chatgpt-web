export interface RequestBodyLimits {
  encodedBytes: number;
  decodedBytes: number;
}

const DEFAULT_REQUEST_BODY_LIMITS: Readonly<RequestBodyLimits> = {
  encodedBytes: 128 * 1024 * 1024,
  decodedBytes: 256 * 1024 * 1024,
};

function assertWithinLimit(bytes: number, limit: number, label: string): void {
  if (bytes > limit) throw new Error(`${label} exceeds ${limit} bytes`);
}

export async function readJsonRequestBody(
  request: Request,
  limits: Readonly<RequestBodyLimits> = DEFAULT_REQUEST_BODY_LIMITS,
): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength)) {
    assertWithinLimit(declaredLength, limits.encodedBytes, "Encoded request body");
  }

  const encoded = new Uint8Array(await request.arrayBuffer());
  assertWithinLimit(encoded.byteLength, limits.encodedBytes, "Encoded request body");

  const contentEncoding = (request.headers.get("content-encoding") ?? "identity").trim().toLowerCase();
  let decoded: Uint8Array;
  if (contentEncoding === "" || contentEncoding === "identity") {
    decoded = encoded;
  } else if (contentEncoding === "zstd") {
    decoded = await Bun.zstdDecompress(encoded);
  } else {
    throw new Error(`Unsupported Content-Encoding: ${contentEncoding}`);
  }
  // This bounds accepted payloads, not peak memory: Bun's zstd API returns the
  // complete decompressed buffer before the size can be checked.
  assertWithinLimit(decoded.byteLength, limits.decodedBytes, "Decoded request body");

  const text = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  return JSON.parse(text) as unknown;
}
