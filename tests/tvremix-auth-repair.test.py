import importlib.util
import json
import tempfile
import threading
import tomllib
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "tvremix-auth-repair.py"
SPEC = importlib.util.spec_from_file_location("tvremix_auth_repair", SCRIPT)
repair = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(repair)
KEY = "tvr_0123456789abcdefghijklmnopqrstuvwxyz"
CONFIG = b'''model = "gpt-6.1-sol"\r\n# keep this comment\r\n[mcp_servers.tvremix]\r\nurl = "https://tvremix.xyz/api/mcp/v1"\r\ntool_timeout_sec = 60\r\n[mcp_servers.blender]\r\ncommand = "blender-mcp"\r\n'''


class ConfigTests(unittest.TestCase):
    def test_only_tvremix_auth_changes_and_reapplication_is_identical(self):
        updated = repair.render_config(CONFIG, KEY)
        self.assertEqual(updated, repair.render_config(updated, KEY))
        old, new = tomllib.loads(CONFIG.decode()), tomllib.loads(updated.decode())
        self.assertEqual(new["model"], old["model"])
        self.assertEqual(new["mcp_servers"]["blender"], old["mcp_servers"]["blender"])
        self.assertEqual(new["mcp_servers"]["tvremix"]["tool_timeout_sec"], 60)
        self.assertIn(b"# keep this comment\r\n", updated)
        self.assertEqual(new["mcp_servers"]["tvremix"]["http_headers"]["Authorization"], "Bearer " + KEY)

    def test_bom_and_quoted_table_are_preserved(self):
        source = b"\xef\xbb\xbf" + CONFIG.replace(b"[mcp_servers.tvremix]", b'[mcp_servers."tvremix"]')
        self.assertTrue(repair.render_config(source, KEY).startswith(b"\xef\xbb\xbf"))

    def test_conflicting_header_sources_are_replaced_without_losing_other_headers(self):
        source = CONFIG.replace(b"tool_timeout_sec", b'http_headers = { authorization = "old", "X-Region" = "JP" }\r\nenv_http_headers = { Authorization = "OLD_TOKEN", "X-Other" = "OTHER" }\r\nhttp_headers_helper = "old-helper"\r\nbearer_token_env_var = "OLD_TOKEN"\r\ntool_timeout_sec')
        tv = tomllib.loads(repair.render_config(source, KEY).decode())["mcp_servers"]["tvremix"]
        self.assertEqual(tv["http_headers"], {"X-Region": "JP", "Authorization": "Bearer " + KEY})
        self.assertEqual(tv["env_http_headers"], {"X-Other": "OTHER"})
        self.assertNotIn("http_headers_helper", tv)
        self.assertNotIn("bearer_token_env_var", tv)

    def test_wrong_endpoint_disabled_and_multiline_auth_fail_closed(self):
        for source in (CONFIG.replace(b"tvremix.xyz/api", b"example.com/api"),
                       CONFIG.replace(b"tool_timeout_sec", b"enabled = false\r\ntool_timeout_sec"),
                       CONFIG.replace(b"tool_timeout_sec", b'http_headers = {\r\nAuthorization = "old"\r\n}\r\ntool_timeout_sec')):
            with self.assertRaises(repair.RepairError):
                repair.render_config(source, KEY)

    def test_atomic_apply_windows_paths_with_spaces_and_no_secrets_in_report(self):
        with tempfile.TemporaryDirectory(prefix="tvremix auth windows ") as directory:
            root = Path(directory)
            paths = [root / name / "config.toml" for name in ("Codex home", "Orca native", "Orca virtual")]
            for path in paths:
                path.parent.mkdir()
                path.write_bytes(CONFIG)
            report = repair.apply_configs(paths, KEY, root / "private backups")
            self.assertNotIn(KEY, json.dumps(report))
            self.assertEqual(len(report), 3)
            for row in report:
                self.assertEqual(Path(row["backup"]).read_bytes(), CONFIG)
                self.assertEqual(Path(row["path"]).read_bytes(), repair.render_config(CONFIG, KEY))

    def test_later_write_failure_rolls_back_only_our_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = [root / str(i) / "config.toml" for i in range(3)]
            for path in paths:
                path.parent.mkdir()
                path.write_bytes(CONFIG)
            original_replace = repair.os.replace
            calls = 0
            def replace(source, target):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise OSError("simulated write failure")
                return original_replace(source, target)
            with patch.object(repair.os, "replace", side_effect=replace):
                with self.assertRaises(repair.RepairError):
                    repair.apply_configs(paths, KEY, root / "backups")
            self.assertTrue(all(path.read_bytes() == CONFIG for path in paths))


class ProtocolTests(unittest.TestCase):
    def run_server(self, *, reject=False, redirect=False, tool_error=False):
        observed = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                msg = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                observed.append((msg["method"], self.headers.get("Authorization")))
                if reject or redirect:
                    self.send_response(302 if redirect else 401)
                    if redirect:
                        self.send_header("Location", "http://127.0.0.1:1/forbidden")
                    self.end_headers()
                    return
                if msg["method"] == "notifications/initialized":
                    self.send_response(202)
                    self.end_headers()
                    return
                if msg["method"] == "initialize":
                    result = {"protocolVersion": "2025-03-26", "capabilities": {"tools": {}}, "serverInfo": {"name": "fixture", "version": "1"}}
                elif msg["method"] == "tools/list":
                    result = {"tools": [{"name": "search_symbols", "inputSchema": {"type": "object"}}]}
                else:
                    result = {"structuredContent": {"success": not tool_error, "data": {"count": 1}}, "content": [{"type": "text", "text": "fixture"}]}
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}).encode())
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_port}/mcp", observed

    def test_initialize_list_and_real_tool_must_all_succeed(self):
        endpoint, observed = self.run_server()
        result = repair.validate_key(KEY, endpoint)
        self.assertEqual(result, {"initialized": True, "tools": 1, "search_symbols": "succeeded"})
        self.assertEqual([row[0] for row in observed], ["initialize", "notifications/initialized", "tools/list", "tools/call"])
        self.assertTrue(all(row[1] == "Bearer " + KEY for row in observed))
        self.assertNotIn(KEY, json.dumps(result))

    def test_invalid_key_redirect_and_failed_tool_do_not_validate(self):
        for kwargs in ({"reject": True}, {"redirect": True}, {"tool_error": True}):
            endpoint, _ = self.run_server(**kwargs)
            with self.assertRaises(repair.RepairError) as error:
                repair.validate_key(KEY, endpoint)
            self.assertNotIn(KEY, str(error.exception))


if __name__ == "__main__":
    unittest.main()
