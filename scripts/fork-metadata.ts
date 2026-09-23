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

/** Validate the public distribution identity before bundling or installing its metadata. */
export function validateForkMetadata(value: unknown, version: string): ForkMetadata {
  const metadata = object(value);
  const upstream = object(metadata.upstream);
  if (metadata.schemaVersion !== 1 || metadata.baseVersion !== version) {
    throw new Error("Fork metadata schema or base version does not match this source");
  }
  if (typeof metadata.distribution !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(metadata.distribution)
    || metadata.support !== `https://github.com/${metadata.distribution}/issues`
    || upstream.repository !== "https://github.com/miuuyy/codex-chatgpt-web"
    || typeof upstream.commit !== "string" || !/^[a-f0-9]{40}$/.test(upstream.commit)
    || typeof metadata.buildId !== "string" || !metadata.buildId.startsWith(`${version}-fork.`)
    || !/^[1-9][0-9]*$/.test(metadata.buildId.slice(`${version}-fork.`.length))) {
    throw new Error("Fork metadata has an invalid distribution, upstream source or build identifier");
  }
  return {
    schemaVersion: 1, distribution: metadata.distribution, buildId: metadata.buildId,
    baseVersion: version, upstream: { repository: upstream.repository, commit: upstream.commit },
    support: metadata.support as string,
  };
}

export function assertForkMetadataMatchesSource(actual: unknown, source: unknown, version: string): void {
  if (JSON.stringify(validateForkMetadata(actual, version)) !== JSON.stringify(validateForkMetadata(source, version))) {
    throw new Error("Runtime fork metadata does not match the source checkout");
  }
}
