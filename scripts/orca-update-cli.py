"""Run the official Codex updater with a durable before/after record; never stop an agent."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import shutil
import subprocess


def info(exe):
    current = Path.home() / ".codex" / "packages" / "standalone" / "current"
    return {"exe": str(exe), "sha256": hashlib.sha256(exe.read_bytes()).hexdigest(),
            "version": subprocess.check_output([str(exe), "--version"], text=True).strip(),
            "releaseTarget": str(current.resolve())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists() and any(output.iterdir()):
        raise ValueError("Use an empty directory to preserve prior evidence")
    output.mkdir(parents=True, exist_ok=True)
    exe = Path(os.environ["LOCALAPPDATA"]) / "Programs" / "OpenAI" / "Codex" / "bin" / "codex.exe"
    before = info(exe)
    (output / "before.json").write_text(json.dumps(before, indent=2), "utf-8")
    for file in exe.parent.glob("*.exe"):
        shutil.copy2(file, output / file.name)
    result = subprocess.run([str(exe), "update"], capture_output=True, text=True, encoding="utf-8", timeout=180)
    (output / "updater.txt").write_text(result.stdout + result.stderr, "utf-8")
    after = info(exe)
    report = {"before": before, "after": after, "updaterExitCode": result.returncode,
              "previousReleaseRetained": Path(before["releaseTarget"]).is_dir(),
              "runningAgentsStopped": False}
    (output / "result.json").write_text(json.dumps(report, indent=2), "utf-8")
    print(json.dumps(report))
    if result.returncode:
        raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
