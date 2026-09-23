import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, sep } from "node:path";

export interface BuildInput {
  path: string;
  sha256: string | null;
  link?: string;
}

export interface BuildSource {
  commit: string | null;
  tree: string | null;
  /** Checkout-wide status for the optional clean-source policy, not an input digest. */
  clean: boolean | null;
  inputHash: string;
  inputs: BuildInput[];
}

/** Pure, ordered, unambiguous digest of the actual working-file bytes and paths. */
export function buildInputHash(inputs: readonly BuildInput[]): string {
  const ordered = [...inputs].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(ordered.map(input => [
    input.path, input.sha256, input.link ?? null,
  ]))).digest("hex");
}

export function assertBuildSourceUnchanged(before: BuildSource, after: BuildSource, requireClean = false): void {
  if (before.commit !== after.commit || before.tree !== after.tree || before.inputHash !== after.inputHash) {
    throw new Error("Source checkout changed during runtime build; discard this candidate and rebuild");
  }
  if (requireClean && (!before.clean || !after.clean)) {
    throw new Error("Deployment runtime requires a clean committed source checkout");
  }
}

/** Read-only collector; importing this module does not build, install, or write anything. */
export function readBuildSource(root: string): BuildSource {
  const canonicalRoot = realpathSync(root);
  const inputs = new Map<string, BuildInput>();
  const insideRoot = (path: string): string => {
    const name = relative(canonicalRoot, path).split(sep).join("/");
    if (isAbsolute(name) || name === ".." || name.startsWith("../") || name.split("/").includes("node_modules")) {
      throw new Error(`Build source input is outside the source boundary: ${path}`);
    }
    return name;
  };
  const readInput = (path: string, optional = false): Buffer | undefined => {
    const name = insideRoot(path);
    if (optional && !existsSync(path)) {
      inputs.set(name, { path: name, sha256: null });
      return undefined;
    }
    const stat = lstatSync(path);
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Unsupported build input: ${name}`);
    insideRoot(realpathSync(path));
    const contents = readFileSync(path);
    inputs.set(name, {
      path: name,
      sha256: createHash("sha256").update(contents).digest("hex"),
      ...(stat.isSymbolicLink() ? { link: readlinkSync(path) } : {}),
    });
    return contents;
  };
  const visitModule = (path: string): void => {
    if (inputs.has(insideRoot(path))) return;
    const contents = readInput(path)!;
    const extension = extname(path);
    const loader = extension === ".tsx" ? "tsx" : extension === ".jsx" ? "jsx"
      : [".ts", ".mts", ".cts"].includes(extension) ? "ts"
      : [".js", ".mjs", ".cjs"].includes(extension) ? "js" : undefined;
    if (!loader) return;
    // scanImports does not accept executable hashbangs; hash the original bytes above.
    const code = contents.toString("utf8").replace(/^#![^\r\n]*/, "");
    const imports = new Bun.Transpiler({ loader }).scanImports(code);
    for (const dependency of imports) {
      // The runtime build uses packages: "external". Track package/lock files below,
      // not installed packages, caches, or the output's freshly installed node_modules.
      if (!dependency.path.startsWith(".") && !isAbsolute(dependency.path)) continue;
      visitModule(Bun.resolveSync(dependency.path, dirname(path)));
    }
  };
  const visitDirectory = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visitDirectory(path);
      else readInput(path);
    }
  };

  for (const entrypoint of [
    "src/cli.ts",
    "src/adapters/chatgpt-web/browser-helper-main.ts",
    "scripts/build-runtime-bundle.ts",
    "scripts/generate-third-party-notices.ts",
  ]) visitModule(join(canonicalRoot, entrypoint));
  for (const file of ["package.json", "bun.lock", "launcher/package.json", "LICENSE", "fork-metadata.json"]) {
    readInput(join(canonicalRoot, file));
  }
  // Absence is part of the snapshot too: adding a config during a build changes its identity.
  for (const file of ["tsconfig.json", "bunfig.toml", "launcher/bun.lock"]) {
    readInput(join(canonicalRoot, file), true);
  }
  visitDirectory(join(canonicalRoot, "LICENSES"));

  const git = (args: string[]) => {
    const result = spawnSync("git", ["-C", canonicalRoot, ...args], { encoding: "utf8", windowsHide: true });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const commit = git(["rev-parse", "HEAD"]);
  const tree = git(["rev-parse", "HEAD^{tree}"]);
  const status = git(["status", "--porcelain", "--untracked-files=normal"]);
  const files = [...inputs.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { commit, tree, clean: commit && tree && status !== null ? status === "" : null,
    inputHash: buildInputHash(files), inputs: files };
}
