#!/usr/bin/env python3
"""Run an isolated local mlhops stack; never reads production secrets or databases."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
MLHOPS = ROOT.parent / "mlhops"


def isolated_env() -> dict[str, str]:
    # Inherited runtime values may point at live services; retain only normal tool env.
    return {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(("MLHOPS_", "PHOGAEM_", "VITE_"))
        and not key.startswith("PG")
        and key not in {"CARGO_TARGET_DIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"}
    }


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def executable(name: str) -> str:
    found = shutil.which(name)
    if not found:
        raise RuntimeError(f"{name} is required on PATH (local PostgreSQL and Rust tools).")
    return found


def secret(path: Path, value: str, *, replace: bool = False) -> None:
    if not replace:
        with open(path, "x", opener=lambda filename, flags: os.open(filename, flags, 0o600)) as stream:
            stream.write(value + "\n")
        return
    # Replace snapshots and the local database endpoint atomically; never follow old symlinks.
    descriptor, filename = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
    temporary = Path(filename)
    try:
        with os.fdopen(descriptor, "w") as stream:
            stream.write(value + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class Stack:
    def __init__(self, reuse_run: Path | None = None) -> None:
        parent = ROOT / ".local" / "dev-mlhops"
        parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.env = isolated_env()
        self.reuse = reuse_run is not None
        self.pg_ctl = executable("pg_ctl")
        if reuse_run is not None:
            candidate = reuse_run.absolute()
            if candidate.is_symlink() or candidate.parent.resolve() != parent.resolve() or not candidate.name.startswith("run-"):
                raise RuntimeError("--reuse-run must be a real run-* directory directly inside .local/dev-mlhops")
            self.work = candidate.resolve(strict=True)
            data = self.work / "postgres"
            if data.is_symlink() or not (data / "PG_VERSION").is_file():
                raise RuntimeError("--reuse-run has no existing PostgreSQL cluster")
            status = subprocess.run([self.pg_ctl, "-D", str(data), "status"], env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False).returncode
            if status != 3:
                raise RuntimeError("--reuse-run requires a stopped cluster; stop only its owning harness first")
        else:
            self.work = Path(tempfile.mkdtemp(prefix="run-", dir=parent))
        self.children: list[subprocess.Popen[bytes]] = []
        self.logs: list[object] = []
        self.pg_started = False
        self.database_file = self.work / "database.url"
        self.admin_base: str | None = None

    def log(self, name: str):
        stream = (self.work / f"{name}.log").open("ab")
        self.logs.append(stream)
        return stream

    def run(self, args: list[str], *, name: str, cwd: Path | None = None) -> None:
        process = subprocess.Popen(args, cwd=cwd, env=self.env, stdout=self.log(name), stderr=subprocess.STDOUT, start_new_session=True)
        self.children.append(process)
        status = process.wait()
        self.children.remove(process)
        if status:
            raise subprocess.CalledProcessError(status, args)

    def database(self) -> None:
        port = free_port()
        if not self.reuse:
            self.run([executable("initdb"), "-D", str(self.work / "postgres"), "-U", "phogaem_dev", "--auth=trust", "--encoding=UTF8", "--no-locale"], name="initdb")
        socket_dir = self.work / "socket"
        socket_dir.mkdir(mode=0o700, exist_ok=True)
        options = f"-h 127.0.0.1 -p {port} -k {socket_dir}"
        self.pg_started = True
        self.run([self.pg_ctl, "-D", str(self.work / "postgres"), "-l", str(self.work / "postgres.log"), "-o", options, "-w", "start"], name="pg-start")
        url = f"postgres://phogaem_dev@127.0.0.1:{port}/postgres"
        secret(self.database_file, url, replace=self.reuse)
        print(f"Disposable database URL file: {self.database_file}", flush=True)

    def spawn(self, binary: str, settings: dict[str, str]) -> subprocess.Popen[bytes]:
        env = {**self.env, **settings}
        process = subprocess.Popen([str(MLHOPS / "target" / "debug" / binary)], cwd=MLHOPS, env=env, stdout=self.log(binary), stderr=subprocess.STDOUT, start_new_session=True)
        self.children.append(process)
        return process

    def wait_http(self, url: str, ready, timeout: float = 30) -> None:
        deadline = time.monotonic() + timeout
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        while time.monotonic() < deadline:
            for process in self.children:
                if process.poll() is not None:
                    raise RuntimeError(f"A stack process exited ({process.returncode}); inspect {self.work}/*.log")
            try:
                with opener.open(url, timeout=1) as response:
                    data = json.load(response)
                    if ready(data):
                        return
            except (OSError, ValueError, urllib.error.URLError):
                pass
            time.sleep(0.1)
        raise RuntimeError(f"Timed out waiting for {url}; inspect {self.work}/*.log")

    def services(self, web_port: int = 5174) -> str:
        self.run([executable("cargo"), "build", "--locked", "-p", "mlhops-core", "-p", "mlhops-gateway", "-p", "mlhops-sidecar-phogaem"], name="cargo-build", cwd=MLHOPS)
        ports: set[int] = set()
        while len(ports) < 5:
            ports.add(free_port())
        core, registry, gateway, sidecar, admin = sorted(ports)
        self.admin_base = f"http://127.0.0.1:{admin}"
        (self.work / "backups").mkdir(mode=0o700, exist_ok=True)
        token = self.work / "registry.token"
        shared = {"MLHOPS_REGISTRY_TOKEN_FILE": str(token), "MLHOPS_DATABASE_URL_FILE": str(self.database_file)}
        self.spawn("mlhops-core", {
            # Optional providers must not read this Mac's production OAuth configuration.
            "HOME": str(self.work),
            **shared, "MLHOPS_CORE_API_ADDR": f"127.0.0.1:{core}",
            "MLHOPS_CORE_REGISTRY_ADDR": f"127.0.0.1:{registry}",
            "MLHOPS_JWT_KEY_FILE": str(self.work / "jwt.key"), "MLHOPS_DATABASE_SCHEMA": "dev_core",
            "MLHOPS_PASSKEY_RP_ID": "localhost", "MLHOPS_PASSKEY_ORIGINS": f"http://localhost:{web_port}",
            "MLHOPS_HEARTBEAT_TTL_SECS": "15",
            "MLHOPS_CORE_ADMIN_ADDR": f"127.0.0.1:{admin}",
            "MLHOPS_BACKUP_DIR": str(self.work / "backups"),
        })
        self.wait_http(f"http://127.0.0.1:{core}/healthz", lambda _data: True)
        self.spawn("mlhops-sidecar-phogaem", {
            **shared, "MLHOPS_PHOGAEM_ADDR": f"127.0.0.1:{sidecar}",
            "MLHOPS_CORE_REGISTRY_URL": f"http://127.0.0.1:{registry}",
            "MLHOPS_DATABASE_SCHEMA": "dev_phogaem", "PHOGAEM_DATA_DIR": str(self.work / "photos"),
            "PHOGAEM_RUNTIME_CONFIG": str(self.work / "runtime.json"),
        })
        self.wait_http(f"http://127.0.0.1:{core}/healthz", lambda data: data.get("operations", 0) >= 8)
        self.spawn("mlhops-gateway", {
            "MLHOPS_GATEWAY_ADDR": f"127.0.0.1:{gateway}", "MLHOPS_CORE_URL": f"http://127.0.0.1:{core}",
            "MLHOPS_ALLOWED_ORIGINS": f"http://127.0.0.1:5173,http://127.0.0.1:{web_port},http://localhost:{web_port}",
            "MLHOPS_MAX_BODY_MB": "20", "MLHOPS_RATE_PER_SEC": "1000", "MLHOPS_RATE_BURST": "1000",
        })
        api = f"http://127.0.0.1:{gateway}"
        self.wait_http(f"{api}/healthz", lambda _data: True)
        secret(self.work / "run.json", json.dumps({"api": api, "admin": self.admin_base, "core": core, "registry": registry, "sidecar": sidecar, "databaseFile": str(self.database_file)}, indent=2), replace=self.reuse)
        print(f"Local gateway: {api}\nLocal approval admin: {self.admin_base}\nVITE_MLHOPS_API_BASE={api}\nLogs and originals: {self.work}", flush=True)
        return api

    def cleanup(self) -> None:
        for process in reversed(self.children):
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        for process in reversed(self.children):
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait(timeout=3)
        if self.pg_started:
            subprocess.run([self.pg_ctl, "-D", str(self.work / "postgres"), "-m", "fast", "-w", "stop"], env=self.env, stdout=self.log("pg-stop"), stderr=subprocess.STDOUT, timeout=15, check=False)
        for stream in self.logs:
            stream.close()
        # Leave only this run's files for diagnosis; no broad cleanup or production paths.
        print(f"Stopped this run's services. Local data retained at {self.work}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--test", action="store_true", help="run shared browser integration tests and stop")
    modes.add_argument("--db-only", action="store_true", help="run only a disposable database for sidecar tests")
    modes.add_argument("--reuse-run", type=Path, help="restart one stopped local preview run without deleting its data")
    args = parser.parse_args()
    try:
        stack = Stack(args.reuse_run)
    except (RuntimeError, OSError) as error:
        print(f"Local integration failed: {error}", file=sys.stderr)
        return 1
    def stop_requested(_signum, _frame):
        raise KeyboardInterrupt()

    signal.signal(signal.SIGTERM, stop_requested)
    try:
        stack.database()
        if args.db_only:
            print("Database ready. Ctrl-C stops this disposable cluster.", flush=True)
            while True:
                time.sleep(1)
        web_port = free_port() if args.test else 5174
        api = stack.services(web_port)
        if args.test:
            env = {**stack.env, "PHOGAEM_INTEGRATION_API_BASE": api, "PHOGAEM_INTEGRATION_ADMIN_BASE": stack.admin_base or "", "VITE_MLHOPS_API_BASE": api, "PHOGAEM_TEST_WEB_PORT": str(web_port)}
            process = subprocess.Popen([executable("npx"), "playwright", "test", "--config", "playwright.shared.config.ts"], cwd=ROOT, env=env, start_new_session=True)
            stack.children.append(process)
            return process.wait()
        print("Start the web app with the VITE_MLHOPS_API_BASE value above. Ctrl-C stops this stack.", flush=True)
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        return 0
    except (RuntimeError, subprocess.SubprocessError, OSError) as error:
        print(f"Local integration failed: {error}", file=sys.stderr)
        return 1
    finally:
        stack.cleanup()


if __name__ == "__main__":
    raise SystemExit(main())
