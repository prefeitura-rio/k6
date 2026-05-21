import subprocess
from dataclasses import dataclass, field
from os import environ
from pathlib import Path

from .clusters import resolve_context
from .errors import ConfigError

HERE = Path(__file__).parent.parent.resolve()


def testrun_id(base_id: str, script: str) -> str:
    return f"{base_id}--{script.split('--', 1)[1]}"


def _fetch_url_shortener_token(context: str) -> str:
    try:
        result = subprocess.run(
            [
                "kubectl",
                f"--context={context}",
                "get", "authorizationpolicy", "url-shortener-api-auth",
                "-n", "url-shortener",
                "-o", "jsonpath={.spec.rules[0].when[0].values[0]}",
            ],
            capture_output=True,
            text=True,
            check=True,
        )
    except subprocess.CalledProcessError as e:
        raise ConfigError(
            f"Failed to fetch url-shortener token: {e.stderr.strip()}"
        ) from e
    bearer = result.stdout.strip()
    if not bearer:
        raise ConfigError("url-shortener-api-auth policy returned an empty token")
    return bearer.removeprefix("Bearer ").strip()


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
    cpf_pool_size: str = field(default_factory=lambda: environ.get("CPF_POOL_SIZE", "7500"))
    otel_endpoint: str = field(default_factory=lambda: environ.get("K6_OTEL_ENDPOINT", "signoz-otel-collector.signoz:4317"))
    clickhouse_pod: str = field(default_factory=lambda: environ.get("CLICKHOUSE_POD", "chi-signoz-clickhouse-cluster-0-1-0"))
    clickhouse_namespace: str = field(default_factory=lambda: environ.get("CLICKHOUSE_NAMESPACE", "signoz"))
    reports_dir: Path = field(default_factory=lambda: Path(environ.get("REPORTS_DIR", str(HERE / "reports"))))
    url_shortener_api_token: str = field(default_factory=lambda: environ.get("URL_SHORTENER_API_TOKEN", ""))
    context: str = field(init=False)

    def __post_init__(self) -> None:
        self.context = resolve_context(self.prefix, self.env)

    @property
    def prefix(self) -> str:
        """The service prefix extracted from `script_file`, e.g. ``'superapp'``."""
        return self.script_file.split("--")[0]

    def fetch_url_shortener_token(self) -> None:
        """Resolve the url-shortener API token from the cluster if not already set.

        Mutates `url_shortener_api_token` in place. Raises `ConfigError` on failure.
        """
        if not self.url_shortener_api_token:
            self.url_shortener_api_token = _fetch_url_shortener_token(self.context)

    def template_vars(self) -> dict[str, str]:
        return {
            "testrun": self.testrun,
            "namespace": self.namespace,
            "image": self.image,
            "smoke": str(self.smoke).lower(),
            "target_rps": self.target_rps,
            "scenario_count": self.scenario_count,
            "sustained_duration": self.sustained_duration,
            "cpf_pool_size": self.cpf_pool_size,
            "env": self.env,
            "url_shortener_api_token": self.url_shortener_api_token,
            "otel_endpoint": self.otel_endpoint,
            "export_interval": "5s",
            "flush_interval": "5s" if self.smoke else "1s",
            "script_file": f"{self.script_file}.ts",
            "arguments": self._arguments(),
        }

    def _arguments(self) -> str:
        args = f"--out opentelemetry --tag testrun={self.testrun}"
        if self.smoke:
            args += " --no-thresholds"
        return args
