import { expect, test } from "bun:test";
import metadata from "../fork-metadata.json";
import { assertForkMetadataMatchesSource, validateForkMetadata } from "../scripts/fork-metadata";
import { VERSION } from "../src/version";

test("the bundled fork identity matches the source and rejects another reviewed revision", () => {
  expect(validateForkMetadata(metadata, VERSION)).toEqual({ ...metadata, schemaVersion: 1 });
  expect(() => assertForkMetadataMatchesSource(metadata, metadata, VERSION)).not.toThrow();
  const other = { ...metadata, buildId: `${VERSION}-fork.2` };
  expect(() => assertForkMetadataMatchesSource(other, metadata, VERSION)).toThrow("does not match");
  const changedSource = { ...metadata, upstream: { ...metadata.upstream, commit: "a".repeat(40) } };
  expect(() => assertForkMetadataMatchesSource(changedSource, metadata, VERSION)).toThrow("does not match");
});

test.each([null, [], {}, { ...metadata, schemaVersion: 2 }, { ...metadata, baseVersion: "0.0.0" },
  { ...metadata, buildId: `${VERSION}-fork.0` }, { ...metadata, buildId: `${VERSION}-fork.1-extra` },
  { ...metadata, support: "https://example.invalid" }, { ...metadata, distribution: "../invalid" },
  { ...metadata, upstream: { ...metadata.upstream, commit: "212ceef" } },
].map(value => ({ value })))("invalid fork metadata is rejected %#", ({ value }) => {
  expect(() => validateForkMetadata(value, VERSION)).toThrow();
});
