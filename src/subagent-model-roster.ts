import type { SubagentProtocol } from "./config";

export type ModelCatalogRow = Record<string, unknown>;

/**
 * Compatibility V1 currently advertises at most five explicit model overrides to spawn_agent.
 * Keep this policy separate from catalog construction so future roster changes remain localized.
 */
export const COMPATIBILITY_V1_PREFERRED_MODEL_SLUGS = [
  "chatgpt-web/gpt-6-pro",
  "chatgpt-web/gpt-5.6-pro",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
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
  return resolveCompatibilityV1PreferredRoster(models) !== undefined;
}

/** Resolve five eligible overrides without changing the source catalog's native default. */
export function resolveCompatibilityV1PreferredRoster(models: readonly unknown[]): string[] | undefined {
  const eligibleSlugs = new Set(models.filter(delegationModel).map(modelSlug));
  const roster: Array<string | undefined> = COMPATIBILITY_V1_PREFERRED_MODEL_SLUGS.map(slug => {
    if (eligibleSlugs.has(slug)) return slug;
    if (slug === "gpt-6-sol" && eligibleSlugs.has("gpt-5.6-sol")) return "gpt-5.6-sol";
    if (slug === "gpt-6-luna" && eligibleSlugs.has("gpt-5.6-luna")) return "gpt-5.6-luna";
    return undefined;
  });
  if (!roster.every((slug): slug is string => slug !== undefined)) return undefined;
  // Codex also uses this priority for an unspecified parent model. Keep its original
  // native choice first rather than silently switching a new task onto Web Pro.
  const nativeDefault = models.filter(delegationModel)
    .filter(model => { const slug = modelSlug(model); return slug && !slug.startsWith("chatgpt-web/"); })
    .toSorted((left, right) => (modelPriority(left) ?? Number.MAX_SAFE_INTEGER)
      - (modelPriority(right) ?? Number.MAX_SAFE_INTEGER))[0];
  const defaultSlug = modelSlug(nativeDefault);
  // A future default outside these five cannot safely share their bounded priority slots.
  if (!defaultSlug || !roster.includes(defaultSlug)) return undefined;
  return [defaultSlug, ...roster.filter(slug => slug !== defaultSlug)];
}

/**
 * Return a catalog with Compatibility V1 delegation priorities applied without mutating its rows.
 * Incomplete catalogs and catalogs with a different native default retain their priorities.
 * No model, effort, capability, or user configuration is created or rewritten by this policy.
 */
export function prioritizeCompatibilityV1Models(
  models: readonly ModelCatalogRow[],
  protocol: SubagentProtocol,
): ModelCatalogRow[] {
  if (protocol !== "compatibility-v1") return [...models];
  const preferred = resolveCompatibilityV1PreferredRoster(models);
  if (!preferred) return [...models];

  const ranks = new Map<string, number>(
    preferred.map((slug, rank) => [slug, rank]),
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
