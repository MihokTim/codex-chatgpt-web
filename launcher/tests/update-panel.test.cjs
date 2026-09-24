const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

function load(name) {
  const filename = path.join(__dirname, "..", "src", name);
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
    fileName: filename,
  }).outputText;
  const mod = { exports: {} };
  const localRequire = id => id.endsWith(".css") ? {}
    : id === "./update-copy" ? load("update-copy.ts") : require(id);
  Function("module", "exports", "require", output)(mod, mod.exports, localRequire);
  return mod.exports;
}
const { UpdatesPanel } = load("UpdatesPanel.tsx");
const information = {
  installedBuild: "6.0.0-fork.6", integratedCommit: "a".repeat(40),
  checkedAt: "2026-09-24T08:00:00Z", lastSuccessfulCheckAt: "2026-09-24T07:00:00Z",
  release: { version: "6.0.0", newer: false, publishedAt: "2026-09-23T02:51:06Z", url: "https://github.com/miuuyy/codex-chatgpt-web/releases/tag/v6.0.0" },
  source: { aheadBy: 1, status: "ahead", head: "b".repeat(40), url: "https://github.com/miuuyy/codex-chatgpt-web/compare/a...b" },
};

test("English and Japanese panels show same-version release and source changes separately", () => {
  for (const language of ["en", "ja"]) {
    const html = renderToStaticMarkup(React.createElement(UpdatesPanel, {
      language, version: "6.0.0", api: {}, update: { status: "upstream-available", information },
    }));
    assert.match(html, /6\.0\.0-fork\.6/);
    assert.match(html, /v6\.0\.0/);
    assert.match(html, language === "ja" ? /今すぐ確認/ : /Check now/);
    assert.match(html, language === "ja" ? /未取り込みコミット/ : /unmerged commits/);
    assert.match(html, language === "ja" ? /リリースノート/ : /Release notes/);
    assert.doesNotMatch(html, /undefined|NaN/);
  }
});

test("failed update checks retain a visible error and distinguish the last successful check", () => {
  const html = renderToStaticMarkup(React.createElement(UpdatesPanel, {
    language: "ja", version: "6.0.0", api: {}, update: { status: "error", message: "Source: HTTP 403", information },
  }));
  assert.match(html, /role="alert"/);
  assert.match(html, /Source: HTTP 403/);
  assert.match(html, /前回の確認成功/);
  assert.match(html, /古い可能性/);
});

test("an older published version is not mislabeled as the installed version", () => {
  const html = renderToStaticMarkup(React.createElement(UpdatesPanel, {
    language: "en", version: "6.0.1", api: {}, update: { status: "up-to-date", information },
  }));
  assert.match(html, /Installed version is newer/);
  assert.doesNotMatch(html, /Matches the published version/);
});

test("fork update information and check errors are routed to Settings instead of installation", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "..", "electron", "preload.cjs"), "utf8");
  assert.match(app, /updateInformationOnly \? navigateSurface\("settings"\)/);
  assert.match(app, /"upstream-available", "error"/);
  assert.match(preload, /checkUpdates:.*"launcher:update-check"/);
  assert.match(main, /handle\("launcher:update-check"[\s\S]*?updateController\.checkNow\(\)/);
});
