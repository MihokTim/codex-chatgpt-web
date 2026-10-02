import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("review", Path(__file__).resolve().parents[1] / "scripts" / "orca-external-review.py")
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)


def completion():
    launch = dict(runId="run_own", taskId="task_own", dispatchId="ctx_own", state="ready",
                  launch=dict(effective=dict(agent="codex", model="gpt-6.1-sol", effort="high")))
    message = dict(type="worker_done", run_id="run_own", from_handle="worker_own",
                   payload=json.dumps(dict(taskId="task_own", dispatchId="ctx_own", outcome="succeeded")))
    show = dict(dispatch=dict(id="ctx_own", taskId="task_own", runId="run_own", assigneeHandle="worker_own", status="completed"),
                worker=dict(state="succeeded"))
    return launch, message, show


class ReviewTests(unittest.TestCase):
    def test_only_one_coordinator_can_consume_the_run(self):
        with tempfile.TemporaryDirectory() as temp:
            with review.coordinator_lock(Path(temp)):
                with self.assertRaises(OSError):
                    with review.coordinator_lock(Path(temp)):
                        self.fail("Concurrent consumer acquired lock")
            with review.coordinator_lock(Path(temp)):
                pass

    def test_external_identity_rejected_before_any_mutation(self):
        for env in ({}, {"ORCA_TERMINAL_HANDLE": "someone_else"}):
            with self.assertRaises(RuntimeError):
                review.own_identity(env)

    def test_completion_requires_exact_ids_sender_and_settlement(self):
        launch, message, show = completion()
        self.assertEqual(review.matching_completion([message], launch, show), "succeeded")
        for key in ("run_id", "from_handle", "type", "payload"):
            wrong = {**message, key: "other"}
            self.assertIsNone(review.matching_completion([wrong], launch, show))
        for key in ("taskId", "dispatchId"):
            wrong = {**message, "payload": json.dumps({**json.loads(message["payload"]), key: "other"})}
            self.assertIsNone(review.matching_completion([wrong], launch, show))
        self.assertIsNone(review.matching_completion([message, dict(type="status")], launch, show))
        show["worker"]["state"] = "ready"
        self.assertIsNone(review.matching_completion([message], launch, show))

    def test_bootstrap_cannot_overwrite_coordinator_status(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp) / "receipt with space"
            def create(cli, argv, directory, name):
                self.assertNotIn("--from", argv)
                self.assertNotIn("--focus", argv)
                review.save(directory / "status.json", dict(state="waiting"))
                return {"terminal": {"handle": "new_own"}}
            with patch.object(review, "call", create):
                review.bootstrap(dict(worktree=temp), directory, "orca", "python")
            self.assertEqual(json.loads((directory / "status.json").read_text())["state"], "waiting")
            with self.assertRaises(FileExistsError):
                review.bootstrap(dict(worktree=temp), directory, "orca", "python")

    def run_cycle(self, next_messages=None):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        directory = Path(temp.name)
        review.save(directory / "config.json", dict(cli="orca", objective="review", model="gpt-6.1-sol", effort="high", spec="read", timeoutSeconds=20))
        launch, message, show = completion()
        order = []
        def call(cli, argv, directory, name, timeout=90):
            order.append(name)
            return {"run-create": dict(run=dict(id="run_own")), "worker-start": launch,
                    "check-001": dict(messages=[message], deliveryId="delivery_own"), "worker-show": show,
                    "worker-read": dict(source="transcript"), "worker-release": dict(state="released"),
                    "delivery-ack": dict(messages=next_messages or [], deliveryId="next_delivery")}[name]
        with patch.dict(os.environ, dict(ORCA_TERMINAL_HANDLE="own", ORCA_PANE_KEY="own_pane")), patch.object(review, "call", call):
            review.coordinate(directory)
        return json.loads((directory / "status.json").read_text()), order

    def test_completion_reads_then_releases_then_acks(self):
        state, order = self.run_cycle()
        self.assertEqual(state["state"], "complete")
        self.assertEqual(order[-3:], ["worker-read", "worker-release", "delivery-ack"])

    def test_ack_next_delivery_is_preserved_for_owner(self):
        state, order = self.run_cycle([dict(type="question")])
        self.assertEqual(state["state"], "needs_attention")
        self.assertEqual(state["deliveryId"], "next_delivery")

    def test_timeout_keeps_partial_output_without_retry(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            error = subprocess.TimeoutExpired("orca", 90, output=b'{"requestId":"durable"', stderr=b'unknown')
            with patch.object(subprocess, "run", side_effect=error) as runner:
                with self.assertRaises(RuntimeError):
                    review.call("orca", ["orchestration", "worker-start"], directory, "start")
            self.assertEqual(runner.call_count, 1)
            receipt = json.loads((directory / "start.json").read_text())
            self.assertIn("durable", receipt["stdout"])
            self.assertEqual(receipt["state"], "outcome_unknown")


if __name__ == "__main__":
    unittest.main()
