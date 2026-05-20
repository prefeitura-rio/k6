import subprocess
import sys
import time

from k6.config import Config
from k6.kubectl import kubectl_get

INFO = "\033[36m[→]\033[0m"
SUCCESS = "\033[32m[✓]\033[0m"
ERROR = "\033[31m[✗]\033[0m"
WARNING = "\033[33m[⚠]\033[0m"
DIVIDER = "─" * 60


def wait_for_pod(cfg: Config, timeout: int = 120) -> str:
    print(f"{INFO} Waiting for runner pod (k6_cr={cfg.testrun})...")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = kubectl_get(
            cfg,
            "get",
            "pods",
            "-l",
            f"k6_cr={cfg.testrun}",
            "--field-selector=status.phase=Running",
            "-o",
            "jsonpath={.items[0].metadata.name}",
        )
        pod = result.stdout.strip()
        if pod:
            return pod
        time.sleep(2)
    print(f"{ERROR} Timed out waiting for runner pod", file=sys.stderr)
    print(
        f"  kubectl --context={cfg.context} -n {cfg.namespace} get pods -l k6_cr={cfg.testrun}",
        file=sys.stderr,
    )
    sys.exit(1)


def tail_logs(cfg: Config, pod: str) -> None:
    print(f"{INFO} Tailing logs from '{pod}'...")
    print(DIVIDER)
    subprocess.run(["kubectl", f"--context={cfg.context}", "-n", cfg.namespace, "logs", "-f", pod])
    print(DIVIDER)


def print_status(cfg: Config) -> None:
    result = kubectl_get(
        cfg,
        "get",
        "testrun",
        cfg.testrun,
        "-o",
        "jsonpath={.status.stage}",
    )
    status = result.stdout.strip() or "unknown"
    if status == "finished":
        print(f"{SUCCESS} TestRun '{cfg.testrun}' finished")
    else:
        print(f"{WARNING} TestRun '{cfg.testrun}' status: {status}")


def parse_args() -> str:
    if len(sys.argv) < 2:
        print("Usage: python3 -m k6.tail <testrun-name>", file=sys.stderr)
        sys.exit(1)
    return sys.argv[1]


def main() -> None:
    testrun = parse_args()
    cfg = Config(testrun, smoke=False)
    pod = wait_for_pod(cfg)
    tail_logs(cfg, pod)
    print_status(cfg)


if __name__ == "__main__":
    main()
