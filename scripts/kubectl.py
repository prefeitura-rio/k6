"""Thin wrappers around the kubectl CLI for apply, dry-run, get, and log-streaming operations."""

import subprocess
from subprocess import CompletedProcess
from sys import exit, stderr

from .config import Config


def run(args: list[str], input: str | None = None) -> None:
    """Run a kubectl command, printing stdout and exiting on non-zero return code."""
    result = subprocess.run(args, input=input, text=True, capture_output=True)

    if result.stdout:
        print(result.stdout, end="")

    if result.returncode != 0:
        print(result.stderr, file=stderr)
        exit(result.returncode)


def dry_run(args: list[str]) -> str:
    """Append --dry-run=client -o yaml to *args* and return the rendered manifest."""
    result = subprocess.run(
        [*args, "--dry-run=client", "-o", "yaml"],
        text=True,
        capture_output=True,
        check=True,
    )
    return result.stdout


def get(cfg: Config, *args: str) -> CompletedProcess[str]:
    """Run a namespaced kubectl read command and return the completed process for inspection."""
    return subprocess.run(
        ["kubectl", f"--context={cfg.context}", "-n", cfg.namespace, *args],
        text=True,
        capture_output=True,
    )


def logs(cfg: Config, pod: str) -> None:
    """Stream logs from *pod* to the terminal until the container exits."""
    _ = subprocess.run(
        ["kubectl", f"--context={cfg.context}", "-n", cfg.namespace, "logs", "-f", pod],
        text=True,
    )
