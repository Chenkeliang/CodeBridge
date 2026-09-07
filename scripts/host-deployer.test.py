#!/usr/bin/env python3
import importlib.util
import contextlib
import io
import json
import os
from pathlib import Path
import plistlib
import sqlite3
import tarfile
import tempfile
import threading
import urllib.request
import urllib.error
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("host_deployer", Path(__file__).with_name("host-deployer.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Fake(m.Adapter):
    def __init__(self):
        self.calls = []
        self.fail = None
        self.loaded = True
        self.bootout_polls = 0
        self.archive = b""
        self.notifications = []

    def command(self, args, cwd=None, timeout=1200):
        self.calls.append(args)
        if self.fail and self.fail in args:
            raise m.DeployError("simulated command failure")
        if "launchctl" in args[0]:
            if "bootout" in args:
                self.loaded = False
                self.bootout_polls = 2
            elif "bootstrap" in args:
                if self.bootout_polls:
                    raise AssertionError("bootstrap raced bootout")
                self.loaded = True
            elif "print" in args:
                if self.bootout_polls:
                    self.bootout_polls -= 1
                    return b"state = stopping"
                if not self.loaded:
                    raise m.DeployError("not found")
                return b"state = running\npid = 123"
        if "rev-parse" in args:
            return b"abc123"
        if "archive" in args:
            return self.archive
        if "run" in args and "build" in args:
            output = Path(cwd) / "apps/bridge/dist/cli.js"
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text("built")
        return b""

    def sleep(self, seconds):
        pass

    def http(self, url, token, data=None):
        self.notifications.append((url, data))
        if "tenant_access_token" in url:
            return {"code": 0, "tenant_access_token": "secret"}
        return {"code": 0, "ok": True, "feishuConnected": True, "releaseId": "release", "commit": "abc123"}


class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.data = self.root / "data"
        self.data.mkdir()
        self.plist = self.root / "bridge.plist"
        self.plist.write_bytes(plistlib.dumps({"ProgramArguments": ["/usr/bin/node", "old.js", "start"], "WorkingDirectory": str(self.source)}))
        self.config = {"rootDir": str(self.root / "deploy"), "sourceRepo": str(self.source),
                       "dataDir": str(self.data), "bridgePlist": str(self.plist), "nodePath": "/bin/sh", "pnpmPath": "/bin/sh",
                       "token": "secret", "ownerOpenId": "owner", "runnerToken": "othersecret", "stabilitySec": 0,
                       "feishu": {"appId": "app", "appSecret": "secret"}}
        self.fake = Fake()
        self.d = m.Deployer(self.config, self.fake)
        self.job = {"id": "release", "state": "preparing", "requestedAt": 0, "actorId": "owner", "chatId": "chat",
                    "messageId": "om_original", "ref": "HEAD", "publishAfterPrepare": False}
        self.d.state["jobs"]["release"] = self.job
        with contextlib.closing(sqlite3.connect(self.data / "orchestration.sqlite")) as db:
            db.execute("CREATE TABLE runs (status TEXT, id TEXT)")
            db.execute("CREATE TABLE channel_turn_delivery (status TEXT, created_at TEXT, run_id TEXT)")
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w") as tar:
            for name, value in {"package.json": json.dumps({"scripts": {"build": "build", "test": "test"}}), "pnpm-lock.yaml": "lock"}.items():
                info = tarfile.TarInfo(name)
                raw = value.encode()
                info.size = len(raw)
                tar.addfile(info, io.BytesIO(raw))
        self.fake.archive = archive.getvalue()

    def tearDown(self):
        self.d.lock_file.close()
        self.tmp.cleanup()

    def test_prepare_build_and_hashes(self):
        self.d.prepare(self.job)
        self.assertEqual(self.job["state"], "prepared")
        self.assertIn("apps/bridge/dist/cli.js", self.job["hashes"])
        self.assertTrue((Path(self.job["app"]).parent / "manifest.json").exists())

    def test_missing_executable(self):
        self.config["pnpmPath"] = "/does/not/exist"
        self.d.prepare(self.job)
        self.assertEqual(self.job["state"], "failed")
        self.assertEqual(self.fake.calls, [])

    def test_build_failure_never_switches(self):
        self.fake.fail = "build"
        self.d.prepare(self.job)
        self.assertEqual(self.job["state"], "failed")
        self.assertFalse(any("launchctl" in c[0] for c in self.fake.calls))

    def test_cancel_prepare(self):
        self.job["cancelRequested"] = True
        self.d.prepare(self.job)
        self.assertEqual(self.job["state"], "cancelled")

    def test_bootout_waits_until_service_disappears(self):
        self.d.restart()
        self.assertEqual(sum("print" in c for c in self.fake.calls), 3)
        self.assertEqual(sum("bootstrap" in c for c in self.fake.calls), 1)

    def test_readiness_timeout(self):
        self.config["readinessTimeoutSec"] = 0
        with self.assertRaisesRegex(m.DeployError, "timed out"):
            self.d.verify("wrong", "wrong")

    def test_rollback_failure_keeps_maintenance(self):
        m.atomic(self.d.root / "maintenance.json", {"releaseId": "release"})
        self.job["previousPlist"] = str(self.root / "missing")
        self.d.rollback(self.job)
        self.assertEqual(self.job["state"], "recovery_failed")
        self.assertTrue((self.d.root / "maintenance.json").exists())

    def test_owner_rejection(self):
        with self.assertRaisesRegex(m.DeployError, "owner"):
            self.d.command({"actorId": "attacker", "action": "status"})

    def test_message_idempotency(self):
        self.job["state"] = "prepared"
        req = {"actorId": "owner", "chatId": "chat", "messageId": "om_cancel", "action": "cancel"}
        first = self.d.command(req)
        self.job["state"] = "published"
        self.assertEqual(first, self.d.command(req))

    def test_notification_delivery_deduplicates(self):
        self.d.notify(self.job)
        self.d.notify(self.job)
        self.d.flush_notifications()
        self.d.flush_notifications()
        self.assertEqual(len(self.d.state["notifications"]), 1)
        self.assertEqual(sum("/reply" in url for url, _ in self.fake.notifications), 1)

    def test_recovery_rolls_back_without_reapplying(self):
        self.job["state"] = "switching"
        self.job["previousPlist"] = str(self.plist)
        with patch.object(self.d, "rollback") as rollback:
            self.d.recover()
        rollback.assert_called_once_with(self.job)
        self.assertEqual(self.fake.calls, [])

    def test_stale_deliveries_do_not_block(self):
        self.job["requestedAt"] = 1700000000
        with contextlib.closing(sqlite3.connect(self.data / "orchestration.sqlite")) as db:
            db.execute("INSERT INTO channel_turn_delivery (status, created_at) VALUES (?, ?)", ("pending", "2000-01-01T00:00:00Z"))
            db.commit()
        self.d.drain(self.job)
        self.assertTrue((self.d.root / "maintenance.json").exists())

    def test_exclusive_daemon_lock(self):
        with self.assertRaisesRegex(m.DeployError, "already running"):
            m.Deployer(self.config, self.fake)

    def test_publish_failure_restores_original_plist(self):
        self.d.prepare(self.job)
        original = self.plist.read_bytes()
        with patch.object(self.d, "verify", side_effect=[m.DeployError("timeout"), None]):
            self.d.publish(self.job)
        self.assertEqual(self.job["state"], "rolled_back")
        self.assertEqual(self.plist.read_bytes(), original)
        self.assertFalse((self.d.root / "maintenance.json").exists())

    def test_missing_database_does_not_switch(self):
        self.d.prepare(self.job)
        (self.data / "orchestration.sqlite").unlink()
        original = self.plist.read_bytes()
        self.d.publish(self.job)
        self.assertEqual(self.job["state"], "failed")
        self.assertEqual(self.plist.read_bytes(), original)
        self.assertFalse(any("launchctl" in c[0] for c in self.fake.calls))

    def test_drain_timeout_does_not_switch(self):
        self.d.prepare(self.job)
        with contextlib.closing(sqlite3.connect(self.data / "orchestration.sqlite")) as db:
            db.execute("INSERT INTO runs (status) VALUES (?)", ("running",))
            db.commit()
        self.config["drainTimeoutSec"] = 0
        self.d.publish(self.job)
        self.assertEqual(self.job["state"], "failed")
        self.assertFalse(any("launchctl" in c[0] for c in self.fake.calls))

    def test_health_exposes_busy(self):
        self.assertTrue(self.d.health_status()["active"])
        self.job["state"] = "prepared"
        self.assertFalse(self.d.health_status()["active"])

    def test_failed_recovery_blocks_mutation(self):
        self.job["state"] = "recovery_failed"
        with self.assertRaisesRegex(m.DeployError, "recovery failed"):
            self.d.command({"actorId": "owner", "chatId": "chat", "messageId": "om_new", "action": "prepare"})

    def test_http_auth_and_command_contract(self):
        server = m.create_server(self.d, port=0)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        base = "http://127.0.0.1:" + str(server.server_address[1])
        try:
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(base + "/health")
            self.assertEqual(error.exception.code, 403)
            error.exception.close()
            request = urllib.request.Request(base + "/health", headers={"Authorization": "Bearer secret"})
            with urllib.request.urlopen(request) as response:
                result = json.load(response)
            self.assertTrue(result["ok"])
            self.assertTrue(result["active"])
            request = urllib.request.Request(base + "/command", data=json.dumps({"action": "status", "actorId": "owner", "chatId": "chat", "messageId": "om_http"}).encode(), headers={"Authorization": "Bearer secret"})
            with urllib.request.urlopen(request) as response:
                result = json.load(response)
            self.assertEqual(result["releaseId"], "release")
        finally:
            server.shutdown()
            server.server_close()
            worker.join()

    def test_shared_runtime_switch_restores_both_plists(self):
        self.d.prepare(self.job)
        runner_path = self.root / "runner.plist"
        runner_path.write_bytes(plistlib.dumps({"ProgramArguments": ["/bin/sh", "old-runner.js", "--port", "19789"]}))
        self.config["runnerPlist"] = str(runner_path)
        output = Path(self.job["app"]) / "packages/runner-host/dist/cli.js"
        output.parent.mkdir(parents=True)
        output.write_text("runner")
        self.job["hashes"] = self.d.hashes(Path(self.job["app"]))
        bridge_before, runner_before = self.plist.read_bytes(), runner_path.read_bytes()
        original_git = self.d.git
        def git(*args):
            if args[:2] == ("diff", "--name-only"):
                return b"packages/runner-host/src/main.ts"
            return original_git(*args)
        with patch.object(self.d, "git", side_effect=git), patch.object(self.d, "verify", side_effect=[m.DeployError("timeout"), None]):
            self.d.publish(self.job)
        self.assertEqual(self.job["state"], "rolled_back")
        self.assertEqual(self.plist.read_bytes(), bridge_before)
        self.assertEqual(runner_path.read_bytes(), runner_before)
        self.assertEqual(sum("bootstrap" in c for c in self.fake.calls), 4)

    def test_old_active_run_delivery_still_blocks_after_run_finishes(self):
        self.job["requestedAt"] = 1700000000
        with contextlib.closing(sqlite3.connect(self.data / "orchestration.sqlite")) as db:
            db.execute("INSERT INTO runs VALUES (?, ?)", ("running", "old-active"))
            db.execute("INSERT INTO channel_turn_delivery VALUES (?, ?, ?)", ("pending", "2000-01-01T00:00:00Z", "old-active"))
            db.commit()
        def finish_run(seconds):
            with contextlib.closing(sqlite3.connect(self.data / "orchestration.sqlite")) as db:
                db.execute("UPDATE runs SET status = ?", ("completed",))
                db.commit()
        self.config["drainTimeoutSec"] = 0
        with patch.object(self.fake, "sleep", side_effect=finish_run):
            with self.assertRaisesRegex(m.DeployError, "drain timed out"):
                self.d.drain(self.job)

    def test_recover_published_marker_checks_health_before_clear(self):
        self.job.update(state="published", commit="abc123")
        m.atomic(self.d.root / "maintenance.json", {"releaseId": "release"})
        with patch.object(self.d, "verify") as verify:
            self.d.recover()
        verify.assert_called_once_with("release", "abc123")
        self.assertFalse((self.d.root / "maintenance.json").exists())

    def test_recover_terminal_marker_preserved_if_unhealthy(self):
        self.job.update(state="rolled_back", previousReleaseId="old", previousCommit="oldcommit")
        m.atomic(self.d.root / "maintenance.json", {"releaseId": "release"})
        with patch.object(self.d, "verify", side_effect=m.DeployError("unhealthy")):
            self.d.recover()
        self.assertTrue((self.d.root / "maintenance.json").exists())

    def test_recent_queued_intake_without_run_does_not_block(self):
        self.job["requestedAt"] = 1700000000
        with contextlib.closing(sqlite3.connect(self.data / "orchestration.sqlite")) as db:
            db.execute("INSERT INTO channel_turn_delivery VALUES (?, ?, ?)", ("pending", "2023-11-15T00:00:00Z", None))
            db.execute("INSERT INTO runs VALUES (?, ?)", ("queued", "queued-run"))
            db.execute("INSERT INTO channel_turn_delivery VALUES (?, ?, ?)", ("pending", "2023-11-15T00:00:00Z", "queued-run"))
            db.commit()
        self.config["drainTimeoutSec"] = 0
        self.d.drain(self.job)

    def test_automatic_prepare_never_exposes_prepared_state(self):
        self.job["publishAfterPrepare"] = True
        observed = []
        original_change = self.d.change
        def change(job, state):
            observed.append(state)
            original_change(job, state)
            if state == "draining":
                with self.assertRaisesRegex(m.DeployError, "another release"):
                    self.d.command({"action": "publish", "actorId": "owner", "chatId": "chat", "messageId": "om_race"})
        with patch.object(self.d, "change", side_effect=change), patch.object(self.d, "publish") as publish:
            self.d.prepare(self.job)
        self.assertNotIn("prepared", observed)
        self.assertEqual(observed, ["draining"])
        publish.assert_called_once_with(self.job)

    def test_manual_rollback_does_not_hold_command_mutex(self):
        self.job["manualRollback"] = True
        observed = []
        def rollback(job):
            def inspect_health():
                observed.append(self.d.health_status()["active"])
            worker = threading.Thread(target=inspect_health, daemon=True)
            worker.start()
            worker.join(timeout=1)
            self.assertFalse(worker.is_alive(), "rollback held command mutex")
        with patch.object(self.d, "drain"), patch.object(self.d, "rollback", side_effect=rollback):
            self.d.publish(self.job)
        self.assertEqual(observed, [True])

    def test_failed_and_cancelled_marker_recovery_checks_current(self):
        for state in ("failed", "cancelled"):
            self.job["state"] = state
            m.atomic(self.d.root / "maintenance.json", {"releaseId": "release"})
            with patch.object(self.d, "verify") as verify:
                self.d.recover()
            verify.assert_called_once_with(None, None)
            self.assertFalse((self.d.root / "maintenance.json").exists())

    def test_terminal_notification_recovery_is_idempotent_without_marker(self):
        self.job["state"] = "published"
        self.d.recover()
        self.d.recover()
        self.assertEqual(len(self.d.state["notifications"]), 1)

    def test_health_responds_while_notification_network_blocks(self):
        server = m.create_server(self.d, port=0)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        entered, unblock, stop = threading.Event(), threading.Event(), threading.Event()
        self.d.notify(self.job)
        original_http = self.fake.http
        def blocked_http(*args, **kwargs):
            entered.set()
            unblock.wait(timeout=3)
            return original_http(*args, **kwargs)
        notifier = threading.Thread(target=m.notification_loop, args=(self.d, stop), daemon=True)
        try:
            with patch.object(self.fake, "http", side_effect=blocked_http):
                notifier.start()
                self.assertTrue(entered.wait(timeout=1))
                url = "http://127.0.0.1:" + str(server.server_address[1]) + "/health"
                request = urllib.request.Request(url, headers={"Authorization": "Bearer secret"})
                with urllib.request.urlopen(request, timeout=1) as response:
                    self.assertTrue(json.load(response)["ok"])
                unblock.set()
                stop.set()
                notifier.join(timeout=2)
        finally:
            unblock.set()
            stop.set()
            server.shutdown()
            server.server_close()
            worker.join()

    def test_runner_health_false_is_not_ready(self):
        original = self.fake.http
        def http(url, token, data=None):
            return {"ok": False} if url.endswith("/health") else original(url, token, data)
        with patch.object(self.fake, "http", side_effect=http):
            with self.assertRaisesRegex(m.DeployError, "Runner not ready"):
                self.d.health()

    def test_pid_requires_running_launchd_state(self):
        with patch.object(self.fake, "command", return_value=b"state = stopping\npid = 123"):
            self.assertIsNone(self.d.pid())

    def test_latest_failed_prepare_blocks_older_prepared_fallback(self):
        self.job["state"] = "prepared"
        newer = dict(self.job, id="newer", state="failed", requestedAt=1)
        self.d.state["jobs"]["newer"] = newer
        request = {"action": "publish", "actorId": "owner", "chatId": "chat", "messageId": "om_latest"}
        with patch.object(threading.Thread, "start") as start:
            with self.assertRaisesRegex(m.DeployError, "最新发布 newer"):
                self.d.command(request)
        start.assert_not_called()
        self.assertEqual(self.job["state"], "prepared")
        with patch.object(threading.Thread, "start") as start:
            result = self.d.command(dict(request, releaseId="release"))
        self.assertEqual(result["releaseId"], "release")
        start.assert_called_once()

    def test_controller_changes_require_separate_install(self):
        self.job["commit"] = "newcommit"
        for name in ("scripts/host-deployer.py", "scripts/install-host-deployer.mjs"):
            with patch.object(self.d, "git", return_value=name.encode()):
                with self.assertRaisesRegex(m.DeployError, "请先单独安装控制器"):
                    self.d.compatible(self.job, {"EnvironmentVariables": {"CODEBRIDGE_RELEASE_COMMIT": "oldcommit"}})


if __name__ == "__main__":
    unittest.main()
