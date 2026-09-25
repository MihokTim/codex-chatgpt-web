# Codex ChatGPT Web — maintained V6 fork

This is an unofficial fork of [miuuyy/codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web), based directly on the official **v6.0.0** tag (`212ceef2acac9d6ee0f3c9037abfaf4ad8ff9827`). It adds a reviewed set of model-catalog and browser-continuation fixes. It is not an OpenAI product or an official upstream distribution.

**Native and Web models use the same Codex application and configuration home.** Setup adds Web routes to the native catalog; native requests retain upstream's native passthrough. Production uses `CODEX_HOME`, or `~/.codex` when unset. The bridge keeps its own settings and browser profile in `~/.codex-chatgpt-web`. Only the upstream development profile uses a separate test home.

The current fork identity is **6.0.0-fork.8**. The application version remains **6.0.0** for upstream compatibility. Every runtime includes the fork identity, source commit, source tree, working-input hashes and upstream revision. Consult [`fork-metadata.json`](fork-metadata.json) and the packaged `build-source.json` to identify a build. The original release baseline remains v6.0.0; the integrated upstream revision is now `757942251222ee0f71953c35636679c6d92dd636`, including reviewed post-release fixes.

## Changes in this fork

| Area | Behavior |
| --- | --- |
| Subagent catalog | Compatibility V1 reserves GPT-6 Pro (Web), GPT-5.6 Pro (Web), native GPT-6 Astra, Sol and Luna within its five explicit model overrides, keeping the original native default first. Older native Sol/Luna rows are fallback candidates only when their current equivalents are unavailable. |
| Model identity | Execution replay and compaction continuations are separated by named model family. |
| Browser responses | Answers remain anchored to the submitted user turn even when older assistant messages are remounted. |
| Model controls | Selection verifies the live effort state, recovers bounded focus/menu hydration failures, and preserves typed terminal errors. |
| Continuation | Refreshed environments, grouped compaction preambles and native app deliveries are checked against the current native rollout. |
| Failure recovery | A recognized failed-thinking response can continue once from verified completed tool history. Cancellation, partial answers and incomplete history prevent automatic recovery. |
| Compaction | A completed native tool boundary can retire the source before summarizing in a fresh context. Failed summary replay is bounded. |
| Helper compatibility | Older helpers cannot silently ignore pinned model families or six-part context. |
| Distribution | Build provenance is recorded, and upstream automatic installation cannot overwrite the fork's patches. |

See the [V6 review and per-commit disposition](docs/v6-fork-review.md) for evidence, removed workarounds and limits. The fork preserves V6's named models and original legacy aliases. In particular, `chatgpt-web/light` is **not** repurposed as GPT-5.6 Pro; choose `chatgpt-web/gpt-5.6-pro` explicitly.

The [fork.3 review resolutions](docs/v6-review-resolutions.md) describe the additional recovery, submission ownership, compaction, and default-model regressions addressed after independent review. Historical validation claims are scoped to their reviewed revision.

The [fork.4 browser compatibility patch](docs/chatgpt-ui-compatibility.md) supports the composer, model picker, app mentions, attachments, and conversation timeline observed on September 24, 2026. Composer detection failures now report an integration error instead of a misleading capacity error.

