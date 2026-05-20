"""Generate a markdown load test report from ClickHouse metrics."""

import json
import shutil
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from sys import argv, exit, stderr
from typing import TypedDict, cast

import yaml
from jinja2 import Environment, FileSystemLoader

from .config import Config
from .log import info, success, warning

HERE = Path(__file__).parent.parent.resolve()
METRICS_FILE = HERE / "files" / "metrics.yaml"
PROMPT_FILE = HERE / "files" / "report-prompt.txt"
TEMPLATE_FILE = "report.md.j2"
COMBINED_TEMPLATE_FILE = "combined.md.j2"

SCENARIO_LABELS: dict[str, str] = {
    "busca": "Busca",
    "go_api": "Empregabilidade (Go API)",
    "heimdall": "Autenticação (Heimdall)",
    "rmi": "Cadastro do Cidadão (RMI)",
    "url_shortener": "Encurtador de URL",
}

SCENARIOS = list(SCENARIO_LABELS.keys())

COLUMN_TYPES: dict[str, type] = {"str": str, "int": int, "float": float}

MONTHS = [
    "janeiro",
    "fevereiro",
    "março",
    "abril",
    "maio",
    "junho",
    "julho",
    "agosto",
    "setembro",
    "outubro",
    "novembro",
    "dezembro",
]

Row = dict[str, str | int | float]


class QueryDefRaw(TypedDict):
    sql: str
    group_by: str | None
    columns: dict[str, str]


class MetricsFileRaw(TypedDict):
    queries: dict[str, QueryDefRaw]


@dataclass
class QueryDef:
    name: str
    sql: str
    group_by: str | None
    columns: dict[str, type]


@dataclass
class ScenarioMetrics:
    scenario: str
    total_reqs: int
    avg_ms: float
    max_ms: float
    pct_25ms: float
    pct_100ms: float
    pct_500ms: float
    pct_1s: float

    @property
    def label(self) -> str:
        return SCENARIO_LABELS[self.scenario]


def validate_query_entry(name: str, entry: QueryDefRaw) -> None:
    """Raise ValueError if a query entry is missing required keys or has unknown column types."""
    for key in ("sql", "columns"):
        if key not in entry:
            raise ValueError(f"Query '{name}' is missing required key '{key}'")
    unknown = [typ for typ in entry["columns"].values() if typ not in COLUMN_TYPES]
    if unknown:
        raise ValueError(
            f"Query '{name}' has unknown column types: {', '.join(unknown)}"
        )


def load_queries(path: Path) -> dict[str, QueryDef]:
    """Load and validate query definitions from *path*; raise ValueError on schema errors."""
    raw = cast(MetricsFileRaw, yaml.safe_load(path.read_text()))
    if "queries" not in raw:
        raise ValueError(f"'{path}' is missing top-level 'queries' key")
    queries: dict[str, QueryDef] = {}
    for name, entry in raw["queries"].items():
        validate_query_entry(name, entry)
        columns = {col: COLUMN_TYPES[typ] for col, typ in entry["columns"].items()}
        queries[name] = QueryDef(
            name=name,
            sql=entry["sql"].strip(),
            group_by=entry.get("group_by"),
            columns=columns,
        )
    return queries


def coerce_row(row: Row, columns: dict[str, type]) -> Row:
    """Cast each column value to its declared type."""
    return {k: columns[k](v) if k in columns else v for k, v in row.items()}


