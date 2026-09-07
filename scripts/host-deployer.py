#!/usr/bin/env python3
"""Independent localhost deployment supervisor. Run with --config /absolute/config.json."""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import sqlite3
import subprocess
import tarfile
import threading
import time
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


MESSAGES = {
    "preparing": "正在准备发布，完成后通知你。", "prepared": "发布准备完成，可以发布了。",
    "draining": "正在等待当前任务和消息交付完成，然后切换版本。", "switching": "正在切换版本。",
    "verifying": "正在验证新版本和飞书连接。", "published": "发布成功，服务已通过检查。",
    "rolling_back": "正在恢复上一个版本。", "rolled_back": "已恢复上一个版本，服务检查通过。",
    "recovery_failed": "恢复失败，仍处于维护状态，需要人工处理。", "cancelled": "发布已取消。",
    "failed": "发布未完成，请查看失败原因。", "none": "这个会话还没有发布记录。",
}


class DeployError(Exception):
    pass


def atomic(path, value, binary=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with open(temporary, "wb") as stream:
        os.chmod(temporary, 0o600)
        stream.write(value if binary else json.dumps(value, ensure_ascii=False, indent=2).encode())
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class Adapter:
    def command(self, args, cwd=None, timeout=1200):
        try:
            result = subprocess.run(args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    timeout=timeout, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise DeployError("command unavailable or timed out: " + Path(args[0]).name)
        if getattr(self, "log_path", None):
            atomic(self.log_path, result.stdout + b"\n" + result.stderr, True)
        if result.returncode:
            raise DeployError("command failed: " + Path(args[0]).name)
        return result.stdout

    def http(self, url, token, data=None):
        body = None if data is None else json.dumps(data).encode()
        request = urllib.request.Request(url, data=body, headers={
            "Authorization": "Bearer " + token, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                raw = response.read()
                return json.loads(raw) if raw else {}
        except Exception:
            raise DeployError("HTTP verification or notification failed")

    def sleep(self, seconds):
        time.sleep(seconds)


class Deployer:
    ACTIVE = {"preparing", "draining", "switching", "verifying", "rolling_back"}

    def __init__(self, config, adapter=None, recover=True):
        self.c = config
        self.a = adapter or Adapter()
        for key in ("token", "ownerOpenId", "sourceRepo", "dataDir", "bridgePlist", "nodePath", "pnpmPath"):
            if not config.get(key):
                raise DeployError("missing config field: " + key)
        self.root = Path(config.get("rootDir", str(Path(config["dataDir"]).expanduser() / "deployer"))).expanduser().resolve()
        self.source = Path(config["sourceRepo"]).expanduser().resolve()
        self.data = Path(config["dataDir"]).expanduser().resolve()
        if self.root == Path("/") or self.source == self.root or self.root in self.source.parents:
            raise DeployError("unsafe deployment paths")
        self.root.mkdir(parents=True, exist_ok=True)
        os.chmod(self.root, 0o700)
        self.lock_file = open(self.root / "daemon.lock", "a+")
        try:
            fcntl.flock(self.lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.lock_file.close()
            raise DeployError("deployer already running")
        self.mutex = threading.RLock()
        self.state_path = self.root / "state.json"
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {
            "jobs": {}, "messages": {}, "current": None, "notifications": []}
        if recover:
            self.recover()

    def save(self):
        with self.mutex:
            atomic(self.state_path, self.state)

    def change(self, job, state):
        with self.mutex:
            job["state"] = state
            job["updatedAt"] = time.time()
            self.save()

    def command(self, request):
        with self.mutex:
            if request.get("actorId") != self.c["ownerOpenId"]:
                raise DeployError("only the configured owner may deploy")
            if not all(isinstance(request.get(k), str) and request[k] for k in ("chatId", "messageId")):
                raise DeployError("chatId and messageId are required")
            key = ":".join((request["actorId"], request["messageId"], str(request.get("action", "")), str(request.get("releaseId", ""))))
            if request.get("action") != "status" and key in self.state["messages"]:
                return self.state["messages"][key]
            action = request.get("action")
            if action not in ("prepare", "publish", "status", "cancel", "rollback"):
                raise DeployError("unknown deployment action")
            job = None
            release_id = request.get("releaseId")
            if release_id:
                job = self.state["jobs"].get(release_id)
                if not job or job["actorId"] != request["actorId"] or job["chatId"] != request["chatId"]:
                    raise DeployError("release not found in this conversation")
            candidates = [j for j in self.state["jobs"].values()
                          if j["actorId"] == request["actorId"] and j["chatId"] == request["chatId"]]
            active = any(j["state"] in self.ACTIVE for j in self.state["jobs"].values())
            launch = None
            if action in ("prepare", "publish") and any(j["state"] == "recovery_failed" for j in self.state["jobs"].values()):
                raise DeployError("recovery failed; repair the previous release before preparing or publishing")
            if action == "prepare":
                if active:
                    raise DeployError("another release is active")
                release_id = datetime.datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:8]
                job = {"id": release_id, "actorId": request["actorId"], "chatId": request["chatId"],
                       "messageId": request["messageId"], "requestedAt": time.time(), "state": "preparing",
                       "ref": request.get("ref") or "HEAD", "publishAfterPrepare": bool(request.get("publishAfterPrepare"))}
                self.state["jobs"][release_id] = job
                launch = self.prepare
            elif action == "status":
                job = job or (max(candidates, key=lambda j: j["requestedAt"]) if candidates else None)
            elif action == "cancel":
                job = job or next((j for j in candidates if j["state"] in ("preparing", "prepared", "draining")), None)
                if not job or job["state"] not in ("preparing", "prepared", "draining"):
                    raise DeployError("release cannot be cancelled after switching")
                job["cancelRequested"] = True
                if job["state"] == "prepared":
                    self.change(job, "cancelled")
            else:
                if active:
                    raise DeployError("another release is active")
                if action == "publish":
                    job = job or (max(candidates, key=lambda j: j["requestedAt"]) if candidates else None)
                    if not job:
                        raise DeployError("请先准备一个发布版本。")
                    if job["state"] != "prepared":
                        raise DeployError("最新发布 " + job["id"] + " 尚不可发布：" + MESSAGES.get(job["state"], job["state"]))
                else:
                    job = job or self.state["jobs"].get(self.state["current"])
                    if not job or job["id"] != self.state["current"] or not job.get("previousPlist"):
                        raise DeployError("only the current release with a known previous version can roll back")
                job["messageId"] = request["messageId"]
                job["requestedAt"] = time.time()
                job["manualRollback"] = action == "rollback"
                job["cancelRequested"] = False
                self.change(job, "draining")
                launch = self.publish
            result = {"message": MESSAGES.get(job["state"] if job else "none"),
                      "state": job["state"] if job else "none"}
            if job:
                result["releaseId"] = job["id"]
                if action == "cancel" and job.get("cancelRequested") and job["state"] != "cancelled":
                    result["message"] = "已收到取消请求，将在安全检查点停止，不会切换服务。"
                elif job.get("error") and job["state"] in ("failed", "recovery_failed", "rolled_back"):
                    result["message"] += " 原因：" + job["error"]
            self.state["messages"][key] = result
            self.save()
            if launch:
                threading.Thread(target=launch, args=(job,), daemon=True).start()
            return result

    def abort(self, job):
        if job.get("cancelRequested"):
            raise DeployError("release cancelled")

    def git(self, *args):
        return self.a.command([self.c.get("gitPath", "/usr/bin/git"), "-C", str(self.source), *args])

    def prepare(self, job):
        try:
            for key in ("nodePath", "pnpmPath"):
                if not Path(self.c[key]).is_absolute() or not os.access(self.c[key], os.X_OK):
                    raise DeployError("missing executable: " + key)
            self.abort(job)
            if self.git("status", "--porcelain", "--untracked-files=all").strip():
                raise DeployError("source repository contains uncommitted files")
            ref = job["ref"]
            if not isinstance(ref, str) or ref.startswith("-"):
                raise DeployError("invalid ref")
            commit = self.git("rev-parse", "--verify", ref + "^{commit}").decode().strip()
            app = self.root / "releases" / job["id"] / "app"
            app.mkdir(parents=True)
            archive = self.git("archive", "--format=tar", commit)
            with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
                for member in tar.getmembers():
                    destination = (app / member.name).resolve()
                    if app not in destination.parents or member.issym() or member.islnk() or not (member.isfile() or member.isdir()):
                        raise DeployError("unsafe archive entry")
                tar.extractall(app)
            job.update(commit=commit, app=str(app))
            package = json.loads((app / "package.json").read_text())
            if not all(package.get("scripts", {}).get(k) for k in ("build", "test")):
                raise DeployError("release requires build and test scripts")
            if not (app / "pnpm-lock.yaml").is_file():
                raise DeployError("frozen lockfile missing")
            for args in (("install", "--frozen-lockfile"), ("run", "build"), ("run", "test")):
                self.abort(job)
                job["stage"] = "install" if args[0] == "install" else args[1]
                log_path = app.parent / (job["stage"] + ".log")
                atomic(log_path, b"", True)
                self.a.log_path = log_path
                self.save()
                try:
                    self.a.command([self.c["pnpmPath"], *args], cwd=str(app))
                finally:
                    self.a.log_path = None
            self.abort(job)
            if not (app / "apps/bridge/dist/cli.js").is_file():
                raise DeployError("Bridge build output missing")
            job["hashes"] = self.hashes(app)
            job["build"] = job["test"] = "passed"
            job["preparedAt"] = time.time()
            atomic(app.parent / "manifest.json", job)
            if job["publishAfterPrepare"]:
                # Reserve the existing worker without exposing a publishable gap.
                self.change(job, "draining")
                self.publish(job)
            else:
                self.change(job, "prepared")
                self.notify(job)
        except Exception as error:
            job["error"] = (job.get("stage", "prepare") + ": " + str(error)) if isinstance(error, DeployError) else "prepare failed"
            self.change(job, "cancelled" if job.get("cancelRequested") else "failed")
            self.notify(job)

    def hashes(self, app):
        for directory, dirs, files in os.walk(app, followlinks=False):
            dirs[:] = [name for name in dirs if name != "node_modules"]
            for name in dirs + files:
                path = Path(directory) / name
                if path.is_symlink() and app not in path.resolve().parents:
                    raise DeployError("release contains an external symlink")
        return {str(p.relative_to(app)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in sorted(app.rglob("*")) if p.is_file() and "node_modules" not in p.relative_to(app).parts}

    def drain(self, job):
        atomic(self.root / "maintenance.json", {"releaseId": job["id"], "since": job["requestedAt"]})
        db_path = self.data / "orchestration.sqlite"
        if not db_path.is_file():
            raise DeployError("orchestration database missing")
        with contextlib.closing(sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True)) as db:
            active_ids = [row[0] for row in db.execute("SELECT id FROM runs WHERE status = ?", ("running",))]
        self.a.sleep(max(3, self.c.get("ackGraceSec", 3)))
        deadline = time.monotonic() + self.c.get("drainTimeoutSec", 300)
        since = datetime.datetime.fromtimestamp(job["requestedAt"] - 120, datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        while True:
            self.abort(job)
            db_path = self.data / "orchestration.sqlite"
            if not db_path.is_file():
                raise DeployError("orchestration database missing")
            with contextlib.closing(sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True)) as db:
                running = db.execute("SELECT count(*) FROM runs WHERE status = ?", ("running",)).fetchone()[0]
                placeholders = ",".join("?" for _ in active_ids) or "NULL"
                pending = db.execute("SELECT count(*) FROM channel_turn_delivery WHERE status != ? AND (run_id IN (SELECT id FROM runs WHERE status NOT IN (?, ?)) OR status = ?) AND (created_at >= ? OR run_id IN (" + placeholders + "))", ("completed", "queued", "pending", "delivering", since, *active_ids)).fetchone()[0]
            if running == 0 and pending == 0:
                return
            if time.monotonic() >= deadline:
                raise DeployError("drain timed out; no services were switched")
            self.a.sleep(1)

    def service(self, kind="bridge"):
        return "gui/" + str(os.getuid()) + "/" + self.c.get(kind + "Label", "com.codebridge." + kind)

    def pid(self, kind="bridge"):
        try:
            output = self.a.command(["/bin/launchctl", "print", self.service(kind)], timeout=15).decode()
            match = re.search(r"\bpid = (\d+)", output)
            return match.group(1) if match and re.search(r"\bstate = running\b", output) else None
        except DeployError:
            return None

    def restart(self, kind="bridge"):
        try:
            self.a.command(["/bin/launchctl", "bootout", self.service(kind)], timeout=30)
        except DeployError:
            pass
        deadline = time.monotonic() + 30
        while True:
            try:
                self.a.command(["/bin/launchctl", "print", self.service(kind)], timeout=10)
            except DeployError:
                break
            if time.monotonic() >= deadline:
                raise DeployError("launchd bootout did not finish")
            self.a.sleep(0.2)
        self.a.command(["/bin/launchctl", "bootstrap", "gui/" + str(os.getuid()), self.c[kind + "Plist"]], timeout=30)

    def health(self, release_id=None, commit=None):
        base = "http://127.0.0.1:" + str(self.c.get("apiPort", 19790))
        token = self.c["runnerToken"]
        result = self.a.http(base + "/deploy/readiness", token)
        if result.get("ok") is not True or result.get("feishuConnected") is not True:
            raise DeployError("Bridge not ready or Feishu disconnected")
        if release_id and (result.get("releaseId") != release_id or result.get("commit") != commit):
            raise DeployError("Bridge release identity mismatch")
        self.a.http(base + "/v1/sessions", token)
        runner = self.a.http(self.c.get("runnerUrl", "http://127.0.0.1:19789").rstrip("/") + "/health", token)
        if runner.get("ok") is not True:
            raise DeployError("Runner not ready")

    def verify(self, release_id=None, commit=None):
        deadline = time.monotonic() + self.c.get("readinessTimeoutSec", 90)
        stable_since, previous_pid = None, None
        while time.monotonic() < deadline:
            try:
                self.health(release_id, commit)
                bridge_pid = self.pid()
                runner_pid = self.pid("runner")
                pid = (bridge_pid, runner_pid)
                if not bridge_pid or not runner_pid:
                    raise DeployError("Bridge PID missing")
                if pid != previous_pid:
                    stable_since, previous_pid = time.monotonic(), pid
                if time.monotonic() - stable_since >= self.c.get("stabilitySec", 10):
                    return
            except DeployError:
                stable_since, previous_pid = None, None
            self.a.sleep(0.5)
        raise DeployError("release readiness timed out")

    def compatible(self, job, old):
        env = old.get("EnvironmentVariables", {})
        baseline = env.get("CODEBRIDGE_RELEASE_COMMIT")
        if not baseline:
            directory = old.get("WorkingDirectory")
            if not directory:
                raise DeployError("running source baseline unknown")
            baseline = self.a.command([self.c.get("gitPath", "/usr/bin/git"), "-C", directory, "rev-parse", "HEAD"]).decode().strip()
        changes = self.git("diff", "--name-only", baseline, job["commit"]).decode().splitlines()
        for name, config_key in (("scripts/host-deployer.py", "installedControllerHash"),
                                 ("scripts/install-host-deployer.mjs", "installerHash")):
            if name not in changes:
                continue
            installed_hash = self.c.get(config_key)
            if name == "scripts/host-deployer.py" and not installed_hash:
                installed_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
            candidate = self.git("show", job["commit"] + ":" + name)
            if not installed_hash or hashlib.sha256(candidate).hexdigest() != installed_hash:
                raise DeployError("此版本修改了独立发布控制器或安装器，请先单独安装控制器；普通业务发布不会更新已安装的控制器。")
        patch = self.git("diff", "--unified=0", baseline, job["commit"], "--", "*.ts", "*.sql").decode()
        if any(re.search(r"\b(CREATE|ALTER|DROP)\s+TABLE\b", line, re.I)
               for line in patch.splitlines() if line.startswith(("+", "-")) and not line.startswith(("+++", "---"))):
            raise DeployError("database schema change requires a separately reviewed migration")
        bridge_only = ("apps/bridge/", "apps/web/", "packages/channel-feishu/", "packages/run-executor/",
                       "packages/session-coordinator/", "packages/work-items/", "docs/", "scripts/")
        job["restartRunner"] = any(not (name.endswith(".md") or name.startswith(bridge_only))
                                   or name.endswith("package.json") for name in changes)
        if self.c.get("runnerPlist"):
            runner = plistlib.loads(Path(self.c["runnerPlist"]).read_bytes())
            args = runner.get("ProgramArguments", [])
            directory = Path(runner.get("WorkingDirectory", "/")).resolve()
            releases = self.root / "releases"
            frozen = (directory.name == "app" and directory.parent.parent == releases
                      and len(args) >= 2 and Path(args[1]).resolve() == directory / "packages/runner-host/dist/cli.js")
            if not frozen:
                job["restartRunner"] = True
        if job["restartRunner"] and not self.c.get("runnerPlist"):
            raise DeployError("Runner restart requires runnerPlist configuration")

    def publish(self, job):
        switched = False
        try:
            self.drain(job)
            with self.mutex:
                self.abort(job)
                manual_rollback = bool(job.get("manualRollback"))
                if manual_rollback:
                    self.change(job, "rolling_back")
            if manual_rollback:
                self.rollback(job)
                return
            with self.mutex:
                self.abort(job)
                app = Path(job["app"])
                if self.hashes(app) != job["hashes"]:
                    raise DeployError("prepared release files changed")
                plist_path = Path(self.c["bridgePlist"])
                old_bytes = plist_path.read_bytes()
                old = plistlib.loads(old_bytes)
                self.compatible(job, old)
                backup = self.root / "releases" / job["id"] / "previous.plist"
                atomic(backup, old_bytes, True)
                job["previousPlist"] = str(backup)
                job["previousReleaseId"] = self.state["current"]
                job["previousCommit"] = old.get("EnvironmentVariables", {}).get("CODEBRIDGE_RELEASE_COMMIT")
                if job["restartRunner"]:
                    runner_bytes = Path(self.c["runnerPlist"]).read_bytes()
                    runner_old = plistlib.loads(runner_bytes)
                    runner_backup = backup.with_name("previous-runner.plist")
                    atomic(runner_backup, runner_bytes, True)
                    job["previousRunnerPlist"] = str(runner_backup)
                    runner_new = dict(runner_old)
                    runner_args = runner_old.get("ProgramArguments", [])
                    if len(runner_args) < 2 or not (app / "packages/runner-host/dist/cli.js").is_file():
                        raise DeployError("Runner launch arguments or build output missing")
                    runner_new["ProgramArguments"] = [self.c["nodePath"], str(app / "packages/runner-host/dist/cli.js"), *runner_args[2:]]
                    runner_new["WorkingDirectory"] = str(app)
                    runner_new["EnvironmentVariables"] = dict(runner_old.get("EnvironmentVariables", {}), CODEBRIDGE_RELEASE_ID=job["id"], CODEBRIDGE_RELEASE_COMMIT=job["commit"])
                self.change(job, "switching")
                switched = True
                if job["restartRunner"]:
                    atomic(self.c["runnerPlist"], plistlib.dumps(runner_new), True)
                new = dict(old)
                new["ProgramArguments"] = [self.c["nodePath"], str(app / "apps/bridge/dist/cli.js"), "start", "--data-dir", str(self.data)]
                new["WorkingDirectory"] = str(app)
                new["EnvironmentVariables"] = dict(old.get("EnvironmentVariables", {}), CODEBRIDGE_RELEASE_ID=job["id"], CODEBRIDGE_RELEASE_COMMIT=job["commit"])
                atomic(plist_path, plistlib.dumps(new), True)
            if job.get("restartRunner"):
                self.restart("runner")
            self.restart()
            self.change(job, "verifying")
            self.verify(job["id"], job["commit"])
            self.state["current"] = job["id"]
            self.change(job, "published")
            self.clear_maintenance()
            self.notify(job)
        except Exception as error:
            job["error"] = str(error) if isinstance(error, DeployError) else "publish failed"
            if switched:
                self.rollback(job)
            else:
                self.change(job, "cancelled" if job.get("cancelRequested") else "failed")
                self.clear_maintenance()
                self.notify(job)

    def health_status(self):
        with self.mutex:
            return {"ok": True, "active": any(j["state"] in self.ACTIVE for j in self.state["jobs"].values()),
                    "pid": os.getpid(), "currentReleaseId": self.state["current"]}

    def clear_maintenance(self):
        (self.root / "maintenance.json").unlink(missing_ok=True)

    def rollback(self, job):
        try:
            self.change(job, "rolling_back")
            atomic(self.c["bridgePlist"], Path(job["previousPlist"]).read_bytes(), True)
            if job.get("previousRunnerPlist"):
                atomic(self.c["runnerPlist"], Path(job["previousRunnerPlist"]).read_bytes(), True)
                self.restart("runner")
            self.restart()
            self.verify(job.get("previousReleaseId"), job.get("previousCommit"))
            self.state["current"] = job.get("previousReleaseId")
            self.change(job, "rolled_back")
            self.clear_maintenance()
        except Exception:
            job["error"] = "rollback health verification failed; maintenance remains enabled"
            self.change(job, "recovery_failed")
        self.notify(job)

    def recover(self):
        for job in self.state["jobs"].values():
            if job["state"] in ("switching", "verifying", "rolling_back"):
                self.rollback(job)
            elif job["state"] in ("preparing", "draining"):
                self.change(job, "failed")
                job["error"] = "deployer interrupted before switching"
                self.clear_maintenance()
                self.notify(job)

        marker = self.root / "maintenance.json"
        if marker.exists():
            try:
                release_id = json.loads(marker.read_text()).get("releaseId")
                job = self.state["jobs"].get(release_id)
                if job and job["state"] in ("published", "rolled_back", "failed", "cancelled"):
                    if job["state"] in ("failed", "cancelled"):
                        current = self.state["jobs"].get(self.state["current"], {})
                        expected_id, expected_commit = current.get("id"), current.get("commit")
                    else:
                        expected_id = job["id"] if job["state"] == "published" else job.get("previousReleaseId")
                        expected_commit = job.get("commit") if job["state"] == "published" else job.get("previousCommit")
                    self.verify(expected_id, expected_commit)
                    self.clear_maintenance()
            except Exception:
                # Keep maintenance if reconciliation cannot prove the live version healthy.
                pass

        for job in self.state["jobs"].values():
            if job["state"] in ("prepared", "published", "rolled_back", "failed", "cancelled", "recovery_failed"):
                self.notify(job)

    def notify(self, job):
        with self.mutex:
            notification_id = str(uuid.uuid5(uuid.NAMESPACE_URL, job["id"] + ":" + job["state"]))
            if not any(n["id"] == notification_id for n in self.state["notifications"]):
                self.state["notifications"].append({"id": notification_id, "messageId": job["messageId"],
                    "text": "发布 " + job["id"] + "：" + MESSAGES.get(job["state"], job["state"]) + ("；" + job["error"] if job.get("error") else ""), "sent": False})
                self.save()

    def flush_notifications(self):
        feishu = self.c.get("feishu", {})
        if not feishu.get("appId") or not feishu.get("appSecret"):
            return
        domain = feishu.get("domain", "https://open.feishu.cn").rstrip("/")
        if domain not in ("https://open.feishu.cn", "https://open.larksuite.com"):
            return
        for notification in self.state["notifications"][:]:
            if notification["sent"]:
                continue
            try:
                result = self.a.http(domain + "/open-apis/auth/v3/tenant_access_token/internal", "", {
                    "app_id": feishu["appId"], "app_secret": feishu["appSecret"]})
                if result.get("code") != 0 or not result.get("tenant_access_token"):
                    continue
                message_id = notification["messageId"]
                if not re.fullmatch(r"[A-Za-z0-9_-]+", message_id):
                    continue
                sent = self.a.http(domain + "/open-apis/im/v1/messages/" + message_id + "/reply", result["tenant_access_token"], {
                    "msg_type": "text", "content": json.dumps({"text": notification["text"]}, ensure_ascii=False), "uuid": notification["id"]})
                if sent.get("code") == 0:
                    with self.mutex:
                        notification["sent"] = True
                        self.save()
            except DeployError:
                pass


def notification_loop(deployer, stop):
    while not stop.is_set():
        try:
            deployer.flush_notifications()
        except Exception:
            # Delivery must never stop health checks or the durable release worker.
            pass
        stop.wait(10)


def create_server(deployer, port=19791):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, status, value):
            body = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def authorized(self):
            return hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + deployer.c["token"])

        def do_GET(self):
            allowed = self.authorized() and self.path == "/health"
            self.reply(200 if allowed else 403, deployer.health_status() if allowed else {"ok": False})

        def do_POST(self):
            if not self.authorized():
                self.reply(403, {"message": "unauthorized", "state": "rejected"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if self.path != "/command" or length < 1 or length > 16384:
                    raise DeployError("invalid request")
                request = json.loads(self.rfile.read(length))
                if not isinstance(request, dict):
                    raise DeployError("invalid command")
                self.reply(200, deployer.command(request))
            except Exception as error:
                self.reply(400, {"message": str(error) if isinstance(error, DeployError) else "invalid request", "state": "rejected"})

    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=str(Path.home() / ".codebridge/deployer/config.json"))
    args = parser.parse_args()
    deployer = Deployer(json.loads(Path(args.config).read_text()))
    server = create_server(deployer)
    stop = threading.Event()
    notifier = threading.Thread(target=notification_loop, args=(deployer, stop), daemon=True)
    notifier.start()
    try:
        server.serve_forever()
    finally:
        stop.set()
        server.server_close()


if __name__ == "__main__":
    main()
