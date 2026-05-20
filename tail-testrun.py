#!/usr/bin/env python3
"""
tail-testrun.py — Wait for a k6 runner pod and tail its logs.

Usage:
    python3 tail-testrun.py <testrun-name>

Environment variables (all optional):
    K6_CONTEXT    kubectl context  (default: gke_rj-superapp-staging_us-central1_application)
    K6_NAMESPACE  k8s namespace    (default: k6-operator-system)
"""

import os
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

INFO    = "\033[36m[→]\033[0m"
SUCCESS = "\033[32m[✓]\033[0m"
ERROR   = "\033[31m[✗]\033[0m"
WARNING = "\033[33m[⚠]\033[0m"
DIVIDER = "─" * 60


@dataclass
class Config:
    testrun: str
    context: str
    namespace: str

    @classmethod
    def from_env(cls, testrun: str) -> "Config":
        return cls(
            testrun=testrun,
            context=os.environ.get(
                "K6_CONTEXT",
                "gke_rj-superapp-staging_us-central1_application",
            ),
            namespace=os.environ.get("K6_NAMESPACE", "k6-operator-system"),
        )


def kubectl(cfg: Config, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["kubectl", f"--context={cfg.context}", "-n", cfg.namespace, *args],
        text=True,
        capture_output=True,
    )


def wait_for_pod(cfg: Config, timeout: int = 120) -> str:
    print(f"{INFO} Waiting for runner pod (k6_cr={cfg.testrun})...")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = kubectl(
            cfg,
            "get", "pods",
            "-l", f"k6_cr={cfg.testrun}",
            "--field-selector=status.phase=Running",
            "-o", "jsonpath={.items[0].metadata.name}",
        )
        pod = result.stdout.strip()
        if pod:
            return pod
        time.sleep(2)

    print(f"{ERROR} Timed out waiting for runner pod", file=sys.stderr)
    print(
        f"  kubectl --context={cfg.context} -n {cfg.namespace}"
        f" get pods -l k6_cr={cfg.testrun}",
        file=sys.stderr,
    )
    sys.exit(1)


def tail_logs(cfg: Config, pod: str) -> None:
    print(f"{INFO} Tailing logs from '{pod}'...")
    print(DIVIDER)
    subprocess.run(
        [
            "kubectl",
            f"--context={cfg.context}",
            "-n", cfg.namespace,
            "logs", "-f", pod,
        ]
    )
    print(DIVIDER)


def print_status(cfg: Config) -> None:
    result = kubectl(
        cfg,
        "get", "testrun", cfg.testrun,
        "-o", "jsonpath={.status.stage}",
    )
    status = result.stdout.strip() or "unknown"

    if status == "finished":
        print(f"{SUCCESS} TestRun '{cfg.testrun}' finished")
    else:
        print(f"{WARNING} TestRun '{cfg.testrun}' status: {status}")


def print_signoz_hint(cfg: Config) -> None:
    print()
    print(f"{INFO} View results in SigNoz:")
    print("  just signoz")
    print("  → http://localhost:8080  (Metrics → Explorer → k6_*)")
    print(f"  → attribute: testrun={cfg.testrun}")


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        sys.exit(1)

    cfg = Config.from_env(testrun=sys.argv[1])
    pod = wait_for_pod(cfg)
    tail_logs(cfg, pod)
    print_status(cfg)
    print_signoz_hint(cfg)


if __name__ == "__main__":
    main()
