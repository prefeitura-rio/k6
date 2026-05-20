import os
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).parent.parent.resolve()


@dataclass
class Config:
    testrun: str
    smoke: bool
    context: str = field(  # type: ignore[assignment]
        default_factory=lambda: os.environ.get("K6_CONTEXT", "gke_rj-superapp-staging_us-central1_application")
    )
    namespace: str = field(  # type: ignore[assignment]
        default_factory=lambda: os.environ.get("K6_NAMESPACE", "k6-operator-system")
    )
    image: str = field(  # type: ignore[assignment]
        default_factory=lambda: os.environ.get("K6_IMAGE", "grafana/k6:2.0.0")
    )
    otel_endpoint: str = field(  # type: ignore[assignment]
        default_factory=lambda: os.environ.get("K6_OTEL_ENDPOINT", "signoz-otel-collector.signoz:4317")
    )
    target_rps: str = field(  # type: ignore[assignment]
        default_factory=lambda: os.environ.get("TARGET_RPS", "75")
    )
    sustained_duration: str = field(  # type: ignore[assignment]
        default_factory=lambda: os.environ.get("SUSTAINED_DURATION", "35m")
    )
    cpf_pool_size: str = field(  # type: ignore[assignment]
        default_factory=lambda: os.environ.get("CPF_POOL_SIZE", "7500")
    )
    script_path: Path = field(  # type: ignore[assignment]
        default_factory=lambda: Path(os.environ.get("SCRIPT_PATH", str(HERE / "load-test.js")))
    )
    scripts_dir: Path = field(  # type: ignore[assignment]
        default_factory=lambda: Path(os.environ.get("SCRIPTS_DIR", str(HERE / "scripts")))
    )
    template_path: Path = field(  # type: ignore[assignment]
        default_factory=lambda: Path(os.environ.get("TEMPLATE_PATH", str(HERE / "testrun.yaml.tmpl")))
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
