// Read-only deployment gate: source, live Git remote and verified runtime bytes must agree.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { validateRuntimeBundle } = require("../launcher/electron/runtime-install.cjs");

function verifyDeployment({ repository, runtimes, checkouts = [], remote = "origin", branches = ["main"] }) {
  const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim();
  const commit = git(repository, "rev-parse", "HEAD");
  for (const root of [repository, ...checkouts]) {
    if (git(root, "rev-parse", "HEAD") !== commit) throw new Error(`Checkout commit differs: ${root}`);
    if (git(root, "status", "--porcelain", "--untracked-files=normal")) throw new Error(`Checkout is not clean: ${root}`);
  }
  if (!runtimes.length || !branches.length) throw new Error("At least one runtime and one remote branch are required");
  const refs = new Map(git(repository, "ls-remote", "--heads", remote, ...branches).split("\n").map(line => line.split(/\s+/).reverse()));
  for (const branch of branches) {
    if (refs.get(`refs/heads/${branch}`) !== commit) throw new Error(`Remote ${remote}/${branch} differs from source HEAD`);
  }
  const bundles = runtimes.map(root => {
    const metadata = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
    validateRuntimeBundle(root, { version: metadata.appVersion, platform: process.platform, arch: process.arch });
    const { source } = JSON.parse(fs.readFileSync(path.join(root, "build-source.json"), "utf8"));
    if (source?.commit !== commit || source.clean !== true) throw new Error(`Runtime was not built from the clean source commit: ${root}`);
    if (source.tree !== git(repository, "rev-parse", "HEAD^{tree}")) throw new Error(`Runtime tree differs: ${root}`);
    return { root: path.resolve(root), bundleId: metadata.bundleId, version: metadata.appVersion };
  });
  if (bundles.some(bundle => bundle.bundleId !== bundles[0].bundleId)) throw new Error("Runtime bundles differ");
  return { status: "SYNCHRONIZED", commit, branches, bundles };
}

if (require.main === module) {
  try {
    const [spec] = process.argv.slice(2);
    if (!spec) throw new Error("Usage: node scripts/verify-deployment.cjs <deployment-spec.json>");
    console.log(JSON.stringify(verifyDeployment(JSON.parse(fs.readFileSync(spec, "utf8"))), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { verifyDeployment };
