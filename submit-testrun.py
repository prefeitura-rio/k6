#!/usr/bin/env python3
"""
submit-testrun.py — Upload a k6 script as a ConfigMap and submit a TestRun CR.

Usage:
    python3 submit-testrun.py <testrun-name> [--smoke]

Arguments:
    testrun-name    Unique name for the TestRun and ConfigMap (e.g. load-test-20260519-120000)
    --smoke         Run in smoke mode: 1 VU x 1 iteration per scenario

Environment variables (all optional):
    K6_CONTEXT        kubectl context   (default: gke_rj-superapp-staging_us-central1_application)
    K6_NAMESPACE      k8s namespace     (default: k6-operator-system)
    K6_IMAGE          k6 runner image   (default: grafana/k6:2.0.0)
    K6_OTEL_ENDPOINT  OTEL gRPC host    (default: signoz-otel-collector.signoz:4317)
    TARGET_RPS        target requests/s total (default: 75)
    SUSTAINED_DURATION  how long to hold peak load (default: 35m)
    CPF_POOL_SIZE     unique CPFs to pre-generate (default: 7500)
    SCRIPT_PATH       path to load-test.js (default: load-test.js next to this script)
    TEMPLATE_PATH     path to testrun.yaml.tmpl (default: testrun.yaml.tmpl next to this script)
"""

import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from string import Template

HERE = Path(__file__).parent.resolve()


@dataclass
class Config:
    testrun: str
    smoke: bool
    context: str
    namespace: str
    image: str
    otel_endpoint: str
    target_rps: str
    sustained_duration: str
    cpf_pool_size: str
    script_path: Path
    template_path: Path

    @classmethod
    def from_env(cls, testrun: str, smoke: bool) -> "Config":
        return cls(
            testrun=testrun,
            smoke=smoke,
            context=os.environ.get(
                "K6_CONTEXT",
                "gke_rj-superapp-staging_us-central1_application",
            ),
            namespace=os.environ.get("K6_NAMESPACE", "k6-operator-system"),
            image=os.environ.get("K6_IMAGE", "grafana/k6:2.0.0"),
            otel_endpoint=os.environ.get(
                "K6_OTEL_ENDPOINT",
                "signoz-otel-collector.signoz:4317",
            ),
            target_rps=os.environ.get("TARGET_RPS", "75"),
            sustained_duration=os.environ.get("SUSTAINED_DURATION", "35m"),
            cpf_pool_size=os.environ.get("CPF_POOL_SIZE", "7500"),
            script_path=Path(os.environ.get("SCRIPT_PATH", HERE / "load-test.js")),
            template_path=Path(
                os.environ.get("TEMPLATE_PATH", HERE / "testrun.yaml.tmpl")
            ),
        )

    @property
    def export_interval(self) -> str:
        return "5s"

    @property
    def flush_interval(self) -> str:
        # Smoke tests finish in ~2s — use a longer flush so metrics are sent
        # before the process exits. Full runs keep 1s for live dashboards.
        return "5s" if self.smoke else "1s"

    @property
    def arguments(self) -> str:
        args = f"--out opentelemetry --tag testrun={self.testrun}"
        if self.smoke:
            # Skip threshold evaluation — smoke only checks the pipeline works.
            args += " --no-thresholds"
        return args


def run(args: list[str], input: str | None = None) -> None:
    result = subprocess.run(
        args,
        input=input,
        text=True,
        capture_output=True,
    )
    if result.stdout:
        print(result.stdout, end="")
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        sys.exit(result.returncode)


def upload_configmap(cfg: Config) -> None:
    print(f"[→] Uploading ConfigMap '{cfg.testrun}'...")

    dry_run = subprocess.run(
        [
            "kubectl",
            f"--context={cfg.context}",
            "-n",
            cfg.namespace,
            "create",
            "configmap",
            cfg.testrun,
            f"--from-file=load-test.js={cfg.script_path}",
            "--dry-run=client",
            "-o",
            "yaml",
        ],
        text=True,
        capture_output=True,
        check=True,
    )

    run(
        ["kubectl", f"--context={cfg.context}", "apply", "-f", "-"],
        input=dry_run.stdout,
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

    with tempfile.NamedTemporaryFile(
        mode="w",
        suffix=".yaml",
        prefix="k6-testrun-",
        delete=False,
    ) as f:
        _ = f.write(manifest)
        tmp_path = f.name

    try:
        run(["kubectl", f"--context={cfg.context}", "apply", "-f", tmp_path])
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    print(f"[✓] TestRun '{cfg.testrun}' submitted")


def validate(cfg: Config) -> None:
    if not cfg.script_path.exists():
        print(f"[✗] Script not found: {cfg.script_path}", file=sys.stderr)
        sys.exit(1)
    if not cfg.template_path.exists():
        print(f"[✗] Template not found: {cfg.template_path}", file=sys.stderr)
        sys.exit(1)


def parse_args() -> tuple[str, bool]:
    args = sys.argv[1:]
    if not args or args[0].startswith("-"):
        print(__doc__, file=sys.stderr)
        sys.exit(1)
    testrun = args[0]
    smoke = "--smoke" in args
    return testrun, smoke


def main() -> None:
    testrun, smoke = parse_args()
    cfg = Config.from_env(testrun, smoke)
    validate(cfg)
    upload_configmap(cfg)
    submit_testrun(cfg)


if __name__ == "__main__":
    main()
