# Native retry and maintenance recovery

The September 24 incident contained two independent failures after compaction was repaired.
At 23:13:10 JST the deployment watcher drained a daemon with one active browser turn. The browser
was waiting for another Codex tool-result request, which drain rejected with HTTP 503. Codex
displayed that local maintenance response as model capacity at 23:13:24, 23:13:38, and 23:14:13.
The daemon restarted at 23:14:51. The next native retry had a new turn ID but retained the original
user item's old turn ID, so strict provenance validation rejected it before opening a browser.

Drain now requires both HTTP and browser counters to be zero before it changes admission. A busy
drain request returns HTTP 409 and leaves ongoing work usable. Requests during a completed drain
also return HTTP 409 with `runtime_draining`; genuine upstream overload classification is unchanged.

A retry can rebind the original user item to the new native execution only when the canonical
local rollout proves the current thread and turn, an adjacent chain of explicit provider failures,
and the exact latest original instruction (item ID, content, and source turn). The chain may include
the old bridge's turn-ID conflict rejection. Completed work, aborted turns, changed instructions,
different threads, missing evidence, and unrelated failures are rejected. Filesystem authority is
still resolved independently from the current native context. Historical envelopes are not rebound.
The lookup is bounded to 16 failed attempts and 20,000 records and does not modify the native rollout.

Regression coverage is in `tests/native-retry.test.ts` and `tests/server-lifecycle.test.ts`.
