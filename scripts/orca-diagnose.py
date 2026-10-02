"""Read-only, redacted Orca/Codex model and launch diagnostics (Windows)."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import queue
import shutil
import subprocess
import threading
import time
import tomllib


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def describe_error(error):
    return f"{type(error).__name__}: {error}"


def inspect_home(home):
    config = home / "config.toml"
    keys = ("model", "model_provider", "model_catalog_json", "model_reasoning_effort")
    result = {"path": str(home), "config_sha256": None,
              "config": dict.fromkeys(keys), "providers": {}}
    try:
        if config.exists():
            result["config_sha256"] = digest(config)
            data = tomllib.loads(config.read_text(encoding="utf-8-sig"))
            result["config"] = {k: data.get(k) for k in keys}
            result["providers"] = {k: {kk: vv for kk, vv in v.items() if kk in
                ("name", "base_url", "wire_api", "requires_openai_auth")}
                for k, v in data.get("model_providers", {}).items()}
    except (OSError, ValueError, TypeError, AttributeError) as error:
        result["config_error"] = describe_error(error)
    cache = home / "models_cache.json"
    try:
        if cache.exists():
            result["cache_sha256"] = digest(cache)
            cached = json.loads(cache.read_text(encoding="utf-8-sig"))
            result["cached_models"] = [m.get("slug", m.get("id")) for m in cached.get("models", [])]
    except (OSError, ValueError, TypeError, AttributeError) as error:
        result["cache_error"] = describe_error(error)
    return result


def list_models(exe, home):
    # Do not inherit provider/thread routing from the agent performing the probe.
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CODEX_", "ORCA_"))}
    env["CODEX_HOME"] = str(home)
    process = subprocess.Popen([str(exe), "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, encoding="utf-8", env=env,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    messages = queue.Queue()
    def reader():
        try:
            for line in process.stdout:
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                if isinstance(message, dict):
                    messages.put(message)
        except (OSError, UnicodeError) as error:
            messages.put(RuntimeError("app-server stdout: " + describe_error(error)))
        finally:
            messages.put(None)  # Wake an RPC immediately on EOF, including decode failures.
    reader_thread = threading.Thread(target=reader, daemon=True)
    reader_thread.start()
    counter = 0
    def rpc(method, params):
        nonlocal counter
        counter += 1
        process.stdin.write(json.dumps({"id": counter, "method": method, "params": params}) + "\n")
        process.stdin.flush()
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            try:
                message = messages.get(timeout=max(.1, deadline - time.monotonic()))
            except queue.Empty as error:
                raise TimeoutError(f"app-server RPC timed out: {method}") from error
            if message is None:
                raise RuntimeError(f"app-server stdout closed while waiting for {method}")
            if isinstance(message, Exception):
                raise message
            if message.get("id") == counter:
                if "error" in message:
                    raise RuntimeError(str(message["error"]))
                return message["result"]
        raise TimeoutError(f"app-server RPC timed out: {method}")
    try:
        init = rpc("initialize", {"clientInfo": {"name": "orca_repair_diagnostics", "version": "1"},
                                  "capabilities": {"experimentalApi": True}})
        process.stdin.write('{"method":"initialized","params":{}}\n')
        process.stdin.flush()
        models, cursor = [], None
        for _ in range(20):
            page = rpc("model/list", {"limit": 100, "includeHidden": True, **({"cursor": cursor} if cursor else {})})
            models.extend({k: m.get(k) for k in ("id", "model", "displayName", "hidden", "isDefault", "supportedReasoningEfforts")} for m in page.get("data", []))
            cursor = page.get("nextCursor")
            if not cursor:
                break
        return {"initialize": init, "models": models, "nextCursor": cursor, "inference_started": False}
    finally:
        try:
            process.stdin.close()
        except (BrokenPipeError, OSError):
            pass  # A dead probe can close stdin before our buffered write is flushed.
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.terminate()  # Only the disposable probe we created.
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        finally:
            reader_thread.join(timeout=1)
            if not reader_thread.is_alive():
                process.stdout.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--exe", type=Path, help="Explicit executable to compare; never silently fall back")
    args = parser.parse_args()
    local, roaming = Path(os.environ["LOCALAPPDATA"]), Path(os.environ["APPDATA"])
    exe = args.exe or local / "Programs" / "OpenAI" / "Codex" / "bin" / "codex.exe"
    orca = local / "Programs" / "orca" / "resources" / "bin" / "orca.exe"
    result = {"codex": {"path": str(exe), "sha256": digest(exe),
        "version": subprocess.check_output([str(exe), "--version"], encoding="utf-8").strip()},
        "orca_cli": {"path": str(orca), "sha256": digest(orca), "resolved_from_path": shutil.which("orca")},
        "homes": []}
    for home in (Path.home() / ".codex", roaming / "orca" / "codex-runtime-home" / "home"):
        entry = inspect_home(home)
        try:
            entry["app_server"] = list_models(exe, home)
        except Exception as error:
            entry["app_server_error"] = str(error)
        result["homes"].append(entry)
    catalog = roaming / "orca" / "agent-model-catalog.json"
    result["orca_catalog"] = []
    try:
        if catalog.exists():
            result["orca_catalog"] = [{"agent": e.get("agent"), "origin": e.get("origin"),
                "fetchedAt": e.get("fetchedAt"), "models": [m.get("id") for m in e.get("models", [])]}
                for e in json.loads(catalog.read_text(encoding="utf-8-sig")).get("entries", [])]
    except (OSError, ValueError, TypeError, AttributeError) as error:
        result["orca_catalog_error"] = describe_error(error)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    # Keep the console JSON ASCII-safe even when redirected stdout uses CP932.
    # Unicode values remain lossless JSON escapes here and literal UTF-8 in the artifact.
    print(json.dumps({"output": str(args.output), "homes": [{"path": h["path"], "models":
        [m["id"] for m in h.get("app_server", {}).get("models", [])], "error": h.get("app_server_error"),
        **{k: h[k] for k in ("config_error", "cache_error") if k in h}} for h in result["homes"]],
        **{k: result[k] for k in ("orca_catalog_error",) if k in result}}, ensure_ascii=True))


if __name__ == "__main__":
    main()