Fork.5 corrects a further live failure in the legacy timeline: an empty `client-created-root` inserted after Send was counted as a message, preventing the first submitted user from being bound. See the [follow-up diagnosis](docs/chatgpt-ui-compatibility.md#fork5-follow-up-post-send-root-sentinel).

Fork.7 adds request-category diagnostics, shared send pacing and bounded rate-limit waits, safe multipart preparation recovery, short-lived account verification caching, task-labelled tabs, and phase-aware compaction deadlines. See [the investigation and implementation record](docs/request-limit-investigation-20260925.md).

Fork.6 integrates the upstream hook and login fixes, handles an already-expanded current model picker, and retains unattributed human XML through compaction. **Settings → Updates** always shows the installed build and the last fetched published release, with a separate upstream-source comparison, errors, timestamps and a **Check now** button. See [fork.6 changes and update behavior](docs/fork6-updates.md).

The shared catalog priority also controls an unspecified parent model. The five-model policy applies only when it can retain the original native default; incomplete catalogs and future defaults outside this set keep their original priorities. Explicit model choices and user configuration are not rewritten.

## Build and install

Prebuilt packages from the **upstream** repository do not contain these patches. Until this fork publishes a release, build from this repository. Do not use upstream's automatic or terminal installer when intending to install the fork.

Prerequisites: Git; this project requires Bun 1.4.0. The exact version is pinned in `package.json`. Packaging uses the dependencies pinned in both lockfiles.

```sh
bun install --frozen-lockfile
cd launcher
bun install --frozen-lockfile
cd ..
bun run verify
bun run app:package
```

The platform package is written to `launcher/artifacts`. On Windows, `bun run --cwd launcher package:win` builds the NSIS installer. For a release build, set `CODEX_CHATGPT_WEB_REQUIRE_CLEAN_SOURCE=1` before packaging; the build rejects an uncommitted or changing source checkout.

1. Close the existing bridge normally and install the built package. Preserve the launcher's private data and ChatGPT profile.
2. Open the bridge, sign in to ChatGPT if needed, and run the browser smoke test.
3. Run **Install models / Repair Codex setup**, then restart the same Codex app to reload its route and model catalog.
4. Choose a model ending in **(Web)**. Use the launcher's **MCP** setup for local coding tools.

Availability depends on the signed-in account. V6's **Limits** panel estimates messages submitted by this launcher; it does not report OpenAI account quota. The optional saved-chat and fresh-conversation settings retain upstream defaults.

Update checks run at startup and every six hours; **Settings → Updates → Check now** retries without restarting. The sidebar opens the update information when upstream changes or a check failure need attention. Published packages and source changes are reported separately, including when the published version equals this fork's application version. Official binaries cannot be installed over a fork build. Review upstream changes, reevaluate each patch, run verification, and install a new fork package manually.

## Verification

`bun run verify` runs version checks, dependency audits, TypeScript checks, core and launcher tests, renderer build and relocated-runtime smoke tests. Real DOM tests use a locally installed Chrome discovered through upstream's platform defaults. Some platform-specific tests require their target OS or filesystem capability.

Optional native Codex compatibility tests run against a supplied executable with temporary homes and a local mock Responses server:

```sh
bun run scripts/smoke-codex-subagents.ts /path/to/codex --v1 --child-model=chatgpt-web/gpt-6-pro
bun run scripts/smoke-codex-subagents.ts /path/to/codex --v1 --child-model=chatgpt-web/gpt-5.6-pro
bun run scripts/smoke-codex-subagents.ts /path/to/codex --v1 --native-default --child-model=chatgpt-web/gpt-5.6-pro
bun run scripts/smoke-codex-subagents.ts /path/to/codex --v2
```

These tests check native catalog and tool-protocol behavior. They do not prove live ChatGPT generation or account access. Local validation results and the distinction between automated checks and live acceptance are documented in the [review](docs/v6-fork-review.md).

## Documentation and support

- [Architecture](docs/architecture.md) and [troubleshooting](TROUBLESHOOTING.md) retain upstream's technical documentation.
- [Official V6 release notes](https://github.com/miuuyy/codex-chatgpt-web/releases/tag/v6.0.0) describe the upstream release.
- [Upstream usage guide at the pinned revision](https://github.com/miuuyy/codex-chatgpt-web/blob/212ceef2acac9d6ee0f3c9037abfaf4ad8ff9827/README.md) covers the full interface. Its download links install upstream binaries.
- Report fork-specific issues in [this repository](https://github.com/MihokTim/codex-chatgpt-web/issues), including the fork identity and source commit. Remove prompts, credentials and personal paths from reports.

The translated READMEs are retained upstream documentation. This English README is authoritative for the fork's installation and behavior. Credits and the [MIT license](LICENSE) remain with the original project and its contributors; dependency notices are included in packages.
