"""One-time local TVRemix API-key setup; never edits Orca program files.

The key stays in the local process and the user's private MCP configuration.
It is sent only to the fixed, official TVRemix HTTPS endpoint for validation.
No key, authorization code, cookie, or token is written to reports or logs.
"""
from __future__ import annotations

import argparse
import copy
import datetime
import json
import os
import re
import secrets
import threading
import tomllib
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ENDPOINT = "https://tvremix.xyz/api/mcp/v1"
KEY_FORMAT = re.compile(r"tvr_[A-Za-z0-9_-]{16,}")
TABLE = re.compile(r'^\s*\[mcp_servers\.(?:tvremix|"tvremix"|\x27tvremix\x27)\]\s*(?:#.*)?$')
MANAGED_FIELDS = {"http_headers", "env_http_headers", "http_headers_helper", "bearer_token_env_var"}


class RepairError(Exception):
    """Only safe, non-secret error messages may be exposed to the local UI."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def decode_rpc(body: bytes) -> dict:
    text = body.decode("utf-8")
    if text.lstrip().startswith("{"):
        return json.loads(text)
    for line in text.splitlines():
        if line.startswith("data:"):
            return json.loads(line[5:].strip())
    raise RepairError("MCP応答を確認できませんでした。設定は変更していません。")


def validate_key(key: str, endpoint: str = ENDPOINT) -> dict:
    if not KEY_FORMAT.fullmatch(key):
        raise RepairError("tvr_で始まるAPIキーを入力してください。")
    opener = urllib.request.build_opener(NoRedirect())
    headers = {"Authorization": "Bearer " + key, "Accept": "application/json, text/event-stream",
               "Content-Type": "application/json"}
    session_id = None
    def call(method, params, number):
        payload = {"jsonrpc": "2.0", "method": method, "params": params}
        if number is not None:
            payload["id"] = number
        request = urllib.request.Request(endpoint, data=json.dumps(payload).encode(), headers=headers, method="POST")
        try:
            with opener.open(request, timeout=20) as response:
                body = response.read(2_000_000)
                sid = response.headers.get("Mcp-Session-Id")
                return (decode_rpc(body) if number is not None else {}), sid
        except urllib.error.HTTPError as error:
            raise RepairError(f"TVRemixへの認証確認に失敗しました（HTTP {error.code}）。設定は変更していません。") from None
        except (urllib.error.URLError, TimeoutError, ValueError):
            raise RepairError("TVRemixへの接続確認に失敗しました。設定は変更していません。") from None
    try:
        initialized, session_id = call("initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
                                                     "clientInfo": {"name": "tvremix-auth-repair", "version": "1"}}, 1)
        if "error" in initialized or "result" not in initialized:
            raise RepairError("TVRemixの初期化が成功しませんでした。設定は変更していません。")
        protocol = initialized["result"].get("protocolVersion", "2025-03-26")
        headers["MCP-Protocol-Version"] = protocol
        if session_id:
            headers["Mcp-Session-Id"] = session_id
        call("notifications/initialized", {}, None)
        listed, _ = call("tools/list", {}, 2)
        tools = listed.get("result", {}).get("tools", [])
        names = {item.get("name") for item in tools}
        if not tools or "search_symbols" not in names:
            raise RepairError("TVRemixのツールを確認できませんでした。設定は変更していません。")
        searched, _ = call("tools/call", {"name": "search_symbols", "arguments": {"query": "AAPL", "limit": 1}}, 3)
        result = searched.get("result", {})
        if "error" in searched or not result or result.get("isError"):
            raise RepairError("TVRemixの実ツール呼び出しが成功しませんでした。設定は変更していません。")
        payload = result.get("structuredContent")
        if not isinstance(payload, dict):
            for item in result.get("content", []):
                if item.get("type") == "text":
                    try:
                        payload = json.loads(item.get("text", ""))
                    except ValueError:
                        continue
                    if isinstance(payload, dict):
                        break
        if isinstance(payload, dict) and payload.get("success") is False:
            raise RepairError("TVRemixの検索が失敗しました。設定は変更していません。")
        return {"initialized": True, "tools": len(tools), "search_symbols": "succeeded"}
    finally:
        if session_id:
            try:
                with opener.open(urllib.request.Request(endpoint, headers=headers, method="DELETE"), timeout=5):
                    pass
            except (urllib.error.URLError, TimeoutError):
                pass


def render_config(original: bytes, key: str) -> bytes:
    if not KEY_FORMAT.fullmatch(key):
        raise RepairError("APIキーの形式が正しくありません。")
    bom = original.startswith(b"\xef\xbb\xbf")
    text = original.decode("utf-8-sig")
    try:
        before = tomllib.loads(text)
    except tomllib.TOMLDecodeError:
        raise RepairError("設定ファイルの構文を確認できないため変更を停止しました。") from None
    tvremix = before.get("mcp_servers", {}).get("tvremix")
    if not isinstance(tvremix, dict) or tvremix.get("url") != ENDPOINT:
        raise RepairError("対象のTVRemix接続設定が一致しません。")
    if tvremix.get("enabled") is False:
        raise RepairError("無効な接続を自動で有効化できません。")
    newline = "\r\n" if "\r\n" in text else "\n"
    lines = text.splitlines(keepends=True)
    starts = [i for i, line in enumerate(lines) if TABLE.match(line.strip())]
    if len(starts) != 1:
        raise RepairError("TVRemix設定のテーブルを一意に特定できません。")
    start = starts[0]
    end = next((i for i in range(start + 1, len(lines)) if lines[i].lstrip().startswith("[")), len(lines))
    for line in lines:
        if re.match(r'^\s*\[mcp_servers\.tvremix\.(?:http_headers|env_http_headers)\]', line):
            raise RepairError("個別のヘッダーテーブルがあるため自動変更を停止しました。")
    section = lines[start + 1:end]
    # Refuse multiline authentication definitions rather than risk modifying adjacent settings.
    for line in section:
        match = re.match(r'^\s*(\w+)\s*=\s*(.*)', line)
        if match and match[1] in MANAGED_FIELDS:
            try:
                tomllib.loads(line)
            except tomllib.TOMLDecodeError:
                raise RepairError("複数行の認証設定があるため自動変更を停止しました。") from None
    preserved = [line for line in section if not re.match(r'^\s*(?:' + '|'.join(MANAGED_FIELDS) + r')\s*=', line)]
    fixed_headers = dict(tvremix.get("http_headers") or {})
    fixed_headers = {k: v for k, v in fixed_headers.items() if k.lower() != "authorization"}
    fixed_headers["Authorization"] = "Bearer " + key
    env_headers = {k: v for k, v in (tvremix.get("env_http_headers") or {}).items() if k.lower() != "authorization"}
    def inline(mapping):
        return "{ " + ", ".join(json.dumps(k) + " = " + json.dumps(v) for k, v in mapping.items()) + " }"
    added = ["http_headers = " + inline(fixed_headers) + newline]
    if env_headers:
        added.append("env_http_headers = " + inline(env_headers) + newline)
    updated = "".join(lines[:start + 1] + added + preserved + lines[end:])
    after = tomllib.loads(updated)
    expected = copy.deepcopy(before)
    expected_tv = expected["mcp_servers"]["tvremix"]
    for field in MANAGED_FIELDS:
        expected_tv.pop(field, None)
    expected_tv["http_headers"] = fixed_headers
    if env_headers:
        expected_tv["env_http_headers"] = env_headers
    if after != expected:
        raise RepairError("TVRemix以外の設定に差分があるため停止しました。")
    return updated.encode("utf-8-sig" if bom else "utf-8")


def apply_configs(paths: list[Path], key: str, backup_root: Path) -> list[dict]:
    paths = list(dict.fromkeys(path.resolve() for path in paths))
    prepared = [(path, path.read_bytes()) for path in paths]
    changes = [(path, original, render_config(original, key)) for path, original in prepared]
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backups = backup_root / (stamp + "-" + secrets.token_hex(4))
    backups.mkdir(parents=True, exist_ok=False)
    written = []
    try:
        for i, (path, original, updated) in enumerate(changes):
            if path.read_bytes() != original:
                raise RepairError("設定が同時に変更されたため停止しました。")
            (backups / f"config-{i}.toml").write_bytes(original)
            temporary = path.with_name(path.name + ".tvremix-" + secrets.token_hex(4))
            try:
                temporary.write_bytes(updated)
                if path.read_bytes() != original:
                    raise RepairError("設定が同時に変更されたため停止しました。")
                os.replace(temporary, path)
            finally:
                temporary.unlink(missing_ok=True)
            written.append((path, original, updated))
    except Exception:
        for path, original, updated in reversed(written):
            if path.read_bytes() == updated:
                temporary = path.with_name(path.name + ".tvremix-rollback-" + secrets.token_hex(4))
                temporary.write_bytes(original)
                os.replace(temporary, path)
        raise RepairError("設定更新を中止し、今回書き込んだ設定を復元しました。") from None
    return [{"path": str(path), "backup": str(backups / f"config-{i}.toml"),
             "only_tvremix_changed": True, "authentication": "api_key"} for i, (path, _, _) in enumerate(changes)]


def default_paths(root: Path) -> list[Path]:
    return [root / ".codex" / "config.toml",
            root / "AppData" / "Roaming" / "orca" / "codex-runtime-home" / "home" / "config.toml",
            root / "AppData" / "Local" / "Packages" / "OpenAI.Codex_2p2nqsd0c76g0" / "LocalCache" / "Roaming" / "orca" / "codex-runtime-home" / "home" / "config.toml"]


def serve(report_dir: Path):
    root = Path.home()
    paths = default_paths(root)
    # This installer must run on the native host, never through the MSIX file aliases.
    if os.path.samefile(paths[1], paths[2]):
        raise RepairError("Windowsの仮想化された保存先からは設定を書き換えません。")
    for path in paths:
        parsed = tomllib.loads(path.read_text(encoding="utf-8-sig"))
        if parsed.get("mcp_servers", {}).get("tvremix", {}).get("url") != ENDPOINT:
            raise RepairError("対象の接続設定が一致しません。")
    nonce = secrets.token_urlsafe(32)
    lock = threading.Lock()
    status = {"state": "awaiting_user_key", "orca_program_changed": False, "created_chats": 0}
    report_dir.mkdir(parents=True, exist_ok=True)
    report_path = report_dir / "repair-result.json"
    def save_status():
        temporary = report_path.with_suffix(".next.json")
        temporary.write_text(json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, report_path)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def send_json(self, result, code=200):
            body = json.dumps(result, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        def do_GET(self):
            if self.path != "/" + nonce:
                self.send_json({"error": "not_found"}, 404)
                return
            body = (Path(__file__).with_suffix(".html").read_text(encoding="utf-8").replace("__NONCE__", nonce)).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)
        def do_POST(self):
            expected_origin = f"http://127.0.0.1:{self.server.server_port}"
            if (self.path != "/" + nonce or self.headers.get("X-Repair-Nonce") != nonce
                    or self.headers.get("Origin") != expected_origin
                    or self.headers.get("Host") != f"127.0.0.1:{self.server.server_port}"):
                self.send_json({"error": "request_rejected"}, 403)
                return
            if status["state"] == "complete":
                self.send_json({"error": "already_complete"}, 409)
                return
            if not lock.acquire(blocking=False):
                self.send_json({"error": "busy"}, 409)
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 4096:
                    raise RepairError("入力のサイズが正しくありません。")
                key = json.loads(self.rfile.read(size)).get("key", "").strip()
                verified = validate_key(key)
                configs = apply_configs(paths, key, root / ".codex" / "backups" / "tvremix-auth")
                status.update({"state": "complete", "verified": verified, "configs": configs,
                               "completed_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat()})
                save_status()
                self.send_json({"success": True, "tools": verified["tools"], "message": "修復しました。TVRemixの認証、ツール一覧、実際の検索が成功し、3つの接続設定を更新しました。"})
                threading.Timer(30, self.server.shutdown).start()
            except RepairError as error:
                self.send_json({"success": False, "message": str(error)}, 400)
            except Exception:
                self.send_json({"success": False, "message": "修復を完了できませんでした。キーはログや報告には保存していません。"}, 500)
            finally:
                lock.release()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    status["url"] = f"http://127.0.0.1:{server.server_port}/{nonce}"
    status["target_configs"] = [str(path) for path in paths]
    save_status()
    expiry = threading.Timer(3600, server.shutdown)
    expiry.daemon = True
    expiry.start()
    try:
        server.serve_forever()
    finally:
        expiry.cancel()
        server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--report-dir", type=Path, required=True)
    args = parser.parse_args()
    if args.serve:
        serve(args.report_dir)
