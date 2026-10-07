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

The MIAW scenario (`app-mcp-server--miaw`) drives the Agentforce chat channel through the
Messaging for In-App and Web API. Each iteration is one conversation: get an unauthenticated
token, create the conversation, send the configured messages paced at `MESSAGES_PER_MINUTE`, keep
the conversation open until `CONVERSATION_WINDOW_SECONDS` elapses, then close it (`DELETE`). One
iteration takes about 60–80s. Defaults point at the `prefeitura-rio--devmarcelo` sandbox; the
script refuses to start against the production host or org unless `ALLOW_PROD=true`.

All MIAW knobs are read inside the runner pod, so pass them through `K6_EXTRA_ENV` — exporting
them in the shell has no effect:

```sh
# Smoke: 1 VU × 1 iteration, no thresholds
SMOKE=true just run app-mcp-server--miaw

# Concurrency target (closed model): N concurrent users, each looping conversations
RUNNER_CPU_REQUEST=4 RUNNER_MEMORY_REQUEST=8Gi RUNNER_MEMORY_LIMIT=12Gi \
K6_EXTRA_ENV='{"CONCURRENT_VUS":"2500","RAMP_DURATION":"5m","HOLD_DURATION":"10m"}' \
just run app-mcp-server--miaw

# Step ladder: climb several plateaus in one run to find where the platform breaks
RUNNER_CPU_REQUEST=4 RUNNER_MEMORY_REQUEST=8Gi RUNNER_MEMORY_LIMIT=12Gi \
K6_EXTRA_ENV='{"STEP_LADDER":"true","STEPS":"100,500,1000,1500,2000,2500","STEP_RAMP":"2m","STEP_HOLD":"5m"}' \
just run app-mcp-server--miaw

# Arrival rate (open model): new sessions per minute; jitter must be 0 in this mode
K6_EXTRA_ENV='{"EXECUTOR":"arrival-rate","SESSIONS_PER_MINUTE":"600","STARTUP_JITTER_SECONDS":"0"}' \
just run app-mcp-server--miaw
```

| Variable | Default | Description |
| --- | --- | --- |
| `MIAW_SCRT_URL` | sandbox SCRT URL | MIAW API host |
| `MIAW_ORG_ID` | `00D89000006oT9pEAE` | Salesforce org ID |
| `MIAW_DEPLOYMENT_NAME` | `API_Chat_Agentforce_Prefeitura_Rio` | Embedded Service deployment |
| `ALLOW_PROD` | `false` | Required to target the production host/org |
| `EXECUTOR` | `ramping-vus` | `ramping-vus` (concurrent users) or `arrival-rate` (sessions/min) |
| `CONCURRENT_VUS` | `1` | Target VUs (`ramping-vus`) |
| `SESSIONS_PER_MINUTE` | `CONCURRENT_VUS` | Target session rate (`arrival-rate`) |
| `ARRIVAL_MAX_VUS` / `ARRIVAL_PREALLOC_VUS` | 1.3 × peak rate | VU pool for `arrival-rate` |
| `RAMP_DURATION` / `HOLD_DURATION` | `5m` / `10m` | Single-target ramp and hold |
| `STEP_LADDER` | `false` | Use `STEPS` plateaus instead of the single target |
| `STEPS` | `100,500,1000,1500,2000,2500` | Plateau targets (VUs, or sessions/min under `arrival-rate`) |
| `STEP_RAMP` / `STEP_HOLD` | `2m` / `5m` | Ramp and hold per plateau |
| `MESSAGES_PER_MINUTE` | `3` | Message pacing within a conversation |
| `MIAW_MESSAGES` | 3 small-talk messages | `\|\|`-separated messages, one per turn |
| `CONVERSATION_WINDOW_SECONDS` | `60` | How long a healthy conversation stays open |
| `FILL_CONVERSATION_MINUTE` | `true` | `false` closes early and idles `SESSION_COOLDOWN_SECONDS` instead |
| `SESSION_COOLDOWN_SECONDS` | `15` | Backoff after a failed conversation |
| `CLOSE_CONVERSATION` | `true` | Close (`DELETE`) each conversation at the end |
| `POLL_INTERVAL_SECONDS` / `MAX_POLL_TIMEOUT_SECONDS` | `5` / `60` | Agent-reply polling; 1s triggers `429` on the entries endpoint |
| `AGENT_P95_MS` / `CLOSING_TURN_P95_MS` | `30000` / `60000` | Agent-reply p95 per turn; the last (closing) turn uses the second |
| `MAX_RETRIES` | `3` | Retries for token/create/close on 429/5xx |
| `RETRY_BASE_BACKOFF_SECONDS` / `RETRY_MAX_BACKOFF_SECONDS` | `2` / `30` | Exponential backoff bounds |
| `STARTUP_JITTER_SECONDS` | `20` | Random delay before a VU's first iteration (ignored in smoke) |
| `MIAW_MAX_UNIQUE_PHONES` | `1000000000` | Phone-number space for unique per-(VU, iteration) numbers |

Outside smoke mode the run aborts when more than 10% of requests fail for 30s; the pass/fail
thresholds are `http_req_failed < 1%` and turn completion, Agentforce success and conversation
completion above 90% (provisional, pending confirmation with the client), with agent-reply p95
per turn under 30s, except the closing turn (under 60s). The k6 Operator evaluates thresholds per
runner pod, so `just run` rejects this script unless `PARALLELISM=1`. When a conversation create
fails, the script makes a best-effort cleanup `DELETE` tagged `service=miaw_setup`,
`phase=cleanup`; it only feeds the `miaw_orphan_cleanup` counter and is left out of thresholds
and the report. The `miaw_*` custom metrics are only visible in SigNoz; `just report` covers the
built-in HTTP metrics of `service=miaw`.

Operational constraints for MIAW runs:

- Against the sandbox, run between 09:00 and 18:00 America/Sao_Paulo, Monday to Saturday.
  Outside that window the sandbox channel answers `412` to every conversation create, so the run
  only exercises the failure path. Production has no such window.
- Wait about 30 minutes between runs against the same org: the platform drains its active-session
  counter slowly, and a run started too soon inherits the previous run's sessions.
- 2,500 VUs fit in one runner with the resources above. The cluster autoscaler may add a node for
  the 4-CPU request, so the runner can stay `Pending` for a few minutes.
- Every conversation requests a new access token. If the org caps tokens per minute, token `429`s
  (`miaw_token_rate_limited`) appear first; prefer the step ladder to locate that limit instead
  of a single ramp that aborts early.

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
  app-mcp-server--miaw.ts Agentforce MIAW chat-channel scenario
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
| `PARALLELISM` | `1` | Runner pods per TestRun (`app-mcp-server--miaw` requires `1`) |
| `RUNNER_CPU_REQUEST` / `RUNNER_MEMORY_REQUEST` / `RUNNER_MEMORY_LIMIT` | — | Runner pod resources; `resources` is omitted when none are set |
| `K6_EXTRA_ENV` | — | JSON map of extra plain env vars for the runner pod |
| `K6_SECRET_ENV` | — | JSON map of env vars read from Secrets in `k6-operator-system` |
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
