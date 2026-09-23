# MihokTim fork integration

This repository is an unofficial fork of
[miuuyy/codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web). It is not affiliated with
or endorsed by OpenAI or the upstream project.

| Field | Value |
| --- | --- |
| Distribution | `MihokTim/codex-chatgpt-web` |
| Build identifier | `buildId` in [fork-metadata.json](../fork-metadata.json) |
| Compatible application version | `6.0.0` |
| Upstream base | `upstream.commit` in [fork-metadata.json](../fork-metadata.json) |
| Upstream repository | `https://github.com/miuuyy/codex-chatgpt-web` |
| Fork support | `https://github.com/MihokTim/codex-chatgpt-web/issues` |

The upstream-compatible version remains `6.0.0`. Release artifacts also carry
`fork-metadata.json`, and its distinct build identifier prevents a fork candidate from being
mistaken for the upstream v6.0.0 release.

6.0.0での修正ごとの判断・今回の導入エラー・検証範囲は [更新レビュー](v6-upgrade-review-2026-09-23.md) を参照。forkから公式installerへの直接上書きは独自機能を失うため、ランチャーは上流更新を案内し、統合版への更新を求める。

## Maintained extensions

| Area | Maintained behavior | Primary regression coverage |
| --- | --- | --- |
| Sol routing | The existing `light` route selects Sol Pro, `ultra` maps to the browser maximum, and every public route binds an explicit browser family instead of trusting a stale caller value. | `tests/chatgpt-web-models.test.ts`, `tests/browser-model-family.test.ts`, `tests/model-catalog.test.ts` |
| Browser model controls | Model-family selection verifies the actual radio state. Effort selection rejects inert or stale controls, handles focus conflicts and delayed ARIA updates, performs one bounded control recovery, and verifies the final family and value before submission. | `tests/effort-selection-recovery.test.ts`, `tests/browser-worker-contract.test.ts`, `tests/model-selection-errors.test.ts` |
| Model-selection failures | UI-control failures retain a dedicated non-retryable `502 / chatgpt_model_selection_failed` classification instead of becoming overload or rate-limit errors. | `tests/model-selection-errors.test.ts`, `tests/chatgpt-web-harness.test.ts`, `tests/launcher-helper-client.test.ts` |
| Response ownership | The final answer remains bound to the submitted user turn. Multipart acknowledgements and historical assistant blocks cannot become the current response, and Astra/Sol results do not share an execution cache. | `tests/browser-response-ownership.test.ts`, `tests/pro-family-replay.test.ts` |
| Terminal reconnects | A terminal context, rate-limit, model-selection, stopped-thinking, or failed-thinking result can be replayed to a reconnecting native observer without starting another browser submission. Normal in-progress reconnect remains supported. | `tests/terminal-failure-replay.test.ts`, `tests/chatgpt-web-harness.test.ts` |
| Failed-thinking recovery | A current-turn failed-thinking state may continue once only when canonical native history proves every completed tool result. Completed work is retained and never replayed. | `tests/failed-thinking-recovery.test.ts`, `tests/failed-thinking-recovery-integration.test.ts`, `tests/browser-response-dom.test.ts` |
| Compaction continuity | V1 and V2 compaction continuations authenticate the current/source native turn, tolerate omitted or duplicate matching environment identifiers, preserve goal/grouped preamble instructions, and reject changed permissions or workspaces. | `tests/environment.test.ts`, `tests/compaction-v1.test.ts`, `tests/retained-compaction.test.ts`, `tests/server-compaction.test.ts` |
| Operational bounds | Full-mode handoff allows long-running work, encoded and decoded HTTP bodies retain explicit upper bounds, DEV defaults remain conservative, and diagnostics record family/effort without prompt or response content. | `tests/http-body.test.ts`, `tests/http-turn-diagnostics.test.ts`, `tests/incident-collector.test.ts` |
| Optional external helpers | The bounded Desktop history guard and Windows incident recorder remain explicit, version-checked utilities. Building or starting the bridge never installs either helper automatically. | `tests/bounded-thread-history.test.ts`, `tests/incident-collector.test.ts` |
| Delegation catalog | Web GPT-6 Pro、Web GPT-5.6 Pro、native GPT-6 Astra／Sol／Lunaの5枠を優先する。旧nativeには5.6 fallbackを使用する。 | `tests/model-catalog.test.ts`, `scripts/smoke-codex-subagents.ts` |
| Multipart helper compatibility | Two-part prompts remain compatible with the previous helper capability, while six-part prompts require an explicit `multipart-2-6` negotiation before any prepared payload is sent. | `tests/launcher-helper-client.test.ts` |
| Compaction effort | 非固定のlegacy ProだけでExtra High要約を維持。新しい系列固定Proは圧縮時も選択した系列とeffortを保持する。 | `tests/chatgpt-web-models.test.ts`, `tests/retained-compaction.test.ts` |
| Authenticated app deliveries | App task deliveries and ordinary instructions share canonical environment resolution, including date refreshes that omit cwd. | `tests/codex-app-delegation.test.ts`, `tests/environment.test.ts` |
| Compaction tool boundary | Completed tool results are verified before retiring the source response and generating a tool-free summary. A retained-source failed-thinking state may rebuild the summary once. | `tests/compaction-source-boundary.test.ts`, `tests/retained-compaction.test.ts` |
| Browser observation recovery | DOM and viewport failures share the same two-connection budget for the owned page. Only successful DOM observation resets it. | `tests/browser-observation-recovery.test.ts`, `tests/browser-response-ownership.test.ts` |
| Source provenance | A runtime records the source commit, Git tree, and working-content identity. Changes during a build are rejected even when the source was already dirty. | `tests/build-provenance.test.ts` |
| History guard installation | Version/hash checks, staged replacement, receipt-last updates, and rollback on ordinary I/O errors protect installation and update. | `tests/history-guard-installation.test.ts`, `tests/bounded-thread-history.test.ts` |

