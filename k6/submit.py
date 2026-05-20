import subprocess
import sys
import tempfile
from pathlib import Path
from string import Template

from k6.config import Config
from k6.kubectl import kubectl_run


def validate(cfg: Config) -> None:
    if not cfg.script_path.exists():
        print(f"[✗] Script not found: {cfg.script_path}", file=sys.stderr)
        sys.exit(1)
    if not cfg.scripts_dir.is_dir():
        print(f"[✗] Scripts directory not found: {cfg.scripts_dir}", file=sys.stderr)
        sys.exit(1)
    if not cfg.template_path.exists():
        print(f"[✗] Template not found: {cfg.template_path}", file=sys.stderr)
        sys.exit(1)


def configmap_entries(cfg: Config) -> list[str]:
    entries = [f"load-test.js={cfg.script_path}"]
    for js in sorted(cfg.scripts_dir.glob("*.js")):
        entries.append(f"scripts/{js.name}={js}")
    return entries


def upload_configmap(cfg: Config) -> None:
    print(f"[→] Uploading ConfigMap '{cfg.testrun}'...")
    from_file_args = [arg for entry in configmap_entries(cfg) for arg in ("--from-file", entry)]
    dry_run = subprocess.run(
        [
            "kubectl",
            f"--context={cfg.context}",
            "-n",
            cfg.namespace,
            "create",
            "configmap",
            cfg.testrun,
            *from_file_args,
            "--dry-run=client",
            "-o",
            "yaml",
        ],
        text=True,
        capture_output=True,
        check=True,
    )
    kubectl_run(
        ["kubectl", f"--context={cfg.context}", "apply", "-f", "-"],
        stdin=dry_run.stdout,
    )
    print(f"[✓] ConfigMap '{cfg.testrun}' ready")


def render_manifest(cfg: Config) -> str:
    tmpl = Template(cfg.template_path.read_text())
    return tmpl.substitute(
        testrun=cfg.testrun,
        namespace=cfg.namespace,
        image=cfg.image,
        smoke=str(cfg.smoke).lower(),
        target_rps=cfg.target_rps,
        sustained_duration=cfg.sustained_duration,
        cpf_pool_size=cfg.cpf_pool_size,
        otel_endpoint=cfg.otel_endpoint,
        export_interval=cfg.export_interval,
        flush_interval=cfg.flush_interval,
        arguments=cfg.arguments,
    )


def submit_testrun(cfg: Config) -> None:
    print(f"[→] Submitting TestRun '{cfg.testrun}'...")
    manifest = render_manifest(cfg)
    with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", prefix="k6-testrun-", delete=False) as tmp:
        tmp.write(manifest)
        tmp_path = tmp.name
    try:
        kubectl_run(["kubectl", f"--context={cfg.context}", "apply", "-f", tmp_path])
    finally:
        Path(tmp_path).unlink(missing_ok=True)
    print(f"[✓] TestRun '{cfg.testrun}' submitted")


def parse_args() -> tuple[str, bool]:
    args = sys.argv[1:]
    if not args or args[0].startswith("-"):
        print("Usage: python3 -m k6.submit <testrun-name> [--smoke]", file=sys.stderr)
        sys.exit(1)
    return args[0], "--smoke" in args


def main() -> None:
    testrun, smoke = parse_args()
    cfg = Config(testrun, smoke)
    validate(cfg)
    upload_configmap(cfg)
    submit_testrun(cfg)


if __name__ == "__main__":
    main()
