import os
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).parent.parent.resolve()


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
    scripts_dir: Path
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
            scripts_dir=Path(os.environ.get("SCRIPTS_DIR", HERE / "scripts")),
            template_path=Path(
                os.environ.get("TEMPLATE_PATH", HERE / "testrun.yaml.tmpl")
            ),
        )

    @property
    def export_interval(self) -> str:
        return "5s"

    @property
    def flush_interval(self) -> str:
        return "5s" if self.smoke else "1s"

    @property
    def arguments(self) -> str:
        args = f"--out opentelemetry --tag testrun={self.testrun}"
        if self.smoke:
            args += " --no-thresholds"
        return args
