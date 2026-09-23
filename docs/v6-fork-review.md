# V6 fork review

Reviewed on 2026-09-23. Baseline: official `v6.0.0`, commit `212ceef2acac9d6ee0f3c9037abfaf4ad8ff9827`.

## Lineage and integration

This fork starts at the official V6 tag and applies focused feature commits. The previous fork and its V6 merge are not ancestors of the new fork commits. Old changes were examined as source material, not merged as a batch.

Production follows upstream's single-Codex architecture. `launcher/electron/profile.cjs`, the integration journal and route implementation, and the production service home resolution use V6 behavior. The fork does not add a second Codex home, force a default Web model, copy authentication between homes, or silently reinterpret an integration journal belonging to another configuration path.

An earlier experimental separated-home installation requires a local repair using its original journal before normal setup. Such repair is installation-specific and is not a permanent migration feature in this source tree. Preserve application data and use the matching old restoration code before applying the new setup; changing a journal's path by hand is not a valid migration.

## What official V6 changed

V6 adds named Web model entries with native Effort controls, optional local Pro usage estimates, six-part transport within the existing context budget, optional fresh conversations per turn, optional saved chats and Linux ARM64 packages. Its source also improves model availability checks, native environment recovery, memento/structured compaction, browser lifecycle, Markdown conversion, hooks and diagnostics. These features come from the official baseline. See the [author's V6 release notes](https://github.com/miuuyy/codex-chatgpt-web/releases/tag/v6.0.0).

The author's [long-session issue #619](https://github.com/miuuyy/codex-chatgpt-web/issues/619) remains useful context: the release notes ask for retesting rather than claiming every continuation failure is solved. The decisions below follow source comparisons and regression results; release-note wording alone was not treated as proof that a local fix was obsolete.

For Codex itself, [OpenAI's changelog](https://learn.chatgpt.com/docs/changelog) documents the September 22 rollout of GPT-6 Sol/Luna and the September 23 CLI 0.156.1 model-catalog update. CLI release notes do not establish the exact contents of a separately versioned desktop build. Compatibility tests therefore use the actual installed Codex executable and its model catalog.

## Retained patches and evidence

| Patch | V6 finding | Resulting implementation and tests |
| --- | --- | --- |
| Submitted-user response ownership | Eight of nine DOM regressions failed on V6: changed historical assistant IDs could be mistaken for current output. | Bind to a proven user container and reject ambiguous/foreign ownership. `tests/browser-response-ownership.test.ts`. |
| Named model execution identity | Both family isolation regressions failed on V6: the two Pro families shared replay/checkpoint scope. | Include V6's `_chatgptModelFamily` in execution and checkpoint keys. Retained compaction forwards the same family. `tests/model-family-execution.test.ts`. |
| Compatibility V1 roster | Upstream priorities do not reserve this fork's requested five-model roster. | Prioritize only when the complete eligible roster is present; keep account capabilities, all catalog rows and native-protocol priorities. `tests/subagent-model-roster.test.ts` and native CLI lifecycle smoke. |
| Terminal failure replay | Four HTTP/adapter regressions failed before the patch. V6's cancellation replay guard does not cover other explicitly terminal failures. | A bounded, expiring registry rejects identical automatic replay with HTTP 400 while retaining the original classification. New instructions and retryable errors remain usable. `tests/terminal-failure-replay.test.ts`. |
| Canonical environment and app deliveries | Sixteen environment cases failed before adaptation, including repeated/id-less compaction claims and cwd-less filesystem refreshes. | Extend V6's rollout authentication; preserve grouped runtime versus human instructions. Native app deliveries require exact destination rollout evidence. `tests/environment.test.ts`, `tests/codex-app-delegation.test.ts`, `tests/compaction-v1.test.ts`, `tests/server-compaction.test.ts`. |
| Failed-thinking and tool-boundary recovery | V6 lacks the observed Japanese failed-thinking status and the verified one-continuation policy. Its ordinary stopped-thinking state is distinct. | Preserve completed tool proofs; allow at most one automatic continuation; wait for old capability/browser retirement. Reject cancellation, changed history, missing outputs, partial answers and a second failure. `tests/failed-thinking-recovery*.test.ts`, `tests/compaction-failed-thinking.test.ts`, `tests/compaction-source-boundary.test.ts`, `tests/browser-response-dom.test.ts`. |
| Effort control recovery | Headless DOM fixtures reproduce focus loss and an unchanged slider on V6. | Retain V6 family selection; verify focus, range and persisted effort, with one control reopen. Typed failures remain terminal. `tests/effort-focus.test.ts`, `tests/model-selection-errors.test.ts`. |
| Localized model confirmation | V6 rejects localized Pro announcements after successfully selecting the model. Its usage classifier has a similar separator gap. | Share Unicode punctuation parsing between confirmation and usage classification, preserving family, Pro and slider checks. The original reproduction has five failures before the patch, including both named Pro routes in real browser DOM fixtures. `tests/chatgpt-model-selection.test.ts`, `tests/chatgpt-limits.test.ts`, `tests/effort-focus.test.ts`. |
| Owned-page observation recovery | V6 can lose a recovery attempt while its viewport is still unavailable. | Share the existing two-attachment budget between viewport and DOM probes; reconnect only the owned target. `tests/browser-observation-recovery.test.ts`. |
| Helper feature negotiation | V6 transports family/six-part fields, but an older advertised helper can lack their semantics. | Negotiate `pinned-model-family` and `multipart-2-6` before use. Keep V6's bundled-sibling preference. `tests/launcher-helper-client.test.ts`. |
| Fork provenance and updates | Upstream binaries cannot identify or preserve this fork's patches. | Record source/input identity, validate metadata, and refuse automatic upstream replacement. `tests/build-provenance.test.ts`, `tests/fork-metadata.test.ts`, `launcher/tests/update.test.cjs`. |

The regression fixtures exercise synthetic/local scenarios. They are not represented as live ChatGPT captures. Platform-specific checks and live account acceptance are reported separately.

## Retired changes and limits

- **Separated production homes and legacy Pro migration:** removed to restore the intended shared Codex app. Existing private data is handled locally, not copied into this repository.
- **Legacy `light`/`pro` family remapping:** replaced by V6 named routes and family selection. Old aliases keep upstream semantics. Use named Pro routes explicitly.
- **Forced Extra High during Pro compaction:** removed. V6 preserves the chosen named family and canonical effort; the fork does not substitute a different effort behind the model selection.
- **Two-hour compaction ceiling:** removed in favor of V6's five-minute liveness window and accepted-progress rearming. A blanket longer wait is not treated as a recovery strategy.
- **Three-part transport adjustments:** replaced by V6's native one/two/six-part implementation. Only mixed-helper compatibility checks remain local.
- **Larger encoded/decoded HTTP limits:** not carried forward. V6 keeps explicit 64 MiB encoded and 128 MiB decoded bounds. The earlier increase was a local capacity policy, not a general compatibility requirement; requests beyond V6's limits remain unsupported by this fork.
- **DEV default model override:** removed. Upstream development-profile behavior is used unchanged.
- **Incident recorder, Desktop history guard and private deployment probes:** excluded from the public bridge product. These are external diagnostic/plugin modifications, not V6 bridge fixes. Previously installed independent copies are not uninstalled by this fork.
- **Extra per-turn diagnostics:** V6's existing receipts are retained. The former incident-correlation system and recorder are not shipped. Recovery capacity remains bounded in memory; reaching the limit produces an explicit error.
- **Old local review reports and deployment claims:** replaced by this review. Automated catalog checks do not establish that a running desktop has refreshed its model menu.

This fork does not claim to solve account limits, server-side refusals or every long-session failure. An application restart may still be needed after changing the native route. Native passthrough and Web generation are different acceptance checks.

## Validation on Windows x64

- Core: 943 passed, 3 skipped, 0 failed (946 tests, 70 files).
- Launcher: 332 passed, 5 skipped, 0 failed (337 tests).
- Core/launcher TypeScript checks and renderer build passed. Dependency audits reported no vulnerabilities (106 core and 351 launcher packages).
- Native CLI `0.155.0-alpha.16.3`: Compatibility V1 child/grandchild/follow-up lifecycle passed for both named Web Pro routes and GPT-6 Astra, Sol and Luna, using a frozen copy of the installed executable's bundled catalog. Native V2 lifecycle also passed.
- The live native cache changed during testing from current to older Sol/Luna rows. Tests therefore freeze their input catalog; the production roster keeps eligible older rows as a fallback instead of inventing unavailable models.
- File symlink cases are skipped only after a filesystem capability probe fails on Windows; the regular-file rollback scenario still runs. Other skips belong to upstream platform-specific checks.

These results precede packaging. Runtime manifests and the packaged smoke marker identify the final artifact; live account acceptance is reported separately from local mock/DOM tests.

### Localized selection correction in fork.2

The original live acceptance covered High, not either named Pro route. On a Japanese ChatGPT surface, both named Pro routes subsequently failed before sending: V6's unmodified parser recognized ASCII/full-width commas but not the localized punctuation separating the selected mode from its position announcement. The usage classifier had the same separator gap. Both now use one parser based on Unicode punctuation categories, without a language-specific separator list. Tests cover Latin, CJK and Arabic punctuation and reject different families and suffixed Pro variants. This is an upstream V6 defect, so the correction is a separate focused commit without rewriting the official baseline.

Regression fixtures use synthetic markup and the observed model labels only; they contain no account or conversation data. The change preserves the V6 family selector and does not introduce a model fallback, a retry or another prompt submission. No live GPT-6 Pro generation is required for this check; selecting and verifying its controls without submitting protects the account's limited Pro allowance.

## Commit disposition

Every non-merge commit unique to the previous fork through `600b269` is listed below. "Replaced" means V6 or the new implementation provides the intended behavior; "Retired" records a deliberate scope/policy removal, not an upstream fix claim. The old combined V6 merge (`23d4e05`) is also excluded from the new lineage.

| Previous commit | Disposition | Reason |
| --- | --- | --- |
| `2feaa02` | Retired | Preserve V6 named-family effort; remove the hidden Pro compaction override. |
| `6744c03` | Retired | Use one production Codex home and application. |
| `fd6d8dd` | Retired | Remove separated-home lifecycle management; retain V6 route transactions. |
| `3e730f4` | Replaced | V6 named-model setup and capability readiness provide the baseline. |
| `b435718` | Replaced | Use V6 named routes; add only missing family isolation to execution keys. |
| `68f6eb8` | Adapted | Remove effort override transport; negotiate the V6 model-family capability. |
| `44e8088` | Retired | Keep V6 five-minute compaction liveness and progress rearming. |
| `8e02625` | Adapted | Authenticate refreshed canonical environment and compaction context. |
| `8d50435` | Retired | Keep V6 HTTP size policy; larger requests are outside this fork scope. |
| `b7267f0` | Retired | Keep upstream DEV defaults. |
| `7bbc863` | Retained | Recognize failed-thinking separately from ordinary stopped thinking. |
| `eeb89d9` | Retained | Permit one continuation from verified completed native tool history. |
| `e34051b` | Adapted | Wrap raw control failures while preserving V6 typed errors. |
| `38f4f4d` | Retained | Reject identical automatic replay of explicitly terminal failures. |
| `12008ae` | Adapted | Bind output to a proven submitted user container. |
| `c188bd3` | Replaced | V6 progress/multipart contracts plus focused browser regressions; no separate liveness probe shipped. |
| `687ea00` | Retired | Keep V6 receipts; exclude the external incident-correlation system. |
| `03d10be` | External | Desktop history guard is outside the bridge product. |
| `93ce066` | Replaced | General native CLI mock lifecycle smoke; specialized live Sol probe excluded. |
| `74def9d` | Adapted | Reserve named Web Pro and current native models only when the full roster is eligible. |
| `d960625` | Replaced | General CLI lifecycle smoke verifies tool declarations and nested model selection. |
| `5123694` | External | Incident recorder is not shipped; installed independent copies remain independent. |
| `b1966c4` | Retired | Specialized live Sol diagnostics excluded; mock smoke limits are documented. |
| `5892368` | Adapted | Bound focus recovery around V6 family and effort controls. |
| `98c86fb` | Adapted | Preserve canonical human instructions across grouped compaction context. |
| `8bf9846` | Retained | Require multipart-2-6 support before using newer helper semantics. |
| `c8f66a5` | Replaced | V6 family selector plus final live effort verification. |
| `4dc06fd` | Retained | Headless DOM regressions cover historical message remounts. |
| `23651e5` | Replaced | V6 already provides six-part transport documentation. |
| `a760200` | Replaced | Fresh English fork README and this review. |
| `0478a6d` | Adapted | Fork build identity and source provenance with no separated-home policy. |
| `b936f88` | Adapted | Authenticate native app delivery from the current shared Codex rollout. |
| `7a23fe6` | Retained | Retire verified active tool boundary before a fresh summary. |
| `f3e1d47` | Retained | Bound failed-summary replay and reconstruct only from complete canonical history. |
| `1217d16` | Retained | Record commit and tree identities in runtime provenance. |
| `dec9037` | External | Desktop history guard projection is outside this repository. |
| `e80266f` | External | Desktop plugin installation and updating are outside this repository. |
| `73c7f15` | Adapted | Verify live controls using V6 family semantics and bounded focus recovery. |
| `eafd876` | Retained | Bound viewport/DOM recovery to the owned browser target. |
| `9aec271` | Adapted | Verify native runtime/date refresh against canonical rollout evidence. |
| `b05196f` | Retained | Keep automatic recovery tied to logical ownership across HTTP observer disconnects. |
| `2e276c6` | Retired | Specialized Sol roundtrip failure probe excluded. |
| `e84fe5c` | Partial | Retain bounded recovery registries and explicit capacity errors; omit extra health counters. |
| `d0b92d5` | Adapted | Share authenticated environment policy with native app deliveries. |
| `c073cd3` | Retained | Record runtime input hashes and source cleanliness. |
| `f332d1c` | Adapted | Use one validated metadata file and a simple versioned fork revision. |
| `86c28d4` | Replaced | V6 HTTP boundary tests remain; the former larger-limit policy is removed. |
| `a55e1b2` | Retained | Discover Chrome with upstream platform defaults in real DOM fixtures. |
| `b30bb93` | Retained | Require a proven user anchor before accepting an assistant answer. |
| `c9c5e94` | Retained | Share the reconnect budget between viewport and DOM observation. |
| `de21d06` | Adapted | One typed error boundary around V6 model selection and final verification. |
| `bc147ce` | Replaced | Keep focused new regression files beside unchanged upstream contracts. |
| `c4dd26b` | External | Desktop history guard rollback belongs to its separately installed plugin. |
| `3fcaad0` | External | Private incident recorder readiness probe is not part of the bridge. |
| `18b7789` | Replaced | This review replaces historical local reports. |
| `a7e6b45` | Retained | Prefer current GPT-6 Sol/Luna, with older native rows as fallback. |
| `c589ff9` | Adapted | General CLI smoke accepts explicit child models and an actual native catalog. |
| `b12b10c` | Replaced | Current roster evidence is recorded in this review. |
| `1f125ea` | Retired | Remove legacy Pro profile migration and separated-home assumptions. |
| `600b269` | Replaced | Discard the merged deployment claim; document direct official-V6 lineage. |
