import type { SubagentProtocol } from "./config";

export type ModelCatalogRow = Record<string, unknown>;

/**
 * Compatibility V1 currently advertises at most five explicit model overrides to spawn_agent.
 * Keep this policy separate from catalog construction so future roster changes remain localized.
 */
export const COMPATIBILITY_V1_PREFERRED_MODEL_SLUGS = [
  "chatgpt-web/pro",
  "chatgpt-web/light",
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-luna",
] as const;

function modelSlug(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as ModelCatalogRow).slug;
  return typeof candidate === "string" ? candidate : undefined;
}

function delegationModel(value: unknown): value is ModelCatalogRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const model = value as ModelCatalogRow;
  return model.visibility === "list" && model.supported_in_api === true;
}

function modelPriority(model: ModelCatalogRow): number | undefined {
  const value = model.priority;
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("Delegation model priority must be an integer");
  }
  return value;
}

export function hasCompleteCompatibilityV1PreferredRoster(models: readonly unknown[]): boolean {
  const eligibleSlugs = new Set(models.filter(delegationModel).map(modelSlug));
  return COMPATIBILITY_V1_PREFERRED_MODEL_SLUGS.every(slug => eligibleSlugs.has(slug));
}

/**
 * Return a catalog with Compatibility V1 delegation priorities applied without mutating its rows.
 * Incomplete catalogs keep their original priorities so staged rollouts and non-Pro accounts retain
 * the legacy policy until every preferred model is actually usable.
 */
export function prioritizeCompatibilityV1Models(
  models: readonly ModelCatalogRow[],
  protocol: SubagentProtocol,
): ModelCatalogRow[] {
  if (protocol !== "compatibility-v1" || !hasCompleteCompatibilityV1PreferredRoster(models)) {
    return [...models];
  }

  const ranks = new Map<string, number>(
    COMPATIBILITY_V1_PREFERRED_MODEL_SLUGS.map((slug, rank) => [slug, rank]),
  );
  const fallbackPriority = COMPATIBILITY_V1_PREFERRED_MODEL_SLUGS.length;

  return models.map(model => {
    if (!delegationModel(model)) return model;
    const rank = ranks.get(modelSlug(model) ?? "");
    return {
      ...model,
      priority: rank ?? Math.max(modelPriority(model) ?? fallbackPriority, fallbackPriority),
    };
  });
}
