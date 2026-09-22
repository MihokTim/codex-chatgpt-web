export interface ForkMetadata {
  schemaVersion: 1;
  distribution: string;
  buildId: string;
  baseVersion: string;
  upstream: { repository: string; commit: string };
  support: string;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Product identity is fixed here; release date and upstream SHA live only in the metadata. */
export function validateForkMetadata(value: unknown, version: string): ForkMetadata {
  const metadata = object(value);
  const upstream = object(metadata.upstream);
  if (metadata.schemaVersion !== 1) throw new Error("fork-metadata.json has an unsupported schema");
  if (metadata.baseVersion !== version) throw new Error(`fork-metadata.json is not synchronized to ${version}`);
  if (metadata.distribution !== "MihokTim/codex-chatgpt-web"
    || upstream.repository !== "https://github.com/miuuyy/codex-chatgpt-web"
    || typeof upstream.commit !== "string" || !/^[a-f0-9]{40}$/.test(upstream.commit)
    || metadata.support !== "https://github.com/MihokTim/codex-chatgpt-web/issues") {
    throw new Error("fork-metadata.json does not identify the public fork and upstream source");
  }
  const prefix = `mihoktim-${version}-upstream-${upstream.commit.slice(0, 7)}-`;
  const date = typeof metadata.buildId === "string" && metadata.buildId.startsWith(prefix)
    ? metadata.buildId.slice(prefix.length) : "";
  const isoDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  if (!/^\d{8}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== isoDate) {
    throw new Error("fork-metadata.json has an unexpected build identifier");
  }
  return {
    schemaVersion: 1, distribution: metadata.distribution, buildId: metadata.buildId as string,
    baseVersion: version, upstream: { repository: upstream.repository, commit: upstream.commit },
    support: metadata.support,
  };
}

export function assertForkMetadataMatchesSource(actual: unknown, source: unknown, version: string): void {
  const expected = validateForkMetadata(source, version);
  const bundled = validateForkMetadata(actual, version);
  if (JSON.stringify(bundled) !== JSON.stringify(expected)) {
    throw new Error("Runtime fork metadata does not match fork-metadata.json in the source checkout");
  }
}
