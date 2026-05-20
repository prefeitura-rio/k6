"""CLI entrypoint that uploads the k6 ConfigMap and submits a TestRun custom resource."""

import shutil
from pathlib import Path
from string import Template
from sys import argv, exit, stderr
from tempfile import NamedTemporaryFile, mkdtemp

from . import kubectl
from .config import Config
from .log import error, info, success


def validate(cfg: Config) -> str | None:
    """Return the first validation error message, or None if the config is valid."""
    checks = [
        (cfg.scripts_dir.is_dir(), f"Scripts directory not found: {cfg.scripts_dir}"),
        (cfg.template_path.exists(), f"Template not found: {cfg.template_path}"),
        (
            (cfg.scripts_dir / f"{cfg.script_file}.ts").exists(),
            f"Script not found: {cfg.script_file}.ts",
        ),
    ]
    return next((msg for ok, msg in checks if not ok), None)


def upload_configmap(cfg: Config) -> None:
    """Stage all scripts into a flat temp dir and upload as a ConfigMap."""
    info(f"Uploading ConfigMap '{cfg.testrun}'...")
    stage = Path(mkdtemp(prefix="k6-configmap-"))
    try:
        for ts in cfg.scripts_dir.glob("*.ts"):
            _ = shutil.copy(ts, stage / ts.name)
        manifest = kubectl.dry_run(
            [
                "kubectl",
                f"--context={cfg.context}",
                "-n",
                cfg.namespace,
                "create",
                "configmap",
                cfg.testrun,
                f"--from-file={stage}",
            ]
        )
        kubectl.run(
            ["kubectl", f"--context={cfg.context}", "apply", "-f", "-"], input=manifest
        )
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    success(f"ConfigMap '{cfg.testrun}' ready")


def render_manifest(cfg: Config) -> str:
    """Render the TestRun YAML template with values from *cfg*."""
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
        script_file=f"{cfg.script_file}.ts",
    )


def submit_testrun(cfg: Config) -> None:
    """Write the rendered TestRun manifest to a temp file and apply it to the cluster."""
    info(f"Submitting TestRun '{cfg.testrun}'...")
    with NamedTemporaryFile(
        mode="w", suffix=".yaml", prefix="k6-testrun-", delete=False
    ) as tmp:
        _ = tmp.write(render_manifest(cfg))
        tmp_path = tmp.name
    try:
        kubectl.run(["kubectl", f"--context={cfg.context}", "apply", "-f", tmp_path])
    finally:
        Path(tmp_path).unlink(missing_ok=True)
    success(f"TestRun '{cfg.testrun}' submitted")


def make_testrun_id(base_id: str, index: int) -> str:
    """Build a unique TestRun name by appending a zero-padded index to the base ID."""
    return f"{base_id}--{index:02d}"


def parse_args() -> tuple[str, list[str], bool]:
    """Parse CLI args and return (base_id, scripts, smoke_flag) or exit with usage."""
    args = argv[1:]
    if len(args) < 2 or args[0].startswith("-"):
        print(
            "Usage: python3 -m scripts.submit <base-id> <scripts> [--smoke]",
            file=stderr,
        )
        exit(1)
    base_id = args[0]
    scripts = [s.strip() for s in args[1].split(",") if s.strip()]
    smoke = "--smoke" in args
    return base_id, scripts, smoke


def main() -> None:
    """Entrypoint: validate config, upload ConfigMap, and submit one TestRun per script."""
    base_id, scripts, smoke = parse_args()

    for index, script in enumerate(scripts, start=1):
        testrun = make_testrun_id(base_id, index)
        cfg = Config(testrun=testrun, script_file=script, base_id=base_id, smoke=smoke)

        if err := validate(cfg):
            error(err)
            exit(1)

        upload_configmap(cfg)
        submit_testrun(cfg)


if __name__ == "__main__":
    main()
