# Fork.6: review fixes and visible update information

Date: 2026-09-24. Build: `6.0.0-fork.6`.

## Release and source identity

The current published stable release is v6.0.0, published on 2026-09-23 at
02:51:06 UTC (11:51:06 JST), from `212ceef2acac9d6ee0f3c9037abfaf4ad8ff9827`.
This fork already contained that baseline. Upstream subsequently committed
`757942251222ee0f71953c35636679c6d92dd636` to main without publishing a different
release. Fork.6 merges that reviewed source revision while retaining the existing
fork history. The metadata's upstream commit identifies the integrated source,
not a claim that a new official binary was published.

References: [published release](https://github.com/miuuyy/codex-chatgpt-web/releases/tag/v6.0.0),
[upstream source fix](https://github.com/miuuyy/codex-chatgpt-web/commit/757942251222ee0f71953c35636679c6d92dd636).

## Why the old notification was absent

Fork.5 compared the public release version with the application version (`6.0.0`).
Equal versions produced no notification. When a newer version was available,
the fork guard returned an error containing the update notice, but the sidebar
only rendered available/downloading/installing states. Checks also ran only once
per launcher process, with no manual retry.

Fork.6 separates the informational fork controller from the official binary
installer. Settings always includes an Updates panel with the installed fork,
latest fetched stable release and publication time, integrated source revision,
upstream comparison, last check and any check error. The sidebar leads to Settings
for source/release changes or errors, rather than offering to install upstream binaries.

Checks run at startup and every six hours, with a manual Check now action.
Concurrent checks share one operation. Release and source requests fail
independently: useful results remain visible, but a failed refresh is labeled and
the last successful check is distinguished. Source comparison is pinned to the
main SHA observed for that check. All links are constructed for the official
repository. Checking updates does not use or interrupt a ChatGPT conversation.

## Review dispositions

| Finding | Resolution |
| --- | --- |
| R-01: equivalent TOML serialization rejected | Integrated upstream AST-based hook ownership, pinned parser dependency and regressions. |
| R-02: saved-login verification uses an English textbox name | Both login paths use the shared structural composer selector. |
| R-03: expanded current model picker rejects a switch | Simple view opens the choices; advanced view selects directly. Both states are tested. |
| R-04: Korean Latest label | The upstream fix is retained as part of the merge; no separate localization work was added. |
| R-05: unattributed goal/internal XML loses human instructions | Removed the text-shape-only exclusion. Native runtime kinds still exclude real internal preambles; mixed, human and unknown input remains intact. |

New fork-specific UI text is maintained in English and Japanese. Other locales
use English for that panel. Existing upstream translations and recognition are
retained, not deleted.

The existing fork response-ownership, replay prevention, tool-call proof and
model-family isolation remain in place. The overlapping legacy connector selector
has one implementation that also supports current app mentions. Runtime fixes,
update visibility and build identity are separate commits; published history is
not rewritten for cosmetic commit splitting.

## Verification scope

Targeted regressions exercise hook serialization, login selectors, model selection,
human/internal compaction boundaries, update retries/concurrency/errors, and the
English/Japanese panel. The standard `bun run verify` covers the complete suite,
type checks, dependency audits, renderer/runtime builds and relocated-runtime smoke.
Tests and fixture previews do not claim live Pro generation or long-session account
acceptance. A built package is distinct from the running launcher; install it after
the active task is complete and the launcher has been closed normally.
