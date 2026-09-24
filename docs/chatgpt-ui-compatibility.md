# ChatGPT UI compatibility in fork.4

ChatGPT's September 24, 2026 UI no longer exposed several DOM contracts used by V6. The missing composer produced a generic error containing "unavailable", which the bridge could classify as overloaded capacity. Updating the composer alone was insufficient: messages could be sent successfully while the bridge waited for response identifiers that no longer existed.

This patch adds the observed composer form, reasoning menu and power slider, model-family view switch, app mention rows and selected app chips, general file picker, and attachment tiles. Existing selectors remain supported. App identity uses explicit metadata and matching app links; displayed text alone does not prove selection. Send and file controls are resolved inside the active composer's form. Prompt readback excludes both generations of app chips without relaxing text integrity checks.

The new timeline owns a user message and its assistant content under one `data-turn-key`. The bridge derives two logical anchors from that stable outer key, verifies the user message belongs to it, and binds the response to the same container. Display indices and changing assistant message IDs do not establish ownership. Duplicate keys, mismatched users, mixed identity formats, and later unrelated users are rejected. Virtualizing an inner user section does not discard an already proven outer anchor. User text is excluded from answer extraction and thinking-failure detection.

The current answer renderer is identified by its assistant message styling metadata. The observed Japanese stop and copy controls have no test IDs, so scoped accessible labels are supported alongside English labels and the original test-ID controls. The live acceptance environment was Japanese; other new-layout locales and Luna-only accounts have not been validated by this patch.

Missing composer controls now produce HTTP 502 with `chatgpt_composer_unavailable`, non-retryable, while preserving explicit authentication errors and cancellation. This does not change genuine model-capacity or rate-limit handling.

Hidden launcher maintenance also restores a usable renderer viewport when Electron reports zero width or height. This allows the new editor to select and clear its app-mention proof. Visible maintenance pages keep their measured viewport; leased response tabs retain their existing viewport owner.

Validation includes real Chromium fixtures for both layouts, model selection, app identity, exact prompt readback, attachment scoping, and timeline ownership under remounts and virtualization. Live checks confirmed both named Pro selections without submitting Pro generations, app selection, multiline Japanese prompt integrity, text and image uploads, and one short GPT-5.6 High response through send, extraction, and completion. These checks do not establish every tool workflow or long-context compaction behavior.

Upstream `7579422` independently removes the localized display-text requirement for legacy selected connectors; this patch uses the same metadata-based direction and adds the new app-mention format. The other upstream hook changes are outside this compatibility patch.
