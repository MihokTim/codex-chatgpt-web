"""Start a Windows review from an external chat without adopting another pane's identity.

The external process creates one dedicated Orca terminal. Only the process inside
that terminal creates/consumes the Run. Receipts survive errors; mutations are
never retried automatically. Python 3.10+, no third-party dependencies.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from contextlib import contextmanager


def save(path, value):
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(path)


def call(cli, args, directory, name, timeout=90):
    # Save argv BEFORE invoking a mutation so an unknown outcome has a receipt.
    save(directory / (name + ".request.json"), {"argv": [cli, *args, "--json"]})
    try:
        proc = subprocess.run([cli, *args, "--json"], capture_output=True,
                              encoding="utf-8", errors="replace", timeout=timeout)
    except subprocess.TimeoutExpired as error:
        def decoded(value):
            return value.decode("utf-8", errors="replace") if isinstance(value, bytes) else value
        save(directory / (name + ".json"), {"state": "outcome_unknown",
             "stdout": decoded(error.stdout), "stderr": decoded(error.stderr)})
        raise RuntimeError(f"{name}: outcome unknown; inspect receipt, do not relaunch") from error
    try:
        data = json.loads(proc.stdout)
    except ValueError:
        data = {"stdout": proc.stdout, "stderr": proc.stderr, "exitCode": proc.returncode}
    save(directory / (name + ".json"), data)
    if proc.returncode or data.get("ok") is not True:
        raise RuntimeError(f"{name}: inspect {name}.json; resources preserved")
    return data["result"]


def ps_quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def own_identity(env):
    # A handle copied into an external process is insufficient. Require the
    # terminal's pane key as well; CLI validates/remints its own live identity.
    if not env.get("ORCA_TERMINAL_HANDLE") or not env.get("ORCA_PANE_KEY"):
        raise RuntimeError("Coordinator must run inside its newly created Orca terminal")


def bootstrap(config, directory, cli, python):
    # A fresh evidence directory is an at-most-once launch guard.
    directory.mkdir(parents=True, exist_ok=False)
    save(directory / "config.json", config)
    script = Path(__file__).resolve()
    command = "& " + " ".join(ps_quote(p) for p in
                              [python, script, "coordinate", "--directory", directory])
    result = call(cli, ["terminal", "create", "--worktree", "path:" + config["worktree"],
                       "--title", "External review coordinator", "--shell", "powershell.exe",
                       "--command", command], directory, "coordinator-create")
    save(directory / "bootstrap.json", {"state": "coordinator_created", "terminal": result})
    return result


def matching_completion(messages, launch, show):
    # Only this single worker's exact completion can settle this helper's Run.
    # Preserve any mixed FIFO batch rather than ACK unprocessed rows.
    if len(messages) != 1:
        return None
    message = messages[0]
    dispatch = show.get("dispatch", {})
    if (message.get("type") != "worker_done" or
        message.get("run_id") != launch["runId"] or
        message.get("from_handle") != dispatch.get("assigneeHandle") or
        dispatch.get("id") != launch["dispatchId"] or
        dispatch.get("taskId") != launch["taskId"] or
        dispatch.get("runId") != launch["runId"]):
        return None
    try:
        payload = json.loads(message["payload"]) if isinstance(message["payload"], str) else message["payload"]
    except (KeyError, ValueError, TypeError):
        return None
    outcome = payload.get("outcome") if isinstance(payload, dict) else None
    if (outcome not in ("succeeded", "failed") or
        payload.get("taskId") != launch["taskId"] or
        payload.get("dispatchId") != launch["dispatchId"] or
        show.get("worker", {}).get("state") != outcome or
        dispatch.get("status") != ("completed" if outcome == "succeeded" else "failed")):
        return None
    return outcome


@contextmanager
def coordinator_lock(directory):
    # Protect the whole lifetime, including resumed consumers, against two
    # coordinator processes consuming/acknowledging the same Delivery.
    with (directory / "coordinator.lock").open("a+b") as file:
        file.seek(0, 2)
        if not file.tell():
            file.write(b"0")
            file.flush()
        file.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            file.seek(0)
            if os.name == "nt":
                msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(file, fcntl.LOCK_UN)


def coordinate(directory, resume=False):
    own_identity(os.environ)
    with coordinator_lock(directory):
        _coordinate(directory, resume)


def _coordinate(directory, resume=False):
    own_identity(os.environ)
    config = json.loads((directory / "config.json").read_text(encoding="utf-8"))
    cli = config["cli"]
    # Refuse a second invocation that could create a duplicate Run/Dispatch.
    if not resume:
        with (directory / "coordinator.started").open("x", encoding="utf-8") as marker:
            marker.write("started\n")
    else:
        created = json.loads((directory / "coordinator-create.json").read_text(encoding="utf-8"))
        if created["result"]["terminal"]["paneKey"] != os.environ["ORCA_PANE_KEY"]:
            raise RuntimeError("Resume must run inside the original coordinator pane")
    state = {"state": "starting"}
    try:
        if resume:
            previous = json.loads((directory / "status.json").read_text(encoding="utf-8"))
            if previous["state"] == "complete":
                return
            run = json.loads((directory / "run-create.json").read_text(encoding="utf-8"))["result"]["run"]
            current = call(cli, ["orchestration", "run-current"], directory, "resume-run-current")
            if current.get("run", {}).get("id") != run["id"]:
                raise RuntimeError("Coordinator Run changed; do not consume another Run")
        else:
            run = call(cli, ["orchestration", "run-create", "--objective", config["objective"]],
                       directory, "run-create")["run"]
        state["runId"] = run["id"]
        save(directory / "status.json", state)
        launch = (json.loads((directory / "worker-start.json").read_text(encoding="utf-8"))["result"] if resume else
                  call(cli, ["orchestration", "worker-start", "--run", run["id"],
                           "--worktree", "current", "--agent", "codex",
                           "--model", config["model"], "--effort", config["effort"],
                           "--task-title", config["objective"], "--spec", config["spec"],
                           "--timeout-ms", "60000"], directory, "worker-start", 100))
        state.update(state="waiting", dispatchId=launch["dispatchId"], taskId=launch["taskId"])
        save(directory / "status.json", state)
        if launch["state"] != "ready":
            raise RuntimeError("Launch did not prove ready; do not resubmit")
        expected = dict(agent="codex", model=config["model"], effort=config["effort"])
        if launch.get("launch", {}).get("effective") != expected:
            state.update(state="needs_attention", error="Effective model/effort not proved; worker preserved")
            save(directory / "status.json", state)
            return
        deadline = time.monotonic() + config["timeoutSeconds"]
        i = len(list(directory.glob("check-???.request.json")))
        while time.monotonic() < deadline:
            i += 1
            inbox = call(cli, ["orchestration", "check", "--run", run["id"], "--wait",
                              "--types", "worker_done,escalation,question", "--timeout-ms", "20000"],
                         directory, f"check-{i:03}", 45)
            messages = inbox.get("messages", [])
            # Questions/escalations remain unacknowledged for the owner. Never
            # answer, approve, close, or retry an uncertain worker automatically.
            if any(m.get("type") in ("question", "escalation") for m in messages):
                state.update(state="needs_attention", deliveryId=inbox.get("deliveryId"))
                save(directory / "status.json", state)
                return
            show = call(cli, ["orchestration", "worker-show", "--dispatch", launch["dispatchId"]],
                        directory, "worker-show")
            # Trust the runtime's exact Dispatch settlement, not idle terminal
            # text or a free-form worker_done body.
            outcome = matching_completion(messages, launch, show)
            if outcome:
                state.update(state="settled", outcome=outcome)
                save(directory / "status.json", state)
                call(cli, ["orchestration", "worker-read", "--dispatch", launch["dispatchId"],
                           "--source", "auto", "--limit", "100"], directory, "worker-read")
                release = call(cli, ["orchestration", "worker-release", "--dispatch", launch["dispatchId"]],
                               directory, "worker-release")
                state["release"] = release
                if release["state"] not in ("released", "already_released", "retained"):
                    state["state"] = "cleanup_pending"
                    save(directory / "status.json", state)
                    return
                if inbox.get("deliveryId"):
                    following = call(cli, ["orchestration", "check", "--run", run["id"],
                                          "--ack", inbox["deliveryId"]], directory, "delivery-ack")
                    if following.get("messages"):
                        state.update(state="needs_attention", deliveryId=following.get("deliveryId"))
                        save(directory / "status.json", state)
                        return
                state["state"] = "complete"
                save(directory / "status.json", state)
                return
            if messages:
                state.update(state="needs_attention", deliveryId=inbox.get("deliveryId"))
                save(directory / "status.json", state)
                return
            if i % 3 == 0:
                call(cli, ["orchestration", "worker-list", "--run", run["id"]], directory, "worker-list")
        state["state"] = "timeout_preserved"
        save(directory / "status.json", state)
    except Exception as error:
        state.update(state="error_preserved", error=str(error))
        save(directory / "status.json", state)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("start", "coordinate"))
    parser.add_argument("--directory", required=True, type=Path)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--worktree", type=Path)
    parser.add_argument("--spec-file", type=Path)
    parser.add_argument("--objective", default="Independent review")
    parser.add_argument("--model", default="gpt-6.1-sol")
    parser.add_argument("--effort", default="high")
    parser.add_argument("--timeout-seconds", default=600, type=int)
    parser.add_argument("--cli", default=os.environ.get("ORCA_CLI_COMMAND", "orca"))
    args = parser.parse_args()
    directory = args.directory.resolve()
    if args.mode == "coordinate":
        coordinate(directory, args.resume)
    else:
        if not args.worktree or not args.spec_file:
            parser.error("start requires --worktree and --spec-file")
        config = {"cli": args.cli, "worktree": str(args.worktree.resolve()),
                  "spec": args.spec_file.read_text(encoding="utf-8-sig"), "objective": args.objective,
                  "model": args.model, "effort": args.effort, "timeoutSeconds": args.timeout_seconds}
        result = bootstrap(config, directory, args.cli, sys.executable)
        print(json.dumps({"directory": str(directory), "terminal": result}, ensure_ascii=True))


if __name__ == "__main__":
    main()
