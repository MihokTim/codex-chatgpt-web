# MihokTim fork integration

This repository is an unofficial fork of
[miuuyy/codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web). It is not affiliated with
or endorsed by OpenAI or the upstream project.

| Field | Value |
| --- | --- |
| Distribution | `MihokTim/codex-chatgpt-web` |
| Build identifier | `mihoktim-5.0.8-upstream-eaf4f09-20260922` |
| Compatible application version | `5.0.8` |
| Upstream base | `eaf4f09ae92d4dc4429fa597b0861663138f08f8` |
| Upstream repository | `https://github.com/miuuyy/codex-chatgpt-web` |
| Fork support | `https://github.com/MihokTim/codex-chatgpt-web/issues` |

The upstream-compatible version remains `5.0.8`. Release artifacts also carry
`fork-metadata.json`, and its distinct build identifier prevents a fork candidate from being
mistaken for the upstream v5.0.8 release.

## Maintained extensions

| Area | Maintained behavior | Primary regression coverage |
| --- | --- | --- |
| Sol routing | The existing `light` route selects Sol Pro, `ultra` maps to the browser maximum, and every public route binds an explicit browser family instead of trusting a stale caller value. | `tests/chatgpt-web-models.test.ts`, `tests/local-customizations.test.ts`, `tests/model-catalog.test.ts` |
| Browser model controls | Model-family selection verifies the actual radio state. Effort selection rejects inert or stale controls, handles focus conflicts and delayed ARIA updates, performs one bounded control recovery, and verifies the final family and value before submission. | `tests/effort-selection-recovery.test.ts`, `tests/browser-worker-contract.test.ts`, `tests/model-selection-errors.test.ts` |
| Model-selection failures | UI-control failures retain a dedicated non-retryable `502 / chatgpt_model_selection_failed` classification instead of becoming overload or rate-limit errors. | `tests/model-selection-errors.test.ts`, `tests/chatgpt-web-harness.test.ts`, `tests/launcher-helper-client.test.ts` |
| Response ownership | The final answer remains bound to the submitted user turn. Multipart acknowledgements and historical assistant blocks cannot become the current response, and Astra/Sol results do not share an execution cache. | `tests/browser-response-ownership.test.ts`, `tests/pro-family-replay.test.ts` |
| Terminal reconnects | A terminal context, rate-limit, model-selection, stopped-thinking, or failed-thinking result can be replayed to a reconnecting native observer without starting another browser submission. Normal in-progress reconnect remains supported. | `tests/terminal-failure-replay.test.ts`, `tests/chatgpt-web-harness.test.ts` |
| Failed-thinking recovery | A current-turn failed-thinking state may continue once only when canonical native history proves every completed tool result. Completed work is retained and never replayed. | `tests/failed-thinking-recovery.test.ts`, `tests/failed-thinking-recovery-integration.test.ts`, `tests/browser-response-dom.test.ts` |
| Compaction continuity | V1 and V2 compaction continuations authenticate the current/source native turn, tolerate omitted or duplicate matching environment identifiers, preserve goal/grouped preamble instructions, and reject changed permissions or workspaces. | `tests/environment.test.ts`, `tests/compaction-v1.test.ts`, `tests/retained-compaction.test.ts`, `tests/server-compaction.test.ts` |
| Operational bounds | Full-mode handoff allows long-running work, encoded and decoded HTTP bodies retain explicit upper bounds, DEV defaults remain conservative, and diagnostics record family/effort without prompt or response content. | `tests/local-customizations.test.ts`, `tests/http-turn-diagnostics.test.ts`, `tests/incident-collector.test.ts` |
| Optional external helpers | The bounded Desktop history guard and Windows incident recorder remain explicit, version-checked utilities. Building or starting the bridge never installs either helper automatically. | `tests/bounded-thread-history.test.ts`, `tests/incident-collector.test.ts` |
| Delegation catalog | Sol is available to parent-selected subagents while Astra Pro remains a separate candidate. Synthetic parent/child/grandchild result collection stays covered without claiming a live five-way model acceptance. | `tests/model-catalog.test.ts`, `scripts/smoke-codex-subagents.ts` |
| Multipart helper compatibility | Two-part prompts remain compatible with the previous helper capability, while six-part prompts require an explicit `multipart-2-6` negotiation before any prepared payload is sent. | `tests/launcher-helper-client.test.ts` |

