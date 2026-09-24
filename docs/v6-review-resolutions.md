# V6 independent review resolutions

Revision: `6.0.0-fork.3`. The review baseline was `8a590b389c9510da76cb2e68ef61289f888a6f44`, based on official V6 `212ceef2acac9d6ee0f3c9037abfaf4ad8ff9827`.

## Decisions

| Finding | Assessment | Resulting contract |
| --- | --- | --- |
| IR-001: changed completed tool arguments | Reproduced through the adapter and broker, not only a helper predicate. | Capture each issued call before delivery and verify its kind, namespaced name, arguments, and matching output before recovery or fresh compaction. |
| IR-002: historical user and assistant IDs remount together | Reproduced in headless Chromium. Occurrence frequency on the live service was not established. | A user first becomes a submission anchor only at the appended conversation boundary while previously observed user containers preserve their positions. An unowned assistant cannot independently establish a send. |
| IR-003: V1 priorities change the unspecified parent model | Reproduced with the installed native CLI and a local Responses server. | Retain the original eligible native default first while reserving the same five overrides. If the original default falls outside that set, retain source priorities instead of changing it silently. |
| IR-004: human XML is discarded during compaction | Reproduced against official V6 and the fork. | Explicit human, mixed, and unknown content kinds remain human input. Environment and notification XML without runtime provenance is retained rather than classified by its appearance. |
| IR-005: simultaneous failures exceed the fence limit | Reproduced with one remaining slot and two concurrent requests. | Reserve capacity synchronously before starting work; share an existing reservation on replay, release it on success, and convert it to a failure fence on failure. |
| IR-006: obsolete public deployment notes | Publication hygiene rather than evidence of exposed credential contents. | Keep operational paths and private deployment records outside public source. Historical branches and commits require separate review from the current main branch. |

These changes preserve one production Codex application and home. They do not install another profile, copy authentication, override explicit model/effort choices, or invent unavailable model rows.

## Tool history evidence

Tool result equality does not establish that the corresponding command was unchanged. The session now captures a call digest when the broker issues it and retains that digest after delivery. JSON object key order is immaterial; array order, freeform text, tool identity, and call kind remain significant. Malformed arguments and mismatched output kinds cannot authenticate a completed call. Recovery and compaction share this verification.

The one-continuation budget is unchanged. A rejected history is not permission to rerun the original tool. This is a process-scoped recovery contract, not a durable exactly-once guarantee across process restarts.

## Browser ownership

The existing user-container virtualization behavior remains supported. Historical assistant IDs may change, but replacing an old user ID inside the pre-send conversation does not prove a new submission. Identical text may still be submitted again when it extends the established boundary. If the required boundary cannot be established, the observer does not adopt an old answer.

This check depends on the logical outer conversation containers retained by the current DOM contract. It does not claim to identify arbitrary changes to the service's future DOM or distinguish all concurrent external edits to the same conversation.

## Native defaults and model overrides

The native client uses shared catalog priority both for model defaults and bounded V1 overrides. Reordering the requested set can preserve both requirements when the native default is a member. A future native default outside the set cannot satisfy both constraints through that single priority field; the fork then leaves source priorities intact. Native V2 priorities and explicit user choices remain unchanged.

The CLI smoke test's `--native-default` mode omits both the configuration model and `--model`, then checks actual root requests against the unmodified native catalog. The same run checks child/grandchild/follow-up execution and advertised override models with a local mock server.

## Regression coverage and limits

The new negative cases were executed before the fixes and failed for the reported reasons. The corresponding corrected paths are covered by:

- `tests/native-tool-proof.test.ts`, `tests/failed-thinking-recovery*.test.ts`, and the compaction history tests;
- `tests/browser-response-ownership.test.ts`, the browser worker contracts, and observation recovery tests;
- `tests/subagent-model-roster.test.ts` and `scripts/smoke-codex-subagents.ts --v1 --native-default`;
- `tests/compaction-v1.test.ts` and `tests/compaction-capacity.test.ts`.

The capacity exhaustion scenario runs in a child process so its permanent test fences cannot consume the budgets of unrelated tests. Live Pro generation and deliberately induced live failures are not needed for these regressions and are not represented by mock or DOM results. Passing them does not establish that every long-session compaction timeout has been solved.

Build and runtime identity are recorded in `fork-metadata.json`, `build-source.json`, and the runtime manifest. Deployment verification must distinguish files installed on disk from code already loaded by a running process; a validated replacement bundle does not by itself prove that an existing process has restarted onto it.
