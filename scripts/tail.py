"""Wait for k6 runner pods, stream their logs, then generate a combined report."""

from sys import argv, exit, stderr
from time import monotonic, sleep

from . import kubectl, report
from .config import Config
from .log import info, success, warning
from .submit import make_testrun_id

DIVIDER = "─" * 60


def wait_for_pod(cfg: Config, timeout: int = 120) -> str:
    """Poll until the runner pod for *cfg.testrun* is Running; return its name.

    Raises TimeoutError if no running pod appears within *timeout* seconds.
    """
    info(f"Waiting for runner pod (k6_cr={cfg.testrun})...")
    deadline = monotonic() + timeout

    while monotonic() < deadline:
        result = kubectl.get(
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
        sleep(2)

    hint = f"  kubectl --context={cfg.context} -n {cfg.namespace} get pods -l k6_cr={cfg.testrun}"
    raise TimeoutError(f"Timed out waiting for runner pod — check:\n{hint}")


def tail_logs(cfg: Config, pod: str) -> None:
    """Stream logs from *pod* to stdout until the container exits."""
    info(f"Tailing logs from '{pod}'...")
    print(DIVIDER)
    kubectl.logs(cfg, pod)
    print(DIVIDER)


def print_status(cfg: Config) -> None:
    """Fetch and display the final stage of the TestRun resource."""
    result = kubectl.get(
        cfg, "get", "testrun", cfg.testrun, "-o", "jsonpath={.status.stage}"
    )
    status = result.stdout.strip() or "unknown"
    if status == "finished":
        success(f"TestRun '{cfg.testrun}' finished")
        return
    warning(f"TestRun '{cfg.testrun}' status: {status}")


def parse_args() -> tuple[str, list[str]]:
    """Return (base_id, scripts) from CLI args or exit with usage."""
    if len(argv) < 3:
        print("Usage: python3 -m scripts.tail <base-id> <scripts>", file=stderr)
        exit(1)
    base_id = argv[1]
    scripts = [s.strip() for s in argv[2].split(",") if s.strip()]
    return base_id, scripts


def main() -> None:
    """Entrypoint: tail each TestRun in order, then generate the combined report."""
    base_id, scripts = parse_args()

    configs: list[Config] = []
    for index, script in enumerate(scripts, start=1):
        testrun = make_testrun_id(base_id, index)
        cfg = Config(testrun=testrun, script_file=script, base_id=base_id, smoke=False)
        configs.append(cfg)
        pod = wait_for_pod(cfg)
        tail_logs(cfg, pod)
        print_status(cfg)

    report.merge(configs)


if __name__ == "__main__":
    main()
