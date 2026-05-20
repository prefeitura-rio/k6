"""Runtime configuration resolved from environment variables with sensible defaults."""

from dataclasses import dataclass, field
from os import environ
from pathlib import Path

from .clusters import resolve_context

HERE = Path(__file__).parent.parent.resolve()

UNIT_LABELS: dict[str, tuple[str, str]] = {
    "h": ("hora", "horas"),
    "m": ("minuto", "minutos"),
    "s": ("segundo", "segundos"),
}


def duration_label(raw: str) -> str:
    """Convert a k6 duration string (e.g. '35m', '1h30m') to Portuguese prose.

    Only handles the unit suffixes h, m, s in sequence — no regex required.
    Falls back to the raw string if the format is unrecognised.
    """
    rest = raw.strip()
    segments: list[str] = []
    for unit in ("h", "m", "s"):
        before, found, after = rest.partition(unit)
        if not found:
            continue
        if not before.isdigit():
            return raw
        n = int(before)
        singular, plural = UNIT_LABELS[unit]
        segments.append(f"{n} {singular if n == 1 else plural}")
        rest = after
    if not segments or rest:
        return raw
    return ", ".join(segments)


def prefix_from_script(script: str) -> str:
    """Extract the prefix from a script name like 'superapp--busca' → 'superapp'."""
    return script.split("--")[0]


@dataclass
class Config:
    """All runtime parameters for a k6 test run, sourced from env vars or explicit overrides."""

    smoke: bool
    testrun: str
    script_file: str
    base_id: str
    export_interval: str = "5s"
    cpf_pool_size: str = field(
        default_factory=lambda: environ.get("CPF_POOL_SIZE", "7500")
    )
    image: str = field(
        default_factory=lambda: environ.get("K6_IMAGE", "grafana/k6:2.0.0")
    )
    namespace: str = field(
        default_factory=lambda: environ.get("K6_NAMESPACE", "k6-operator-system")
    )
    scripts_dir: Path = field(
        default_factory=lambda: Path(environ.get("SCRIPTS_DIR", str(HERE / "k6")))
    )
    sustained_duration: str = field(
        default_factory=lambda: environ.get("SUSTAINED_DURATION", "35m")
    )
    target_rps: str = field(default_factory=lambda: environ.get("TARGET_RPS", "75"))
    otel_endpoint: str = field(
        default_factory=lambda: environ.get(
            "K6_OTEL_ENDPOINT", "signoz-otel-collector.signoz:4317"
        )
    )
    clickhouse_pod: str = field(
        default_factory=lambda: environ.get(
            "CLICKHOUSE_POD", "chi-signoz-clickhouse-cluster-0-1-0"
        )
    )
    clickhouse_namespace: str = field(
        default_factory=lambda: environ.get("CLICKHOUSE_NAMESPACE", "signoz")
    )
    reports_dir: Path = field(
        default_factory=lambda: Path(environ.get("REPORTS_DIR", str(HERE / "reports")))
    )
    env: str = field(default_factory=lambda: environ.get("ENV", "staging"))
    template_path: Path = field(
        default_factory=lambda: Path(
            environ.get("TEMPLATE_PATH", str(HERE / "files" / "testrun.yaml.tmpl"))
        )
    )

    prefix: str = field(init=False)
    context: str = field(init=False)

    def __post_init__(self) -> None:
        self.prefix = prefix_from_script(self.script_file)
        self.context = resolve_context(self.prefix, self.env)

    @property
    def env_label(self) -> str:
        """Human-readable environment label, e.g. 'superapp / prod'."""
        return f"{self.prefix} / {self.env}"

    @property
    def sustained_duration_label(self) -> str:
        """Human-readable sustained duration, e.g. '35 minutos'."""
        return duration_label(self.sustained_duration)

    @property
    def flush_interval(self) -> str:
        """OTEL flush interval: relaxed for smoke runs, tight for load runs."""
        return "5s" if self.smoke else "1s"

    @property
    def arguments(self) -> str:
        """Extra CLI arguments forwarded to the k6 binary inside the operator pod."""
        args = f"--out opentelemetry --tag testrun={self.testrun}"
        if self.smoke:
            args += " --no-thresholds"
        return args
