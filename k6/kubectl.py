import subprocess
import sys

from k6.config import Config


def run(args: list[str], input: str | None = None) -> None:
    result = subprocess.run(args, input=input, text=True, capture_output=True)
    if result.stdout:
        print(result.stdout, end="")
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        sys.exit(result.returncode)


def kubectl(cfg: Config, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["kubectl", f"--context={cfg.context}", "-n", cfg.namespace, *args],
        text=True,
        capture_output=True,
    )