def run_query(cfg: Config, qdef: QueryDef, testrun: str) -> list[Row]:
    """Execute a ClickHouse query via kubectl exec and return parsed JSON rows."""
    sql = qdef.sql.format(testrun=testrun)
    result = subprocess.run(
        [
            "kubectl",
            f"--context={cfg.context}",
            "-n",
            cfg.clickhouse_namespace,
            "exec",
            cfg.clickhouse_pod,
            "--",
            "clickhouse-client",
            "--query",
            sql,
        ],
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        warning(result.stderr.strip())
        return []
    rows: list[Row] = [
        json.loads(line) for line in result.stdout.strip().splitlines() if line
    ]
    return [coerce_row(row, qdef.columns) for row in rows]


def index_by(rows: list[Row], key: str | None) -> dict[str, Row]:
    """Index *rows* by the value of *key*, skipping rows where *key* is absent."""
    if not key:
        return {}
    return {str(row[key]): row for row in rows if row.get(key)}


def build_scenario_metrics(
    scenario: str, totals: dict[str, Row], distributions: dict[str, Row]
) -> ScenarioMetrics | None:
    """Assemble a ScenarioMetrics for *scenario*; return None if totals data is missing."""
    t = totals.get(scenario, {})
    d = distributions.get(scenario, {})
    if not t:
        return None
    return ScenarioMetrics(
        scenario=scenario,
        total_reqs=int(t.get("total_reqs", 0)),
        avg_ms=float(t.get("avg_ms", 0.0)),
        max_ms=float(t.get("max_ms", 0.0)),
        pct_25ms=float(d.get("pct_25ms", 0.0)),
        pct_100ms=float(d.get("pct_100ms", 0.0)),
        pct_500ms=float(d.get("pct_500ms", 0.0)),
        pct_1s=float(d.get("pct_1s", 0.0)),
    )


def fetch_metrics(
    cfg: Config, queries: dict[str, QueryDef]
) -> tuple[list[ScenarioMetrics], Row]:
    """Run all three ClickHouse queries and return per-scenario metrics and the time window."""
    totals = index_by(
        run_query(cfg, queries["totals"], cfg.testrun), queries["totals"].group_by
    )
    distributions = index_by(
        run_query(cfg, queries["distribution"], cfg.testrun),
        queries["distribution"].group_by,
    )
    windows = run_query(cfg, queries["window"], cfg.testrun)
    window: Row = windows[0] if windows else {}
    metrics = [
        m
        for scenario in SCENARIOS
        if (m := build_scenario_metrics(scenario, totals, distributions)) is not None
    ]
    return metrics, window


def interpret(cfg: Config, metrics: list[ScenarioMetrics], window: Row) -> str | None:
    """Call opencode to generate a dissertation paragraph; return None on failure."""
    lines = [
        f"Identificador: {cfg.testrun}",
        f"Ambiente: {cfg.env_label}",
        f"Início: {window.get('started_at', '—')} UTC",
        f"Término: {window.get('ended_at', '—')} UTC",
        f"Duração: {window.get('elapsed_min', '—')} minutos",
        f"Meta de RPS: {cfg.target_rps} req/s",
        f"Total de requisições: {sum(m.total_reqs for m in metrics):,}",
        "",
        "Resultados por serviço:",
        *[
            f"  {m.label}: {m.total_reqs:,} reqs, avg {m.avg_ms:.0f}ms, max {m.max_ms:.0f}ms, <25ms={m.pct_25ms}%, <100ms={m.pct_100ms}%, <500ms={m.pct_500ms}%, <1s={m.pct_1s}%"
            for m in metrics
        ],
    ]
    prompt = PROMPT_FILE.read_text().format(data="\n".join(lines))
    result = subprocess.run(["opencode", "run", prompt], text=True, capture_output=True)
    if result.returncode != 0:
        warning("opencode failed — skipping interpretation")
        return None
    return result.stdout.strip() or None


def render(
    cfg: Config,
    metrics: list[ScenarioMetrics],
    window: Row,
    interpretation: str | None = None,
) -> str:
    """Render the Jinja2 template with fetched metrics and return the markdown string."""
    now = datetime.now(timezone.utc)
    date_str = f"{now.day} de {MONTHS[now.month - 1]} de {now.year}"
    env = Environment(
        loader=FileSystemLoader(str(HERE / "files")), keep_trailing_newline=True
    )
    return env.get_template(TEMPLATE_FILE).render(
        date=date_str,
        testrun=cfg.testrun,
        script_file=cfg.script_file,
        env_label=cfg.env_label,
        started_at=window.get("started_at", "—"),
        ended_at=window.get("ended_at", "—"),
        elapsed_min=window.get("elapsed_min", "—"),
        target_rps=cfg.target_rps,
        sustained_duration_label=cfg.sustained_duration_label,
        cpf_pool_size=cfg.cpf_pool_size,
        metrics=metrics,
        total_reqs=sum(m.total_reqs for m in metrics),
        interpretation=interpretation,
    )


def format_report(path: Path) -> None:
    """Run prettier on *path* in-place; warn and skip if prettier is not available."""
    if not shutil.which("prettier"):
        warning("prettier not found — report not formatted")
        return
    _ = subprocess.run(["prettier", "--write", str(path)], check=True)


def parts_dir(cfg: Config) -> Path:
    """Return the _parts/ subdirectory under reports_dir for a given base_id."""
    return cfg.reports_dir / "_parts" / cfg.base_id


def generate(cfg: Config, skip_interpretation: bool = False) -> Path | None:
    """Generate a per-script report in _parts/<base_id>/; return the path or None on failure."""
    info(
        f"Generating report for '{cfg.testrun}' ({cfg.script_file}) via {cfg.context}..."
    )
    queries = load_queries(METRICS_FILE)
    metrics, window = fetch_metrics(cfg, queries)

    if not metrics:
        warning(f"No metrics found for '{cfg.testrun}' — skipping report")
        return None

    interpretation: str | None = None
    if not skip_interpretation:
        info("Generating interpretation...")
        interpretation = interpret(cfg, metrics, window)

    dest = parts_dir(cfg)
    dest.mkdir(parents=True, exist_ok=True)
    path = dest / f"{cfg.script_file}.md"
    _ = path.write_text(render(cfg, metrics, window, interpretation))
    success(f"Part report written to '{path}'")
    return path


def merge(configs: list[Config], skip_interpretation: bool = False) -> None:
    """Generate per-script reports and merge them into a single combined report."""
    if not configs:
        warning("No configs to merge — skipping")
        return

    parts: list[Path] = []
    for cfg in configs:
        part = generate(cfg, skip_interpretation=skip_interpretation)
        if part:
            parts.append(part)

    if not parts:
        warning("No part reports generated — skipping merge")
        return

    first = configs[0]
    now = datetime.now(timezone.utc)
    date_str = f"{now.day} de {MONTHS[now.month - 1]} de {now.year}"

    jinja_env = Environment(
        loader=FileSystemLoader(str(HERE / "files")), keep_trailing_newline=True
    )
    header = jinja_env.get_template(COMBINED_TEMPLATE_FILE).render(
        date=date_str,
        prefix=first.prefix,
        base_id=first.base_id,
        env_label=first.env_label,
    )

    sections = "\n\n---\n\n".join(part.read_text().rstrip("\n") for part in parts)
    combined = header + sections + "\n"

    first.reports_dir.mkdir(parents=True, exist_ok=True)
    combined_path = first.reports_dir / f"{first.base_id}.md"
    _ = combined_path.write_text(combined)
    format_report(combined_path)
    shutil.rmtree(parts_dir(first))
    success(f"Combined report written to '{combined_path}'")


def main() -> None:
    """Entrypoint: regenerate a combined report from a past testrun.

    Usage: python3 -m scripts.report <base-id> <scripts> [testrun-id] [--no-interpretation]

    scripts            — comma-separated list of script names
    testrun            — original testrun ID to query in ClickHouse; defaults to base-id
    --no-interpretation — skip the opencode LLM step
    """
    args = argv[1:]
    if len(args) < 2:
        print(
            "Usage: python3 -m scripts.report <base-id> <scripts> [testrun-id] [--no-interpretation]",
            file=stderr,
        )
        exit(1)
    no_interpretation = "--no-interpretation" in args
    args = [a for a in args if a != "--no-interpretation"]
    base_id = args[0]
    scripts = [s.strip() for s in args[1].split(",") if s.strip()]
    testrun = args[2] if len(args) > 2 else base_id
    configs = [
        Config(testrun=testrun, script_file=s, base_id=base_id, smoke=False)
        for s in scripts
    ]
    merge(configs, skip_interpretation=no_interpretation)


if __name__ == "__main__":
    main()
