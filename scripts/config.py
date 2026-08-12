import json
from dataclasses import dataclass, field
from os import environ
from pathlib import Path

from .errors import ConfigError

HERE = Path(__file__).parent.parent.resolve()


def testrun_id(base_id: str, script: str) -> str:
    return f"{base_id}--{script.split('--', 1)[1]}"


def _render_extra_env(extra: dict[str, str]) -> str:
    """Render plain key/value pairs as k8s env entries."""
    return "\n".join(
        f'      - name: {k}\n        value: "{v}"'
        for k, v in extra.items()
    )


def _render_secret_env(secrets: dict[str, dict[str, str]]) -> str:
    """Render secret references as k8s secretKeyRef env entries."""
    lines: list[str] = []
    for name, ref in secrets.items():
        if "secret" not in ref or "key" not in ref:
            raise ConfigError(
                f"K6_SECRET_ENV entry '{name}' must have 'secret' and 'key' fields"
            )
        lines.append(
            f"      - name: {name}\n"
            f"        valueFrom:\n"
            f"          secretKeyRef:\n"
            f"            name: {ref['secret']}\n"
            f"            key: {ref['key']}"
        )
    return "\n".join(lines)


@dataclass
class Config:
    smoke: bool
    testrun: str
    script_file: str
    env: str = field(default_factory=lambda: environ.get("ENV", "staging"))
    image: str = field(default_factory=lambda: environ.get("K6_IMAGE", "grafana/k6:2.0.0"))
    namespace: str = field(default_factory=lambda: environ.get("K6_NAMESPACE", "k6-operator-system"))
    scripts_dir: Path = field(default_factory=lambda: Path(environ.get("SCRIPTS_DIR", str(HERE / "k6"))))
    target_rps: str = field(default_factory=lambda: environ.get("TARGET_RPS", "75"))
    scenario_count: str = field(default_factory=lambda: environ.get("SCENARIO_COUNT", "5"))
    sustained_duration: str = field(default_factory=lambda: environ.get("SUSTAINED_DURATION", "35m"))
    otel_endpoint: str = field(default_factory=lambda: environ.get("K6_OTEL_ENDPOINT", "signoz-otel-collector.signoz:4317"))
    clickhouse_pod: str = field(default_factory=lambda: environ.get("CLICKHOUSE_POD", "chi-signoz-clickhouse-cluster-0-1-0"))
    clickhouse_namespace: str = field(default_factory=lambda: environ.get("CLICKHOUSE_NAMESPACE", "signoz"))
    reports_dir: Path = field(default_factory=lambda: Path(environ.get("REPORTS_DIR", str(HERE / "reports"))))
    extra_env: dict[str, str] = field(
        default_factory=lambda: json.loads(environ.get("K6_EXTRA_ENV", "{}"))
    )
    secret_env: dict[str, dict[str, str]] = field(
        default_factory=lambda: json.loads(environ.get("K6_SECRET_ENV", "{}"))
    )
    context: str = field(default_factory=lambda: environ.get("KUBE_CONTEXT", ""))

    def __post_init__(self) -> None:
        if not self.context:
            raise ConfigError("KUBE_CONTEXT is not set")

    @property
    def prefix(self) -> str:
        """The service prefix extracted from `script_file`, e.g. ``'superapp'``."""
        return self.script_file.split("--")[0]

    def template_vars(self) -> dict[str, str]:
        return {
            "testrun": self.testrun,
            "namespace": self.namespace,
            "image": self.image,
            "smoke": str(self.smoke).lower(),
            "target_rps": self.target_rps,
            "scenario_count": self.scenario_count,
            "sustained_duration": self.sustained_duration,
            "env": self.env,
            "otel_service_name": self.prefix,
            "otel_endpoint": self.otel_endpoint,
            "export_interval": "5s",
            "flush_interval": "5s" if self.smoke else "1s",
            "script_file": f"{self.script_file}.ts",
            "arguments": self._arguments(),
            "extra_env": _render_extra_env(self.extra_env),
            "secret_env": _render_secret_env(self.secret_env),
        }

    def _arguments(self) -> str:
        args = f"--out opentelemetry --tag testrun={self.testrun}"
        if self.smoke:
            args += " --no-thresholds"
        return args