The machine-readable mapping is in [fork-patch-inventory.json](fork-patch-inventory.json).

## Upstream behavior retained or adopted

The fork keeps upstream implementation where it already provides the required behavior, then adds
only the remaining fork-specific checks.

| Upstream commit | Adopted behavior |
| --- | --- |
| `e0904bc82001f06e06e7f85f564ce760c92bfd79` | Windows context-test timing allowances. |
| `cea5e1cc472c9acf6f56b0c498bc70e0b4a5eb0c` | Browser/setup/native environment recovery, selected URL/label and pre-submit effort verification, request-size classification, terminal cooldown behavior, catalog diagnostics, and launcher tunnel ownership. |
| `eaf4f09ae92d4dc4429fa597b0861663138f08f8` | Bigger Context two-part and six-part staging, ordered acknowledgements, final-part-only tools and attachments, and the unchanged three-times total context ceiling. |

Six transport parts do not grant a six-times model window. Bigger Context continues to publish a
three-times context and compaction limit, and each individual browser message remains within its
own composer boundary.

## Validation scope

The integration is tested with Bun `1.4.0` and the locked dependency graphs. The non-model gate
includes version synchronization, dependency audits, TypeScript checks, browser-worker and harness
contracts, all repository tests, launcher tests, renderer production build, relocatable runtime
smoke, and an unpacked Windows launcher candidate.

On Windows without Developer Mode or symlink privilege, symlink-fixture tests fail at fixture
creation with `EPERM`. Those cases are reported as environment constraints rather than counted as
passes, and the host permission policy is not changed to make the tests green. macOS and Linux
packages are not certified by a Windows-only candidate build.

No real ChatGPT model request is required by the default validation gate. Live acceptance, when
explicitly requested, is limited to Sol and is recorded separately from synthetic tests. Astra Pro
is not used for this fork integration gate.

## Release identity

This integration keeps the upstream-compatible application and launcher version `5.0.8`, product
name, application identifier, updater target, and default data locations. The distinct fork build
identifier and bundled metadata identify source and runtime candidates, but they do not turn this
checkout into a separately installable public launcher release. The local Windows candidate is for
review without installation or execution. A future public installer must first adopt a fork-owned
version, application identifier, installer GUID, artifact name, updater target, and data locations.

## Build from source

Use Bun `1.4.0` and keep candidate outputs separate from an installed runtime:

```bash
bun install --frozen-lockfile
bun run check-version
bun run audit
bun run typecheck
bun run test
bun run launcher:audit
bun run launcher:typecheck
bun run launcher:test
bun run launcher:build
bun run scripts/build-runtime-bundle.ts <candidate-runtime-directory>
bun run scripts/smoke-release.ts <candidate-runtime-directory>
```

The runtime manifest records hashes for every bundled file, including `fork-metadata.json`.
Candidate packaging should additionally record the exact source commit, runtime bundle ID, lockfile
hashes, platform, architecture, and launcher artifact hashes. Creating a candidate does not install
it, stop a running launcher, alter a Codex route, or enable either optional external helper.

## Updating or restoring

Start an update from a fixed upstream commit in an isolated worktree. Preserve the previous local
main with a recovery ref, retain uncommitted work outside the public candidate history, and verify
the integrated behavior before moving local main. Do not force-push or delete comparison branches
as part of routine integration.

Installing a candidate is a separate operation. Before a future installation, preserve the current
runtime, settings, authentication state, and optional-helper state; verify that active HTTP and
browser turns are zero; then update runtime and launcher as one compatible unit. A source checkout,
runtime candidate, local main, installed runtime, and published GitHub release are independent
states and should be reported separately.
