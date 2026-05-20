import subprocess
import sys

from k6.config import Config


def kubectl_run(args: list[str], stdin: str | None = None) -> None:
    result = subprocess.run(args, input=stdin, text=True, capture_output=True)
    if result.stdout:
        print(result.stdout, end="")
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        sys.exit(result.returncode)


def kubectl_get(cfg: Config, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["kubectl", f"--context={cfg.context}", "-n", cfg.namespace, *args],
        text=True,
        capture_output=True,
    )
