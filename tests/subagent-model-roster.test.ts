import { describe, expect, test } from "bun:test";
import {
  COMPATIBILITY_V1_PREFERRED_MODEL_SLUGS,
  hasCompleteCompatibilityV1PreferredRoster,
  prioritizeCompatibilityV1Models,
  type ModelCatalogRow,
} from "../src/subagent-model-roster";

function row(slug: string, priority: number, overrides: ModelCatalogRow = {}): ModelCatalogRow {
  return {
    slug,
    priority,
    visibility: "list",
    supported_in_api: true,
    description: `${slug} metadata`,
    ...overrides,
  };
}

function completeRoster(): ModelCatalogRow[] {
  return [
    row("gpt-6-astra", 1),
    row("gpt-6-sol", 2),
    row("gpt-6-luna", 3),
    row("gpt-reserve", 0, { visibility: "hide" }),
    row("gpt-5.6-sol", 4),
    row("chatgpt-web/light", 1),
    row("chatgpt-web/medium", 2),
    row("chatgpt-web/high", 1),
    row("chatgpt-web/extra-high", 1),
    row("chatgpt-web/pro", 1),
  ];
}

function delegationRoster(models: readonly ModelCatalogRow[]): unknown[] {
  return models
    .filter(model => model.supported_in_api === true && model.visibility === "list")
    .toSorted((left, right) => Number(left.priority) - Number(right.priority))
    .slice(0, 5)
    .map(model => model.slug);
}

describe("Compatibility V1 subagent model roster", () => {
  test("reserves the five explicit override slots and leaves all rows selectable", () => {
    const source = completeRoster();
    const snapshot = structuredClone(source);
    const result = prioritizeCompatibilityV1Models(source, "compatibility-v1");

    expect(delegationRoster(result)).toEqual([...COMPATIBILITY_V1_PREFERRED_MODEL_SLUGS]);
    expect(source).toEqual(snapshot);
    expect(result.find(model => model.slug === "gpt-reserve")?.priority).toBe(0);
    for (const slug of ["chatgpt-web/medium", "chatgpt-web/high", "chatgpt-web/extra-high", "gpt-5.6-sol"]) {
      expect(result.find(model => model.slug === slug)?.visibility).toBe("list");
      expect(Number(result.find(model => model.slug === slug)?.priority)).toBeGreaterThanOrEqual(5);
    }
  });

  test("is idempotent and preserves non-priority metadata", () => {
    const source = completeRoster();
    const first = prioritizeCompatibilityV1Models(source, "compatibility-v1");
    const second = prioritizeCompatibilityV1Models(first, "compatibility-v1");

    expect(second).toEqual(first);
    for (const original of source) {
      const result = first.find(model => model.slug === original.slug)!;
      const { priority: _originalPriority, ...originalMetadata } = original;
      const { priority: _resultPriority, ...resultMetadata } = result;
      expect(resultMetadata).toEqual(originalMetadata);
    }
  });

  test.each(["missing", "hidden", "unsupported"])(
    "keeps the existing policy when a preferred model is %s",
    condition => {
      const source = completeRoster();
      const luna = source.find(model => model.slug === "gpt-6-luna")!;
      const changed = condition === "missing" ? source.filter(model => model !== luna) : source;
      if (condition === "hidden") luna.visibility = "hide";
      if (condition === "unsupported") luna.supported_in_api = false;
      const snapshot = structuredClone(changed);

      expect(hasCompleteCompatibilityV1PreferredRoster(changed)).toBe(false);
      expect(prioritizeCompatibilityV1Models(changed, "compatibility-v1")).toEqual(snapshot);
    },
  );

  test("keeps native-protocol priorities unchanged", () => {
    const source = completeRoster();
    expect(prioritizeCompatibilityV1Models(source, "native")).toEqual(source);
  });
});
