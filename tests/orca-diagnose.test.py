"""Synthetic diagnostics tests; never read real homes or start Codex/Orca."""
from pathlib import Path
import base64
import importlib.util
import io
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "orca-diagnose.py"
spec = importlib.util.spec_from_file_location("orca_diagnose", SCRIPT)
diagnose = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnose)
SAMPLE = "日本語\ufffd"


class FakeProcess:
    def __init__(self, stdout=""):
        self.stdin = io.StringIO()
        self.stdout = io.StringIO(stdout) if isinstance(stdout, str) else stdout
        self.stderr = io.StringIO()
        self.wait = mock.Mock(return_value=0)
        self.terminate = mock.Mock()
        self.kill = mock.Mock()


def run_synthetic_main(root, catalog=None):
    """All configured locations and executable metadata are temporary/fake."""
    local, roaming, user = (root / name for name in ("local", "roaming", "user"))
    codex = root / "fake-codex.exe"
    codex.write_bytes(b"not executable")
    orca = local / "Programs" / "orca" / "resources" / "bin" / "orca.exe"
    orca.parent.mkdir(parents=True)
    orca.write_bytes(b"not executable either")
    home = user / ".codex"
    home.mkdir(parents=True)
    (home / "config.toml").write_text("model = [", encoding="utf-8")
    other = roaming / "orca" / "codex-runtime-home" / "home"
    other.mkdir(parents=True)
    (other / "config.toml").write_text('model = "' + SAMPLE + '"', encoding="utf-8-sig")
    if catalog is not None:
        (roaming / "orca" / "agent-model-catalog.json").write_text(catalog, encoding="utf-8-sig")
    output = root / (SAMPLE + ".json")
    with mock.patch.dict(os.environ, {"LOCALAPPDATA": str(local), "APPDATA": str(roaming)}), \
            mock.patch.object(diagnose.Path, "home", return_value=user), \
            mock.patch.object(diagnose.shutil, "which", return_value=None), \
            mock.patch.object(diagnose.subprocess, "check_output", return_value="codex " + SAMPLE) as version, \
            mock.patch.object(diagnose, "list_models", side_effect=[RuntimeError(SAMPLE),
                {"models": [{"id": SAMPLE}], "inference_started": False}]) as models, \
            mock.patch.object(sys, "argv", [str(SCRIPT), "--exe", str(codex), "--output", str(output)]):
        diagnose.main()
    return output, version, models


class DiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_bom_config_and_cache_preserve_unicode(self):
        config = self.root / "config.toml"
        config.write_text('model = "' + SAMPLE + '"', encoding="utf-8-sig")
        (self.root / "models_cache.json").write_text(
            json.dumps({"models": [{"slug": SAMPLE}]}, ensure_ascii=False), encoding="utf-8-sig")
        result = diagnose.inspect_home(self.root)
        self.assertEqual(result["config"]["model"], SAMPLE)
        self.assertEqual(result["cached_models"], [SAMPLE])
        self.assertEqual(result["config_sha256"], diagnose.digest(config))

    def test_malformed_config_does_not_hide_valid_cache(self):
        (self.root / "config.toml").write_text("model = [", encoding="utf-8")
        (self.root / "models_cache.json").write_text('{"models":[{"id":"synthetic"}]}', encoding="utf-8")
        result = diagnose.inspect_home(self.root)
        self.assertIn("TOMLDecodeError", result["config_error"])
        self.assertEqual(result["cached_models"], ["synthetic"])

    def test_invalid_utf8_is_reported_without_replacement(self):
        (self.root / "config.toml").write_bytes(b'model = "\xff"')
        result = diagnose.inspect_home(self.root)
        self.assertIn("UnicodeDecodeError", result["config_error"])
        self.assertIsNone(result["config"]["model"])

    def test_malformed_cache_is_contained(self):
        for content in ("{", "[]", '{"models":[null]}'):
            with self.subTest(content=content):
                (self.root / "models_cache.json").write_text(content, encoding="utf-8")
                result = diagnose.inspect_home(self.root)
                self.assertTrue(result["cache_error"])

    def test_wrong_provider_shape_is_contained(self):
        (self.root / "config.toml").write_text('model_providers = "invalid"', encoding="utf-8")
        self.assertTrue(diagnose.inspect_home(self.root)["config_error"])

    def test_config_redaction_preserved(self):
        (self.root / "config.toml").write_text(
            'model = "synthetic"\nsecret = "omit-top-level"\n[model_providers.test]\n'
            'name = "test"\napi_key = "omit-provider"\n', encoding="utf-8")
        result = diagnose.inspect_home(self.root)
        self.assertEqual(result["providers"], {"test": {"name": "test"}})
        self.assertNotIn("omit-", json.dumps(result))

    def test_rpc_timeout_names_method_and_cleans_up(self):
        process = FakeProcess()
        with mock.patch.object(diagnose.subprocess, "Popen", return_value=process), \
                mock.patch.object(diagnose.queue, "Queue") as queued:
            queued.return_value.get.side_effect = queue.Empty
            with self.assertRaisesRegex(TimeoutError, "initialize"):
                diagnose.list_models(Path("fake.exe"), self.root)
        process.wait.assert_called()
        self.assertTrue(process.stdin.closed)

    def test_rpc_eof_is_reported_promptly(self):
        process = FakeProcess()
        with mock.patch.object(diagnose.subprocess, "Popen", return_value=process):
            with self.assertRaisesRegex(RuntimeError, "closed.*initialize|initialize.*closed"):
                diagnose.list_models(Path("fake.exe"), self.root)

    def test_rpc_invalid_utf8_is_reported(self):
        stream = io.TextIOWrapper(io.BytesIO(b"\xff\n"), encoding="utf-8")
        process = FakeProcess(stream)
        with mock.patch.object(diagnose.subprocess, "Popen", return_value=process):
            with self.assertRaisesRegex(RuntimeError, "UnicodeDecodeError"):
                diagnose.list_models(Path("fake.exe"), self.root)

    def test_rpc_error_is_preserved_when_cleanup_pipe_is_broken(self):
        process = FakeProcess('{"id":1,"error":{"message":"synthetic refusal"}}\n')
        process.stdin = mock.Mock()
        process.stdin.close.side_effect = BrokenPipeError("already closed")
        with mock.patch.object(diagnose.subprocess, "Popen", return_value=process):
            with self.assertRaisesRegex(RuntimeError, "synthetic refusal"):
                diagnose.list_models(Path("fake.exe"), self.root)
        process.wait.assert_called()

    def test_rpc_cleanup_kills_only_created_probe_after_terminate_timeout(self):
        process = FakeProcess()
        process.wait.side_effect = [subprocess.TimeoutExpired("fake", 5),
                                   subprocess.TimeoutExpired("fake", 5), 0]
        with mock.patch.object(diagnose.subprocess, "Popen", return_value=process):
            with self.assertRaisesRegex(RuntimeError, "stdout closed"):
                diagnose.list_models(Path("fake.exe"), self.root)
        process.terminate.assert_called_once_with()
        process.kill.assert_called_once_with()
        self.assertTrue(process.stdout.closed)

    def test_rpc_unicode_models_and_environment_isolation(self):
        responses = [{"id": 1, "result": {}}, {"id": 2, "result": {"data": [{"id": SAMPLE}]}}]
        process = FakeProcess("[]\nnoise\n" + "\n".join(json.dumps(r, ensure_ascii=False) for r in responses))
        with mock.patch.object(diagnose.subprocess, "Popen", return_value=process) as popen, \
                mock.patch.dict(os.environ, {"CODEX_SYNTHETIC": "secret", "ORCA_SYNTHETIC": "secret"}):
            result = diagnose.list_models(Path("fake.exe"), self.root)
        self.assertEqual(result["models"][0]["id"], SAMPLE)
        self.assertFalse(result["inference_started"])
        self.assertEqual(popen.call_args.kwargs["encoding"], "utf-8")
        env = popen.call_args.kwargs["env"]
        self.assertNotIn("CODEX_SYNTHETIC", env)
        self.assertNotIn("ORCA_SYNTHETIC", env)
        self.assertEqual(env["CODEX_HOME"], str(self.root))

    def test_main_continues_other_home_and_missing_optional_catalog(self):
        with mock.patch.object(sys, "stdout", new_callable=io.StringIO) as stdout:
            output, version, models = run_synthetic_main(self.root)
        result = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(len(result["homes"]), 2)
        self.assertIn("config_error", result["homes"][0])
        self.assertEqual(result["homes"][0]["app_server_error"], SAMPLE)
        self.assertEqual(result["homes"][1]["config"]["model"], SAMPLE)
        self.assertEqual(result["orca_catalog"], [])
        self.assertNotIn("orca_catalog_error", result)
        self.assertEqual(version.call_args.kwargs["encoding"], "utf-8")
        self.assertEqual(models.call_count, 2)
        self.assertEqual(json.loads(stdout.getvalue())["homes"][1]["models"], [SAMPLE])
        self.assertIn(SAMPLE.encode("utf-8"), output.read_bytes())

    def test_main_bom_catalog_preserves_unicode(self):
        catalog = json.dumps({"entries": [{"agent": "codex", "models": [{"id": SAMPLE}]}]}, ensure_ascii=False)
        with mock.patch.object(sys, "stdout", new_callable=io.StringIO):
            output, _, _ = run_synthetic_main(self.root, catalog)
        result = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(result["orca_catalog"][0]["models"], [SAMPLE])

    def test_main_malformed_catalog_reports_error_and_keeps_homes(self):
        with mock.patch.object(sys, "stdout", new_callable=io.StringIO) as stdout:
            output, _, _ = run_synthetic_main(self.root, "{")
        result = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(len(result["homes"]), 2)
        self.assertIn("JSONDecodeError", result["orca_catalog_error"])
        self.assertEqual(json.loads(stdout.getvalue())["orca_catalog_error"], result["orca_catalog_error"])

    def test_redirected_cp932_console_preserves_utf8_artifact(self):
        env = dict(os.environ, PYTHONIOENCODING="cp932:strict")
        child = subprocess.run([sys.executable, "-B", str(Path(__file__).resolve()), "--cp932-child", str(self.root)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, timeout=20)
        self.assertEqual(child.returncode, 0, child.stderr.decode("cp932", errors="backslashreplace"))
        summary = json.loads(child.stdout.decode("cp932"))
        output = Path(summary["output"])
        self.assertEqual(summary["homes"][1]["models"], [SAMPLE])
        self.assertIn(SAMPLE.encode("utf-8"), output.read_bytes())
        self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["homes"][0]["app_server_error"], SAMPLE)

    def test_plain_cp932_print_failure_is_local_encoding_error(self):
        child = subprocess.run([sys.executable, "-B", "-c", "print(chr(0xfffd))"],
            env=dict(os.environ, PYTHONIOENCODING="cp932:strict"), capture_output=True, timeout=20)
        self.assertNotEqual(child.returncode, 0)
        self.assertIn(b"UnicodeEncodeError", child.stderr)
        self.assertIn(b"cp932", child.stderr)

    @unittest.skipUnless(os.name == "nt" and shutil.which("powershell"), "Windows PowerShell required")
    def test_windows_powershell_explicit_utf8_roundtrip(self):
        fixture = self.root / "fixture.txt"
        content = "日本語\n置換\ufffd\n三行目\n四行目\n"
        fixture.write_text(content, encoding="utf-8", newline="")
        # EncodedCommand and base64 output avoid depending on the caller's shell encoding.
        command = (
            "$s = Get-Content -LiteralPath $env:DIAGNOSTIC_FIXTURE -Raw -Encoding UTF8; "
            "$default = Get-Content -LiteralPath $env:DIAGNOSTIC_FIXTURE -Raw; "
            "@{utf8=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)); "
            "default=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($default)); "
            "codePage=[Text.Encoding]::Default.CodePage; "
            "defaultLines=@(Get-Content -LiteralPath $env:DIAGNOSTIC_FIXTURE).Count; "
            "utf8Lines=@(Get-Content -LiteralPath $env:DIAGNOSTIC_FIXTURE -Encoding UTF8).Count} "
            "| ConvertTo-Json -Compress")
        encoded = base64.b64encode(command.encode("utf-16le")).decode("ascii")
        result = subprocess.run([shutil.which("powershell"), "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
            env=dict(os.environ, DIAGNOSTIC_FIXTURE=str(fixture)), capture_output=True, check=True, timeout=20)
        result = json.loads(result.stdout.decode("ascii"))
        decoded = base64.b64decode(result["utf8"]).decode("utf-8")
        self.assertEqual(decoded, content)
        self.assertEqual(len(decoded.splitlines()), 4)
        self.assertEqual(result["utf8Lines"], 4)
        if result["codePage"] == 932:
            self.assertNotEqual(base64.b64decode(result["default"]).decode("utf-8"), content)
            self.assertEqual(result["defaultLines"], 3)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--cp932-child":
        run_synthetic_main(Path(sys.argv[2]))
    else:
        unittest.main()