The machine-readable mapping is in [fork-patch-inventory.json](fork-patch-inventory.json).

The browser's non-Sol family control is named `Latest` / `最新`; it is not a fixed Astra model
identifier. DEVは上流のInstantを既定とし、Medium代替は廃止した。新規モデル名は上流6.0の系列固定経路を使用し、旧lightなどは保存済みタスクの互換用としてのみ維持する。

The native liveness probe `scripts/smoke-codex-stream-liveness.ts` covers comments-only responses,
disconnects, and long heartbeats. It is an explicit probe outside the default `verify` command;
it does not directly test multipart acknowledgement recovery. The 1/2/6 change updates CLI help
and DEV display text, while multipart behavior is covered by the separate transport tests above.

The optional history guard patches the exact supported `codex-app-tools/0.1.4/server.mjs` bytes;
it does not patch the Desktop application package. It depends on the documented local history
schema and Windows runtime paths. Large-history `wait_threads` requests can fail explicitly
because a bounded persisted snapshot cannot provide live waiting semantics. Installation tests
cover ordinary exceptions, not power loss or atomic switching of multiple files in a running MCP
server. Neither building nor running the bridge installs the guard.

HTTP limits (128 MiB encoded and 256 MiB decoded) bound accepted payloads, not peak process
memory: the body and zstd output are buffered before the decoded size check. Tests inject small
limits and use real compressed/uncompressed bytes at both boundaries. Recovery-fence capacity
and restart precautions are documented in [recovery-operations.md](recovery-operations.md).

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

This integration keeps the upstream-compatible application and launcher version `6.0.0`, product
name, application identifier and default data locations. The distinct fork build
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
`build-source.json` schema 2 records the source commit/tree and an independent `inputHash` plus
per-file hashes for local imports, build recipes, manifests/locks/config, and copied license and
metadata files. It excludes unrelated checkout files and installed packages; dependency locks
identify external package inputs and the runtime manifest hashes the final installed files.
Dirty source builds remain supported. Set `CODEX_CHATGPT_WEB_REQUIRE_CLEAN_SOURCE=1` for a
deployment candidate, and keep that checkout stable until the build finishes. Start/end snapshots
detect changed inputs but cannot detect a transient edit that is reverted before the final snapshot.
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

The 2026-09-23 independent review decisions, fixes, and reasons for retaining some design choices
are recorded in [independent-review-resolution.md](independent-review-resolution.md).
