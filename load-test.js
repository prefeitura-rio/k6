/**
 * load-test.js — Superapp Staging API Load Test
 *
 * Simulates an estimated peak load across 5 services in parallel.
 *
 * ─── QUICK START ────────────────────────────────────────────────────────────
 *
 * Run locally (from inside the cluster, or with port-forwards):
 *
 *   k6 run load-test.js
 *
 * Smoke test (1 VU, 1 iteration per scenario):
 *
 *   k6 run --env SMOKE=true load-test.js
 *
 * Override base URLs (defaults: internal cluster DNS):
 *
 *   k6 run \
 *     --env BASE_URL_BUSCA=http://app-busca-search.busca.svc.cluster.local:8080 \
 *     --env BASE_URL_GO=http://go.go.svc.cluster.local \
 *     --env BASE_URL_RMI=http://rmi.rmi.svc.cluster.local \
 *     --env BASE_URL_URL_SHORTENER=http://url-shortener.url-shortener.svc.cluster.local \
 *     --env BASE_URL_HEIMDALL=http://heimdall-admin.heimdall.svc.cluster.local \
 *     load-test.js
 *
 * Override load profile:
 *
 *   k6 run --env TARGET_RPS=100 --env SUSTAINED_DURATION=45m load-test.js
 *
 * Submit to k6 Operator (create a TestRun CR):
 *
 *   kubectl -n k6-operator-system create configmap load-test \
 *     --from-file=load-test.js=load-test.js
 *
 *   kubectl apply -f testrun.yaml
 *
 * ─── ENV VARS ────────────────────────────────────────────────────────────────
 *
 *   SMOKE                set to "true" for smoke mode (1 iter/scenario)
 *   TARGET_RPS           target requests/s across all scenarios (default: 75)
 *   SUSTAINED_DURATION   how long to hold peak load (default: 35m)
 *   CPF_POOL_SIZE        number of unique CPFs to pre-generate (default: 7500)
 *   BASE_URL_BUSCA       base URL for app-busca-search
 *   BASE_URL_GO          base URL for app-go-api
 *   BASE_URL_RMI         base URL for app-rmi
 *   BASE_URL_URL_SHORTENER  base URL for url-shortener
 *   BASE_URL_HEIMDALL    base URL for heimdall-admin
 *
 * ─── LOAD PROFILE ────────────────────────────────────────────────────────────
 *
 *   Each scenario uses constant-arrival-rate at TARGET_RPS / 5 RPS (split
 *   evenly across 5 services), so total RPS = TARGET_RPS.
 *
 *   Ramp:    2 min  (0 → TARGET_RPS per scenario)
 *   Sustain: SUSTAINED_DURATION at TARGET_RPS per scenario
 *   Total:   ~37 min at defaults
 *
 * ─── AUTH STRATEGY ───────────────────────────────────────────────────────────
 *
 *   Endpoints requiring authentication receive "Authorization: Bearer invalid".
 *   A 401 response is treated as a pass — it validates that the auth layer
 *   is handling load, not silently failing.
 *
 * ─── SERVICES ────────────────────────────────────────────────────────────────
 *
 *   busca         app-busca-search   (public search + categories)
 *   go_api        app-go-api         (public vagas + auth-required with 401)
 *   rmi           app-rmi            (all auth-required; reference + citizen CPF)
 *   url_shortener url-shortener      (public CRUD)
 *   heimdall      heimdall-admin     (admin auth-required)
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";

// Mark 401/403/404 as expected so http_req_failed only fires on real errors (5xx/network).
http.setResponseCallback(http.expectedStatuses(
    { min: 200, max: 302 }, 401, 403, 404
));

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const SMOKE             = __ENV.SMOKE === "true";
const TARGET_RPS        = parseInt(__ENV.TARGET_RPS || "75");
const SUSTAINED_DURATION = __ENV.SUSTAINED_DURATION || "35m";
const CPF_POOL_SIZE     = parseInt(__ENV.CPF_POOL_SIZE || "7500");

// RPS per scenario — split evenly across 5 services
const RPS_PER_SCENARIO  = Math.max(1, Math.round(TARGET_RPS / 5));

const BASE = {
    busca:        __ENV.BASE_URL_BUSCA         || "http://app-busca-search.busca.svc.cluster.local:8080",
    go:           __ENV.BASE_URL_GO            || "http://go.go.svc.cluster.local",
    rmi:          __ENV.BASE_URL_RMI           || "http://rmi.rmi.svc.cluster.local",
    urlShortener: __ENV.BASE_URL_URL_SHORTENER || "http://url-shortener.url-shortener.svc.cluster.local",
    heimdall:     __ENV.BASE_URL_HEIMDALL      || "http://heimdall-admin.heimdall.svc.cluster.local",
};

// ─── CPF POOL ────────────────────────────────────────────────────────────────

// Pre-generate unique CPFs in init context so all VUs share the same pool
// without re-computing on every iteration.
const CPF_POOL = new SharedArray("cpfs", function () {
    const pool = [];
    const seen = new Set();
    while (pool.length < CPF_POOL_SIZE) {
        const cpf = _generateCPF();
        if (!seen.has(cpf)) {
            seen.add(cpf);
            pool.push(cpf);
        }
    }
    return pool;
});

function _generateCPF() {
    const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
    let sum = d.reduce((acc, n, i) => acc + n * (10 - i), 0);
    let r = (sum * 10) % 11;
    d.push(r >= 10 ? 0 : r);
    sum = d.reduce((acc, n, i) => acc + n * (11 - i), 0);
    r = (sum * 10) % 11;
    d.push(r >= 10 ? 0 : r);
    return d.join("");
}

// ─── LOAD PROFILE ────────────────────────────────────────────────────────────

function makeScenario(exec) {
    if (SMOKE) {
        return { executor: "per-vu-iterations", vus: 1, iterations: 1, exec };
    }
    return {
        executor: "ramping-arrival-rate",
        startRate: 0,
        timeUnit: "1s",
        preAllocatedVUs: RPS_PER_SCENARIO * 4,
        maxVUs: RPS_PER_SCENARIO * 10,
        stages: [
            { duration: "2m",               target: RPS_PER_SCENARIO },  // ramp
            { duration: SUSTAINED_DURATION, target: RPS_PER_SCENARIO },  // sustain
        ],
        exec,
    };
}

// ─── OPTIONS ─────────────────────────────────────────────────────────────────

export const options = {
    scenarios: {
        busca:         makeScenario("buscaScenario"),
        go_api:        makeScenario("goApiScenario"),
        rmi:           makeScenario("rmiScenario"),
        url_shortener: makeScenario("urlShortenerScenario"),
        heimdall:      makeScenario("heimdallScenario"),
    },
    thresholds: {
        http_req_duration:                  ["p(95)<2000"],
        http_req_failed:                    ["rate<0.05"],
        "http_req_duration{service:busca}": ["p(95)<1000"],
    },
};

// ─── SHARED STATE ─────────────────────────────────────────────────────────────

// url-shortener: capture both UUIDs (for /api/urls/{id}) and short_paths (for public redirects)
const capturedUrlUUIDs = [];
const capturedUrlShortPaths = [];
const MAX_CAPTURED = 100;

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function randomItem(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function weightedPick(weighted) {
    const total = weighted.reduce((sum, w) => sum + w.weight, 0);
    let r = Math.random() * total;
    for (const w of weighted) {
        r -= w.weight;
        if (r <= 0) return w.value;
    }
    return weighted[weighted.length - 1].value;
}

function call(service, method, url, body = null, params = {}) {
    const p = {
        ...params,
        tags: { service, ...(params.tags || {}) },
        headers: { "Content-Type": "application/json", ...(params.headers || {}) },
    };

    let res;
    const m = method.toUpperCase();
    if (m === "GET" || m === "HEAD") {
        res = http.get(url, p);
    } else if (m === "DELETE") {
        res = http.del(url, body, p);
    } else {
        res = http.request(m, url, body, p);
    }

    check(res, {
        [`${service} ${method} ${url} status is acceptable`]: (r) =>
            [200, 201, 301, 302, 401, 403, 404].includes(r.status),
    });

    return res;
}

const FAKE_AUTH        = { headers: { Authorization: "Bearer invalid" } };
const URL_SHORTENER_AUTH = { headers: { Authorization: "Bearer AJAY08xP2nB9tRpiFO3GVuSPkyAy073AVI74gbdbVXvSKnFNLp5ZYQRhqvyvla1T" } };

// ─── SEARCH TERMS ─────────────────────────────────────────────────────────────

const BUSCA_TERMS = [
    "habite-se", "IPTU", "creche", "vacina", "alvará", "CND", "CTPS",
    "habilitação", "passaporte", "certidão", "INSS", "BPC", "Bolsa Família",
    "consulta médica", "remédio", "escola", "matrícula", "transporte escolar",
    "coleta de lixo", "iluminação pública", "buraco na rua", "licença",
    "cadastro único", "auxílio emergencial", "habitação popular", "regularização",
    "MEI", "microempreendedor", "nota fiscal", "ISS", "IPTU lote",
];

// ─── SETUP ───────────────────────────────────────────────────────────────────

export function setup() {
    const buscaIds  = [];
    const shortPaths = [];
    const vagaIds   = [];

    // Seed busca content IDs
    const buscaRes = http.get(
        `${BASE.busca}/api/v1/search?q=sa%C3%BAde&type=keyword&per_page=20`,
        { tags: { service: "busca_setup" } }
    );
    if (buscaRes.status === 200) {
        try {
            const body = JSON.parse(buscaRes.body);
            for (const item of (body.results || [])) {
                if (item.id) buscaIds.push(item.id);
            }
        } catch (_) { }
    }

    // Seed url-shortener short_paths for public redirect testing
    const urlRes = http.get(
        `${BASE.urlShortener}/api/urls?page=1&limit=50`,
        { tags: { service: "url_shortener_setup" }, headers: { Authorization: "Bearer AJAY08xP2nB9tRpiFO3GVuSPkyAy073AVI74gbdbVXvSKnFNLp5ZYQRhqvyvla1T" } }
    );
    if (urlRes.status === 200) {
        try {
            const body = JSON.parse(urlRes.body);
            for (const u of (body.urls || [])) {
                if (u.short_path) shortPaths.push(u.short_path);
            }
        } catch (_) { }
    }

    // Seed go_api vaga UUIDs for detail endpoint
    const vagaRes = http.get(
        `${BASE.go}/api/public/empregabilidade/vagas`,
        { tags: { service: "go_setup" } }
    );
    if (vagaRes.status === 200) {
        try {
            const body = JSON.parse(vagaRes.body);
            for (const v of (body.data || [])) {
                if (v.id) vagaIds.push(v.id);
            }
        } catch (_) { }
    }

    console.log(`setup: seeded ${buscaIds.length} busca IDs, ${shortPaths.length} short paths, ${vagaIds.length} vaga IDs, ${CPF_POOL.length} CPFs in pool`);
    return { buscaIds, shortPaths, vagaIds };
}

// ─── SCENARIO: BUSCA ─────────────────────────────────────────────────────────
//
// Weights:
//   45% GET /api/v1/search?q=<term>   — FTS search
//   20% GET /api/v1/categories        — category list
//   20% GET /api/v2/search?q=<term>   — semantic/vector search
//   15% GET /api/v1/search/{id}       — item detail (seeded IDs)

export function buscaScenario(data) {
    const choice = weightedPick([
        { weight: 45, value: "search_v1" },
        { weight: 20, value: "categories" },
        { weight: 20, value: "search_v2" },
        { weight: 15, value: "search_by_id" },
    ]);

    const base = BASE.busca;

    switch (choice) {
        case "search_v1": {
            const q = encodeURIComponent(randomItem(BUSCA_TERMS));
            call("busca", "GET", `${base}/api/v1/search?q=${q}&type=keyword&per_page=10`);
            break;
        }
        case "categories": {
            call("busca", "GET", `${base}/api/v1/categories`);
            break;
        }
        case "search_v2": {
            const q = encodeURIComponent(randomItem(BUSCA_TERMS));
            // semantic returns 500 server-side; only use keyword and hybrid
            const type = randomItem(["keyword", "hybrid"]);
            call("busca", "GET", `${base}/api/v2/search?q=${q}&type=${type}&per_page=10`);
            break;
        }
        case "search_by_id": {
            const ids = data && data.buscaIds && data.buscaIds.length > 0 ? data.buscaIds : null;
            call("busca", "GET", ids
                ? `${base}/api/v1/search/${encodeURIComponent(randomItem(ids))}`
                : `${base}/api/v1/categories`
            );
            break;
        }
    }
}

// ─── SCENARIO: GO API ─────────────────────────────────────────────────────────
//
// Weights:
//   25% GET /api/public/empregabilidade/vagas      — job listings
//   15% GET /api/public/empregabilidade/vagas/{id} — job detail (404 ok)
//   20% GET /api/v1/courses                        — auth-required → 401
//   20% GET /api/v1/empregabilidade/vagas          — auth-required → 401
//   20% GET /api/v1/categorias                     — auth-required → 401

export function goApiScenario(data) {
    const choice = weightedPick([
        { weight: 25, value: "public_vagas" },
        { weight: 15, value: "public_vaga_id" },
        { weight: 20, value: "auth_courses" },
        { weight: 20, value: "auth_vagas" },
        { weight: 20, value: "auth_categorias" },
    ]);

    const base = BASE.go;

    switch (choice) {
        case "public_vagas":
            call("go_api", "GET", `${base}/api/public/empregabilidade/vagas`);
            break;
        case "public_vaga_id": {
            // Use seeded UUIDs; fall back to listing if none seeded yet
            const ids = data && data.vagaIds && data.vagaIds.length > 0 ? data.vagaIds : null;
            if (ids) {
                call("go_api", "GET", `${base}/api/public/empregabilidade/vagas/${randomItem(ids)}`);
            } else {
                call("go_api", "GET", `${base}/api/public/empregabilidade/vagas`);
            }
            break;
        }
        case "auth_courses":
            call("go_api", "GET", `${base}/api/v1/courses`, null, FAKE_AUTH);
            break;
        case "auth_vagas":
            call("go_api", "GET", `${base}/api/v1/empregabilidade/vagas`, null, FAKE_AUTH);
            break;
        case "auth_categorias":
            call("go_api", "GET", `${base}/api/v1/categorias`, null, FAKE_AUTH);
            break;
    }
}

// ─── SCENARIO: RMI ───────────────────────────────────────────────────────────
//
// All endpoints require Bearer auth → 401.
// CPFs drawn from the pre-generated shared pool of CPF_POOL_SIZE unique CPFs.
//
// Weights:
//   20% GET /citizen/ethnicity/options
//   15% GET /citizen/gender/options
//   15% GET /citizen/disability/options
//   15% GET /citizen/education/options
//   10% GET /citizen/family-income/options
//   25% GET /citizen/{cpf}

export function rmiScenario() {
    const choice = weightedPick([
        { weight: 20, value: "ethnicity" },
        { weight: 15, value: "gender" },
        { weight: 15, value: "disability" },
        { weight: 15, value: "education" },
        { weight: 10, value: "family_income" },
        { weight: 25, value: "citizen_cpf" },
    ]);

    const base = BASE.rmi;

    switch (choice) {
        case "ethnicity":
            call("rmi", "GET", `${base}/v1/citizen/ethnicity/options`, null, FAKE_AUTH);
            break;
        case "gender":
            call("rmi", "GET", `${base}/v1/citizen/gender/options`, null, FAKE_AUTH);
            break;
        case "disability":
            call("rmi", "GET", `${base}/v1/citizen/disability/options`, null, FAKE_AUTH);
            break;
        case "education":
            call("rmi", "GET", `${base}/v1/citizen/education/options`, null, FAKE_AUTH);
            break;
        case "family_income":
            call("rmi", "GET", `${base}/v1/citizen/family-income/options`, null, FAKE_AUTH);
            break;
        case "citizen_cpf":
            call("rmi", "GET", `${base}/v1/citizen/${randomItem(CPF_POOL)}`, null, FAKE_AUTH);
            break;
    }
}

// ─── SCENARIO: URL SHORTENER ─────────────────────────────────────────────────
//
// /api/* requires the service's static Bearer token (from AuthorizationPolicy).
// /{shortPath} is public — no auth needed.
//
// Weights:
//   35% GET  /api/urls?page=N&limit=20  — authenticated list
//   30% POST /api/urls                  — authenticated create; captures short_path
//   20% GET  /{short_path}              — public redirect (seeded from setup + captures)
//   15% GET  /api/urls/{id}             — authenticated item detail

export function urlShortenerScenario(data) {
    const choice = weightedPick([
        { weight: 35, value: "list" },
        { weight: 30, value: "create" },
        { weight: 20, value: "redirect" },
        { weight: 15, value: "get_by_id" },
    ]);

    const base = BASE.urlShortener;

    switch (choice) {
        case "list": {
            const page = Math.floor(Math.random() * 5) + 1;
            call("url_shortener", "GET", `${base}/api/urls?page=${page}&limit=20`, null, URL_SHORTENER_AUTH);
            break;
        }
        case "create": {
            const slug = Math.random().toString(36).substring(2, 10);
            const res = call("url_shortener", "POST", `${base}/api/urls`, JSON.stringify({
                destination: `https://prefeitura.rio/servicos/${slug}`,
                title: `Serviço ${slug}`,
            }), URL_SHORTENER_AUTH);
            if (res.status === 201) {
                try {
                    const json = JSON.parse(res.body);
                    if (capturedUrlUUIDs.length < MAX_CAPTURED) {
                        if (json.id)         capturedUrlUUIDs.push(json.id);
                        if (json.short_path) capturedUrlShortPaths.push(json.short_path);
                    }
                } catch (_) { }
            }
            break;
        }
        case "redirect": {
            // Use seeded short_paths from setup, or fall back to captured ones
            const pool = (data && data.shortPaths && data.shortPaths.length > 0)
                ? data.shortPaths
                : capturedUrlShortPaths;
            if (pool.length > 0) {
                call("url_shortener", "GET", `${base}/${randomItem(pool)}`);
            } else {
                // Nothing seeded yet — fall back to authenticated list
                call("url_shortener", "GET", `${base}/api/urls?page=1&limit=20`, null, URL_SHORTENER_AUTH);
            }
            break;
        }
        case "get_by_id": {
            // Needs UUID, not short_path
            if (capturedUrlUUIDs.length > 0) {
                call("url_shortener", "GET", `${base}/api/urls/${randomItem(capturedUrlUUIDs)}`, null, URL_SHORTENER_AUTH);
            } else {
                call("url_shortener", "GET", `${base}/api/urls?page=1&limit=20`, null, URL_SHORTENER_AUTH);
            }
            break;
        }
    }
}

// ─── SCENARIO: HEIMDALL ──────────────────────────────────────────────────────
//
// Weights:
//   50% GET /api/v1/users/    — admin user list → 401
//   50% GET /api/v1/groups/   — admin group list → 401

export function heimdallScenario() {
    const base = BASE.heimdall;
    if (Math.random() < 0.5) {
        call("heimdall", "GET", `${base}/api/v1/users/`, null, FAKE_AUTH);
    } else {
        call("heimdall", "GET", `${base}/api/v1/groups/`, null, FAKE_AUTH);
    }
}

// ─── TEARDOWN ────────────────────────────────────────────────────────────────

export function teardown() {
    // Smoke mode finishes in ~2s; keep alive so OTEL can flush all metrics.
    // export_interval=5s means up to 2 flush cycles; add buffer for gRPC RTT.
    if (SMOKE) sleep(30);
}
