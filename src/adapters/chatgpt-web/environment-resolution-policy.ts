import { resolve, toNamespacedPath } from "node:path";
import type { CodexParsedRequest } from "../../types";
import {
  extractChatGptContinuationEnvironmentClaim,
  extractChatGptEnvironmentRefreshClaims,
  extractChatGptSteeringEnvironmentClaim,
  extractChatGptThreadSpawnLineage,
  extractChatGptTurnEnvironment,
  extractChatGptTurnIdentity,
  hasCurrentChatGptEnvironmentContext,
  isChatGptCompactionContinuation,
  MissingTrustedCodexEnvironmentError,
  unattributedChatGptEnvironmentMessages,
  type ChatGptTurnEnvironment,
  type ChatGptUnattributedEnvironmentMessage,
} from "./environment";

type EnvironmentResolutionPlan = {
  claims: ChatGptTurnEnvironment[];
  conflictLabel: string;
  historicalEnvironmentMessages?: ChatGptUnattributedEnvironmentMessage[];
} & (
  | { kind: "trusted"; environment: ChatGptTurnEnvironment }
  | { kind: "rollout"; missingError: MissingTrustedCodexEnvironmentError }
);

/** Interpret wire provenance only; no filesystem lookup or cached authority participates. */
export function planChatGptEnvironmentResolution(parsed: CodexParsedRequest): EnvironmentResolutionPlan {
  const hasCurrentContext = hasCurrentChatGptEnvironmentContext(parsed);
  try {
    const environment = extractChatGptTurnEnvironment(parsed);
    return { kind: "trusted", environment, claims: hasCurrentContext ? [environment] : [],
      conflictLabel: "Current" };
  } catch (error) {
    if (!(error instanceof MissingTrustedCodexEnvironmentError) || !extractChatGptTurnIdentity(parsed).threadId) throw error;
    const lineage = extractChatGptThreadSpawnLineage(parsed);
    const currentCompaction = hasCurrentContext && isChatGptCompactionContinuation(parsed);
    const historicalEnvironmentMessages = hasCurrentContext && !currentCompaction && lineage
      ? unattributedChatGptEnvironmentMessages(parsed) : undefined;
    const steeringClaim = hasCurrentContext && !currentCompaction
      ? extractChatGptSteeringEnvironmentClaim(parsed) : undefined;
    const refreshClaims = hasCurrentContext && !currentCompaction
      ? extractChatGptEnvironmentRefreshClaims(parsed) : undefined;
    if (hasCurrentContext && !currentCompaction && !historicalEnvironmentMessages && !steeringClaim && !refreshClaims) throw error;
    return {
      kind: "rollout", missingError: error,
      claims: currentCompaction ? [extractChatGptContinuationEnvironmentClaim(parsed)]
        : refreshClaims ?? (steeringClaim ? [steeringClaim] : []),
      conflictLabel: currentCompaction ? "Compaction continuation" : refreshClaims ? "Native refresh" : "Steering",
      ...(historicalEnvironmentMessages ? { historicalEnvironmentMessages } : {}),
    };
  }
}

function pathIdentity(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? toNamespacedPath(normalized).toLowerCase() : normalized;
}

/** Exact filesystem and network authority comparison, independent of current tool declarations. */
export function sameChatGptEnvironmentAuthority(left: ChatGptTurnEnvironment, right: ChatGptTurnEnvironment): boolean {
  const samePaths = (a: string[], b: string[]): boolean => {
    const actual = a.map(pathIdentity).sort();
    const expected = b.map(pathIdentity).sort();
    return actual.length === expected.length && actual.every((path, index) => path === expected[index]);
  };
  return pathIdentity(left.cwd) === pathIdentity(right.cwd)
    && samePaths(left.roots, right.roots)
    && samePaths(left.writableRoots, right.writableRoots)
    && left.sandboxPolicy.type === right.sandboxPolicy.type
    && (left.sandboxPolicy.type === "dangerFullAccess" || (right.sandboxPolicy.type !== "dangerFullAccess"
      && left.sandboxPolicy.networkAccess === right.sandboxPolicy.networkAccess));
}
