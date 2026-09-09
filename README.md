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
just run superapp--busca superapp--go-api superapp--heimdall superapp--rmi superapp--url-shortener

# Smoke test (single iteration, no thresholds)
SMOKE=true just run superapp--busca superapp--go-api

# MCP smoke test (one VU/iteration; no thresholds)
SMOKE=true \
K6_EXTRA_ENV='{"MCP_BASE_URL":"https://services.staging.app.dados.rio/mcp"}' \
K6_SECRET_ENV='{"MCP_TOKEN":{"secret":"app-mcp-server","key":"token"}}' \
just run app-mcp-server--mcp

# MCP bounded load test (staging only; keep values explicit and low)
TARGET_RPS=1 SUSTAINED_DURATION=1m \
K6_EXTRA_ENV='{"MCP_BASE_URL":"https://services.staging.app.dados.rio/mcp"}' \
K6_SECRET_ENV='{"MCP_TOKEN":{"secret":"app-mcp-server","key":"token"}}' \
just run app-mcp-server--mcp

# Against production
ENV=prod just run superapp--busca superapp--go-api superapp--heimdall \
    superapp--rmi superapp--url-shortener
```

Each script becomes a separate `TestRun` CR on the cluster. Logs are tailed in order, and a combined report is written to `reports/` when all runs finish.

Use the printed `BASE_ID` without the script suffix when tailing a run. The tail command waits for
the runner pod to become ready before attaching:

```sh
just tail "app-mcp-server--staging--lt--2608311241" app-mcp-server--mcp
```

The Rock in Rio scenario is a closed user model. Set `CONCURRENT_VUS`, not a target request
rate: each VU initializes MCP, lists tools, makes two turns 70% of the time or three turns 30%
of the time, samples inter-turn waits from the observed p50/p95/p99 buckets, then waits for a
new session. The first calibration should use the internal Service:

```sh
CONCURRENT_VUS=100 \
RAMP_DURATION=5m \
HOLD_DURATION=10m \
SESSION_COOLDOWN_SECONDS=60 \
K6_EXTRA_ENV='{"MCP_BASE_URL":"http://mcp.mcp.svc.cluster.local","CONCURRENT_VUS":"100","RAMP_DURATION":"5m","HOLD_DURATION":"10m","SESSION_COOLDOWN_SECONDS":"60"}' \
K6_SECRET_ENV='{"MCP_TOKEN":{"secret":"app-mcp-server","key":"token"}}' \
just run app-mcp-server--riri
```

The VU scenario uses `rock_in_rio_lineup` with `{}`. Its main load path assumes the application
cache is warm; cache-cold scraping is a separate, single-VU diagnostic and must not be mixed into
the event-load test.

The Agentforce control scenario uses the synchronous Agent API. It obtains one client-credentials
token in k6 `setup()`, creates one session per VU iteration, sends configured Portuguese messages,
and ends the session. Keep the Consumer Key and Secret in the `agentforce-loadtest` Kubernetes
Secret; pass only endpoint and Agent ID values through `K6_EXTRA_ENV`:

```sh
K6_EXTRA_ENV='{"AGENT_ID":"<agent-id>","AGENT_PROFILE":"no_action","SF_TOKEN_URL":"https://prefeitura-rio.my.salesforce.com/services/oauth2/token","SF_ORG_ENDPOINT":"https://prefeitura-rio.my.salesforce.com/","AGENT_API_BASE":"https://api.salesforce.com/einstein/ai-agent/v1","CONCURRENT_VUS":"1","RAMP_DURATION":"30s","HOLD_DURATION":"1m","THINK_TIME_SECONDS":"1"}' \
K6_SECRET_ENV='{"SF_CLIENT_ID":{"secret":"agentforce-loadtest","key":"client-id"},"SF_CLIENT_SECRET":{"secret":"agentforce-loadtest","key":"client-secret"}}' \
just run app-mcp-server--sf
```

The MCP script assumes independent stateless Streamable HTTP requests: each request is
self-contained and does not use session headers or notification calls. Set `MCP_BASE_URL`
through `K6_EXTRA_ENV` to the external service prefix **including** `/mcp`; the script appends
`/health` for liveness and `/mcp` for MCP JSON-RPC requests. Inject `MCP_TOKEN` through
`K6_SECRET_ENV`; the referenced Secret must exist in the `k6-operator-system` namespace. Do not
place the token in shell history or source files. Requests use `Authorization: Bearer <MCP_TOKEN>`,
`Content-Type: application/json`, and `Accept: application/json, text/event-stream`.

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
  app-mcp-server--mcp.ts  Stateless Streamable HTTP MCP scenario
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
| `MCP_BASE_URL` | — | Explicit base URL for the MCP target, supplied through `K6_EXTRA_ENV` |
| `MCP_TOKEN` | — | MCP bearer token, supplied through `K6_SECRET_ENV` |

## Linting and type-checking

```sh
ruff check scripts/       # Python linting
ruff format scripts/      # Python formatting
basedpyright scripts/     # Python type-checking
tsc --noEmit             # TypeScript type-checking
```
