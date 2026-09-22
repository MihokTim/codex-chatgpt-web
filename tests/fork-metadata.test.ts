import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { assertForkMetadataMatchesSource, validateForkMetadata } from "../scripts/fork-metadata";
import { VERSION } from "../src/version";

const source: unknown = JSON.parse(readFileSync(new URL("../fork-metadata.json", import.meta.url), "utf8"));
const metadata = validateForkMetadata(source, VERSION);

test("repository metadata is valid and bundle identity matches the single source", () => {
  expect(metadata.baseVersion).toBe(VERSION);
  expect(() => assertForkMetadataMatchesSource(source, source, VERSION)).not.toThrow();
});

test("release date and upstream commit can advance together without code changes", () => {
  const commit = "1234567890abcdef1234567890abcdef12345678";
  const updated = { ...metadata, buildId: `mihoktim-${VERSION}-upstream-${commit.slice(0, 7)}-20280229`,
    upstream: { ...metadata.upstream, commit } };
  expect(validateForkMetadata(updated, VERSION)).toEqual(updated);
  expect(() => assertForkMetadataMatchesSource(updated, source, VERSION)).toThrow("does not match");
});

test.each([
  null, [], {},
  { ...metadata, schemaVersion: 2 },
  { ...metadata, baseVersion: "0.0.0" },
  { ...metadata, distribution: "another/fork" },
  { ...metadata, support: "https://example.invalid" },
  { ...metadata, upstream: { ...metadata.upstream, repository: "https://example.invalid" } },
  { ...metadata, upstream: { ...metadata.upstream, commit: "eaf4f09" } },
  { ...metadata, buildId: `mihoktim-${VERSION}-upstream-0000000-20260101` },
  ...["20260229", "20260931", "20261301", "20260001", "20260100", "2026011", "20260101-extra"].map(date => ({
    ...metadata, buildId: `mihoktim-${VERSION}-upstream-${metadata.upstream.commit.slice(0, 7)}-${date}`,
  })),
].map(value => ({ value })))("rejects malformed or mismatched fork identity %#", ({ value }) => {
  expect(() => validateForkMetadata(value, VERSION)).toThrow();
});

test("source matching checks full upstream SHA, not just the seven-character build prefix", () => {
  const changed = { ...metadata, upstream: { ...metadata.upstream,
    commit: metadata.upstream.commit.slice(0, 7) + "0".repeat(33) } };
  expect(validateForkMetadata(changed, VERSION).buildId).toBe(metadata.buildId);
  expect(() => assertForkMetadataMatchesSource(changed, source, VERSION)).toThrow("does not match");
});
