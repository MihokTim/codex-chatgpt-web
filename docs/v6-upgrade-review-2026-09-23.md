# Archived V6 integration experiment

This branch preserves an earlier V6 integration experiment and is not the supported installation source. The maintained fork is on `main`, based directly on official V6 commit `212ceef2acac9d6ee0f3c9037abfaf4ad8ff9827`.

The experiment merged an older fork and retained separated production Codex homes. That architecture has been retired. Current native and Web models use one Codex application and the normal `CODEX_HOME` or `~/.codex` configuration home. Do not use this branch's historical deployment instructions to repair a current installation, and do not edit an integration journal's destination path to bypass its ownership checks.

The previous document contained installation-specific paths and backup-location descriptions. Those operational details are omitted from the current document. This documentation update does not rewrite Git history and does not imply that older commits have been removed or that a complete historical secret scan has been performed.

Use the current main-branch README and review-resolution documentation for build, installation, model selection, and supported behavior. Local deployment logs, browser sessions, authentication, and rollback copies belong in private storage and must not be committed to this repository.
