import os
import shutil
import subprocess
from pathlib import Path
from string import Template
from sys import argv, exit, stderr
from tempfile import NamedTemporaryFile, mkdtemp

from .config import Config, HERE, testrun_id
from .errors import ConfigError
from .log import error, info, success

TEMPLATE_PATH = HERE / "files" / "testrun.yaml.tmpl"


def validate(cfg: Config) -> None:
    """Raise `ConfigError` if required files are missing."""
    checks = [
        (cfg.scripts_dir.is_dir(), f"Scripts directory not found: {cfg.scripts_dir}"),
        (TEMPLATE_PATH.exists(), f"Template not found: {TEMPLATE_PATH}"),
        (
            (cfg.scripts_dir / f"{cfg.script_file}.ts").exists(),
            f"Script not found: {cfg.script_file}.ts",
        ),
    ]
    for ok, msg in checks:
        if not ok:
            raise ConfigError(msg)


def upload_configmap(cfg: Config) -> None:
    info(f"Uploading ConfigMap '{cfg.testrun}'...")
    stage = Path(mkdtemp(prefix="k6-configmap-"))
    try:
        # Copy every .ts file — lib.ts must travel with the script files so
        # imports resolve inside the runner pod.
        for ts in cfg.scripts_dir.glob("*.ts"):
            shutil.copy(ts, stage / ts.name)
        dry = subprocess.run(
            [
                "kubectl", f"--context={cfg.context}",
                "-n", cfg.namespace,
                "create", "configmap", cfg.testrun,
                f"--from-file={stage}",
                "--dry-run=client", "-o", "yaml",
            ],
            text=True,
            capture_output=True,
            check=True,
        )
        apply = subprocess.run(
            ["kubectl", f"--context={cfg.context}", "apply", "-f", "-"],
            input=dry.stdout,
            text=True,
            capture_output=True,
        )
        if apply.stdout:
            print(apply.stdout, end="")
        if apply.returncode != 0:
            raise ConfigError(f"kubectl apply (configmap) failed:\n{apply.stderr.strip()}")
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    success(f"ConfigMap '{cfg.testrun}' ready")


def render_manifest(cfg: Config) -> str:
    tmpl = Template(TEMPLATE_PATH.read_text())
    return tmpl.substitute(cfg.template_vars())


def submit_testrun(cfg: Config) -> None:
    info(f"Submitting TestRun '{cfg.testrun}'...")
    with NamedTemporaryFile(mode="w", suffix=".yaml", prefix="k6-testrun-", delete=False) as tmp:
        tmp.write(render_manifest(cfg))
        tmp_path = tmp.name
    try:
        result = subprocess.run(
            ["kubectl", f"--context={cfg.context}", "apply", "-f", tmp_path],
            text=True,
            capture_output=True,
        )
        if result.stdout:
            print(result.stdout, end="")
        if result.returncode != 0:
            raise ConfigError(f"kubectl apply (testrun) failed:\n{result.stderr.strip()}")
    finally:
        Path(tmp_path).unlink(missing_ok=True)
    success(f"TestRun '{cfg.testrun}' submitted")


def main() -> None:
    args = argv[1:]
    if len(args) < 2:
        print("Usage: python3 -m scripts.submit <base-id> <script> [<script> ...]", file=stderr)
        exit(1)

    base_id = args[0]
    scripts = args[1:]
    smoke = os.environ.get("SMOKE", "false").lower() == "true"

    try:
        for script in scripts:
            cfg = Config(testrun=testrun_id(base_id, script), script_file=script, smoke=smoke)
            validate(cfg)
            upload_configmap(cfg)
            submit_testrun(cfg)
    except ConfigError as e:
        error(str(e))
        exit(1)


if __name__ == "__main__":
    main()
