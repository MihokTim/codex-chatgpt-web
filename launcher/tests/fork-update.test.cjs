const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createUpdateController } = require("../electron/update.cjs");

const base = "a".repeat(40);
const stable = { tag_name: "v6.0.0", draft: false, prerelease: false, published_at: "2026-09-23T02:51:06Z" };
const identical = { ahead_by: 0, status: "identical", head_commit: { sha: base } };
const ahead = { ahead_by: 1, status: "ahead", head_commit: { sha: "b".repeat(40) } };

function fixture(t, overrides = {}, metadataOverride) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fork-information-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const metadata = path.join(root, "fork-metadata.json");
  fs.writeFileSync(metadata, JSON.stringify(metadataOverride ?? {
    schemaVersion: 1, baseVersion: "6.0.0", buildId: "6.0.0-fork.6",
    upstream: { repository: "https://github.com/miuuyy/codex-chatgpt-web", commit: base },
  }));
  return createUpdateController({
    currentVersion: "6.0.0", platform: "win32", arch: "x64", packaged: true, forkMetadataPath: metadata,
    dependencies: {
      fetchRelease: async () => stable,
      fetchComparison: async revision => { assert.equal(revision, base); return identical; },
      downloadFile: () => { throw new Error("Must not download official binaries"); },
      ...overrides,
    },
  });
}

test("same-version release remains visible and unpublished source changes have their own identity", async t => {
  const controller = fixture(t, { fetchComparison: async () => ahead });
  const state = await controller.checkOnce();
  assert.equal(state.status, "upstream-available");
  assert.equal(state.information.release.version, "6.0.0");
  assert.equal(state.information.release.newer, false);
  assert.equal(state.information.source.aheadBy, 1);
  assert.equal(state.information.integratedCommit, base);
  assert.match(state.information.source.url, new RegExp(`${base}\\.\\.\\.${"b".repeat(40)}$`));
  assert.ok(state.information.checkedAt);
  await assert.rejects(controller.beginInstall(), /fork build/);
});

test("same source and release are reported as current, with useful metadata", async t => {
  const state = await fixture(t).checkOnce();
  assert.equal(state.status, "up-to-date");
  assert.equal(state.information.installedBuild, "6.0.0-fork.6");
  assert.equal(state.information.release.publishedAt, stable.published_at);
  assert.equal(state.information.source.status, "identical");
  assert.equal(state.information.checkedAt, state.information.lastSuccessfulCheckAt);
});

test("concurrent checks coalesce and an explicit subsequent check sees a new release", async t => {
  let releaseCalls = 0;
  let release = stable;
  let resolveFetch;
  const controller = fixture(t, { fetchRelease: () => {
    releaseCalls++;
    return new Promise(resolve => { resolveFetch = () => resolve(release); });
  } });
  const first = controller.checkOnce();
  const second = controller.checkNow();
  assert.equal(first, second);
  await new Promise(resolve => setImmediate(resolve));
  resolveFetch();
  await first;
  await controller.checkOnce();
  assert.equal(releaseCalls, 1);
  release = { ...stable, tag_name: "v6.0.1" };
  const next = controller.checkNow();
  await new Promise(resolve => setImmediate(resolve));
  resolveFetch();
  assert.equal((await next).information.release.newer, true);
  assert.equal(releaseCalls, 2);
});

test("network errors stay visible while preserving independently fetched release information", async t => {
  let failed = false;
  const controller = fixture(t, { fetchComparison: () => {
    if (failed) throw new Error("HTTP 403");
    return ahead;
  } });
  const initial = await controller.checkOnce();
  failed = true;
  const state = await controller.checkNow();
  assert.equal(state.status, "error");
  assert.match(state.message, /Source: HTTP 403/);
  assert.equal(state.information.release.version, "6.0.0");
  assert.deepEqual(state.information.source, initial.information.source);
  assert.equal(state.information.lastSuccessfulCheckAt, initial.information.lastSuccessfulCheckAt);
  assert.equal(initial.status, "upstream-available");
  failed = false;
  assert.equal((await controller.checkNow()).status, "upstream-available");
});

test("a failed startup release check can be retried without restarting", async t => {
  let fail = true;
  const controller = fixture(t, { fetchRelease: () => {
    if (fail) throw new Error("Offline");
    return stable;
  } });
  assert.equal((await controller.checkOnce()).status, "error");
  fail = false;
  const state = await controller.checkNow();
  assert.equal(state.status, "up-to-date");
  assert.equal(state.information.release.version, "6.0.0");
});

test("drafts, previews, malformed versions and incomplete source evidence never report current", async t => {
  for (const release of [null, { ...stable, draft: true }, { ...stable, prerelease: true },
    { ...stable, tag_name: "bad" }, { ...stable, published_at: "bad" }]) {
    assert.equal((await fixture(t, { fetchRelease: () => release }).checkOnce()).status, "error");
  }
  for (const comparison of [null, { ...ahead, ahead_by: -1 }, { ...ahead, head_commit: {} }, { ...ahead, status: "unknown" }]) {
    assert.equal((await fixture(t, { fetchComparison: () => comparison }).checkOnce()).status, "error");
  }
});

test("malformed fork metadata never enables installation or a guessed comparison", async t => {
  let calls = 0;
  const controller = fixture(t, { fetchComparison: () => { calls++; return identical; } }, { broken: true });
  assert.equal((await controller.checkOnce()).status, "error");
  assert.equal(calls, 0);
  await assert.rejects(controller.beginInstall(), /fork build/);
});
