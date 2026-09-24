const fs = require("node:fs");

const REPOSITORY_URL = "https://github.com/miuuyy/codex-chatgpt-web";
const FORK_INSTALL_MESSAGE = "This is a fork build. Install a reviewed fork package; official updates would replace its patches.";

/** Observe upstream releases and source changes without authorizing binary replacement. */
function createForkUpdateController({ currentVersion, metadataPath, fetchRelease, fetchComparison,
  compareVersions, publish, logger, now = () => new Date().toISOString() }) {
  let metadata;
  let metadataError;
  try {
    metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    if (metadata.schemaVersion !== 1 || metadata.baseVersion !== currentVersion
      || !/^\d+\.\d+\.\d+-fork\.[1-9]\d*$/.test(metadata.buildId)
      || !metadata.buildId.startsWith(`${currentVersion}-fork.`)
      || metadata.upstream?.repository !== REPOSITORY_URL
      || !/^[a-f0-9]{40}$/.test(metadata.upstream?.commit)) {
      throw new Error("Invalid fork metadata");
    }
  } catch {
    metadataError = "The installed fork metadata could not be verified. Reinstall a reviewed fork package.";
  }
  let information = {
    installedBuild: metadataError ? currentVersion : metadata.buildId,
    integratedCommit: metadataError ? null : metadata.upstream.commit,
    checkedAt: null,
    lastSuccessfulCheckAt: null,
    release: null,
    source: null,
  };
  let state = { status: "idle", information };
  let checked = false;
  let pending;
  const transition = (next) => {
    state = { ...next, information };
    publish?.(state);
    return state;
  };

  function checkNow() {
    if (pending) return pending;
    checked = true;
    // Defer execution so concurrent IPC/startup/timer requests share the same promise.
    pending = Promise.resolve().then(async () => {
      transition({ status: "checking" });
      if (metadataError) {
        information = { ...information, checkedAt: now() };
        return transition({ status: "error", message: metadataError });
      }
      const results = await Promise.allSettled([
        Promise.resolve().then(fetchRelease).then(release => {
          if (!release || release.draft === true || release.prerelease === true) {
            throw new Error("GitHub did not return a published stable release");
          }
          const version = String(release.tag_name || "").replace(/^v/, "");
          const newer = compareVersions(version, currentVersion) > 0;
          const publishedAt = release.published_at;
          if (typeof publishedAt !== "string" || !Number.isFinite(Date.parse(publishedAt))) {
            throw new Error("GitHub returned an invalid release publication date");
          }
          return { version, publishedAt, newer,
            url: `${REPOSITORY_URL}/releases/tag/v${encodeURIComponent(version)}` };
        }),
        Promise.resolve().then(() => fetchComparison(metadata.upstream.commit)).then(comparison => {
          const { ahead_by: aheadBy, status, head_commit: head } = comparison || {};
          if (!Number.isSafeInteger(aheadBy) || aheadBy < 0
            || !["identical", "ahead", "behind", "diverged"].includes(status)
            || !/^[a-f0-9]{40}$/.test(head?.sha)) {
            throw new Error("GitHub returned an invalid upstream comparison");
          }
          return { aheadBy, status, head: head.sha,
            url: `${REPOSITORY_URL}/compare/${metadata.upstream.commit}...${head.sha}` };
        }),
      ]);
      const checkedAt = now();
      const errors = [];
      information = { ...information, checkedAt };
      for (const [index, result] of results.entries()) {
        if (result.status === "fulfilled") {
          information[index === 0 ? "release" : "source"] = result.value;
        } else {
          const label = index === 0 ? "Release" : "Source";
          errors.push(`${label}: ${String(result.reason?.message || result.reason).slice(0, 400)}`);
        }
      }
      if (errors.length) {
        const message = errors.join("; ");
        logger?.warn("launcher.fork_update_check_failed", { message });
        return transition({ status: "error", message });
      }
      information = { ...information, lastSuccessfulCheckAt: checkedAt };
      const changes = information.release.newer || information.source.status !== "identical";
      logger?.info("launcher.fork_update_checked", {
        release: information.release.version, sourceStatus: information.source.status,
        aheadBy: information.source.aheadBy,
      });
      return transition({ status: changes ? "upstream-available" : "up-to-date" });
    }).finally(() => { pending = undefined; });
    return pending;
  }

  return {
    getState: () => state,
    checkOnce: () => pending || (checked ? Promise.resolve(state) : checkNow()),
    checkNow,
    beginInstall: async () => { throw new Error(FORK_INSTALL_MESSAGE); },
    cancelInstall() {},
  };
}

module.exports = { createForkUpdateController };
