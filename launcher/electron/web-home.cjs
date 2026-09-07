const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
function identity(value) {
  const absolute = path.resolve(value);
  let result;
  try { result = fs.realpathSync.native(absolute); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    result = path.join(identity(parent), path.basename(absolute));
  }
  return process.platform === "win32" ? result.toLowerCase() : result;
}
function userPath(value, home) {
  return path.resolve(value === "~" ? home : /^~[\\/]/.test(value) ? path.join(home, value.slice(2)) : value);
}
function resolveWebHome(coreHome, env = process.env, home = os.homedir()) {
  const web = userPath(env.CODEX_WEB_GPT_CODEX_HOME?.trim() || path.join(coreHome, "codex-home"), home);
  for (const native of [path.join(home, ".codex"), (env.CODEX_WEB_GPT_NATIVE_HOME || env.CODEX_HOME)?.trim()]) {
    if (native && identity(web) === identity(userPath(native, home))) {
      throw new Error("Web Codex home must differ from the native Codex home (including realpath aliases)");
    }
  }
  for (const name of ["integration-journal.json", "integration-journal.recovery.json"]) {
    const journalFile = path.join(coreHome, "codex", name);
    if (!fs.existsSync(journalFile)) continue;
    let journal;
    try { journal = JSON.parse(fs.readFileSync(journalFile, "utf8").replace(/^\uFEFF/, "")); }
    catch { continue; } // Journal recovery/validation owns malformed copies.
    // Before isolation, a journal outside the dedicated default home is a legacy native target.
    if (!journal.webProfile && typeof journal.configPath === "string"
      && identity(path.dirname(journal.configPath)) === identity(web)
      && identity(web) !== identity(path.join(coreHome, "codex-home"))) {
      throw new Error("Web home collides with the legacy native journal target");
    }
  }
  return web;
}
module.exports = { identity, resolveWebHome };
