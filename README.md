# k6 Load Tests — Superapp

k6 load tests for the Rio de Janeiro City Government Superapp platform, running inside a GKE cluster via the [k6 Operator](https://github.com/grafana/k6-operator). Metrics are exported to SigNoz/ClickHouse over OTLP, and a combined markdown report with AI interpretation is generated after each run.

## Requirements

- [Nix](https://nixos.org/) with flakes enabled — provides `python3`, `kubectl`, `just`, `prettier`, `ruff`, `basedpyright`, `typescript`, and `gcloud`
- Authenticated GKE credentials (`gcloud container clusters get-credentials …`)
- `opencode` on `PATH` (for AI-generated report interpretation)
- `ENV` set to `staging` (default) or `prod`

Enter the dev shell:

```sh
nix develop
```

## Running a load test

```sh
# Full load test — all five superapp scripts
just run scripts="superapp--busca,superapp--go-api,superapp--heimdall,superapp--rmi,superapp--url-shortener"

# Smoke test (single iteration, no thresholds)
just run scripts="superapp--busca,superapp--go-api" smoke=true

# Against production
ENV=prod just run scripts="superapp--busca,superapp--go-api,superapp--heimdall,superapp--rmi,superapp--url-shortener"
```

Each script becomes a separate `TestRun` CR on the cluster. Logs are tailed in order, and a combined report is written to `reports/` when all runs finish.

## Regenerating a report from a past run

```sh
# With AI interpretation
just report base_id="superapp--prod--load-test-20260520-004428" \
            scripts="superapp--busca,superapp--go-api,superapp--heimdall,superapp--rmi,superapp--url-shortener" \
            testrun="load-test-20260520-004428"

# Skip AI interpretation
just report base_id="superapp--prod--load-test-20260520-004428" \
            scripts="superapp--busca,superapp--go-api,superapp--heimdall,superapp--rmi,superapp--url-shortener" \
            testrun="load-test-20260520-004428" \
            interpret=false
```

## Repository layout

```
k6/                   TypeScript k6 entrypoints (one file per scenario)
  lib.ts              Shared utilities: scenario builder, HTTP helpers, CPF pool
  superapp--*.ts      Per-service scripts
scripts/              Python orchestration package
  config.py           Runtime configuration (env vars + defaults)
  submit.py           Uploads ConfigMap and submits TestRun CRs
  tail.py             Streams pod logs and triggers report generation
  report.py           Queries ClickHouse and renders markdown reports
  clusters.py         Resolves kubectl context from prefix + env
  kubectl.py          Thin wrappers around the kubectl CLI
  log.py              ANSI-coloured log helpers
files/
  clusters.json       prefix → env → kubectl-context mapping
  metrics.yaml        ClickHouse SQL queries with typed column schemas
  testrun.yaml.tmpl   TestRun CR template
  report.md.j2        Per-script report Jinja2 template
  combined.md.j2      Combined report header Jinja2 template
  report-prompt.txt   PT-BR prompt for AI interpretation
reports/              Generated markdown reports (git-ignored)
```

## Key environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `ENV` | `staging` | Target environment (`staging` or `prod`) |
| `TARGET_RPS` | `75` | Total requests per second across all scenarios |
| `SUSTAINED_DURATION` | `35m` | Duration of the sustained load phase |
| `CPF_POOL_SIZE` | `7500` | Number of unique CPFs in the VU data pool |
| `K6_IMAGE` | `grafana/k6:2.0.0` | k6 container image used by the operator |
| `CLICKHOUSE_POD` | `chi-signoz-clickhouse-cluster-0-1-0` | ClickHouse pod for metric queries |

## Linting and type-checking

```sh
ruff check scripts/       # Python linting
ruff format scripts/      # Python formatting
basedpyright scripts/     # Python type-checking
tsc --noEmit             # TypeScript type-checking
```
