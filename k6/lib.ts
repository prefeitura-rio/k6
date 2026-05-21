import http, { RefinedResponse, ResponseType } from "k6/http";
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";

/** k6 system tags emitted with every metric. Excludes `url` to avoid high cardinality. */
export const SYSTEM_TAGS = ["method", "status", "expected_response", "group", "proto"];

/** Whether the test is running in smoke mode (single VU, single iteration). */
export const SMOKE = __ENV["SMOKE"] === "true";

/** Total target request rate across all scenarios, in requests per second. */
export const TARGET_RPS = parseInt(__ENV["TARGET_RPS"] ?? "75", 10);

/** Duration of the sustained load phase, e.g. `"20m"`. */
export const SUSTAINED_DURATION = __ENV["SUSTAINED_DURATION"] ?? "35m";

/** Number of unique CPFs to generate for the shared pool. */
export const CPF_POOL_SIZE = parseInt(__ENV["CPF_POOL_SIZE"] ?? "7500", 10);

/**
 * Number of concurrent scenarios running in this test run.
 * Used to divide `TARGET_RPS` evenly across scripts.
 */
const SCENARIO_COUNT = parseInt(__ENV["SCENARIO_COUNT"] ?? "5", 10);

/** Target request rate for this scenario: `TARGET_RPS / SCENARIO_COUNT`, minimum 1. */
export const RPS_PER_SCENARIO = Math.max(1, Math.round(TARGET_RPS / SCENARIO_COUNT));

/**
 * Baseline k6 thresholds applied to every script.
 * - p95 response time must stay under 2 s.
 * - Overall error rate must stay below 5 %.
 */
export const BASE_THRESHOLDS = {
    http_req_duration: ["p(95)<2000"],
    http_req_failed: ["rate<0.05"],
};

/**
 * HTTP status codes that are considered non-failures for the purpose of checks
 * and the k6 `http_req_failed` metric. Single source of truth — `setDefaultResponseCallback`
 * is derived from this list. Includes expected auth rejections (401, 403), common
 * redirects (301, 302), and not-found (404).
 */
const ACCEPTABLE_STATUSES = [200, 201, 301, 302, 401, 403, 404] as const;

/**
 * Passes an invalid Bearer token to exercise authenticated endpoints.
 * The service is expected to respond with 401 or 403.
 */
export const FAKE_AUTH = { headers: { Authorization: "Bearer invalid" } } as const;

/** HTTP verb union accepted by `call`. Prevents typos from reaching the wire. */
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

/** A value paired with a relative weight for use in `weightedPick`. */
type Weighted<T> = { weight: number; value: T };

/**
 * Subset of k6 HTTP request parameters used by `call`.
 * Additional properties are forwarded to the k6 HTTP client as-is.
 */
type Params = {
    /** Custom metric tags merged with the default `service` and `name` tags. */
    tags?: Record<string, string>;
    /** HTTP headers merged with the default `Content-Type: application/json`. */
    headers?: Record<string, string>;
    /** Per-request timeout, e.g. `"5s"`. Overrides the k6 global default of 60 s. */
    timeout?: string;
};

/** Scenario configuration for smoke mode: one VU, one iteration. */
type SmokeScenario = {
    executor: "per-vu-iterations";
    vus: number;
    iterations: number;
    exec: string;
};

/** Scenario configuration for load mode: open-model arrival rate with ramp-up. */
type LoadScenario = {
    executor: "ramping-arrival-rate";
    startRate: number;
    timeUnit: string;
    preAllocatedVUs: number;
    maxVUs: number;
    stages: { duration: string; target: number }[];
    exec: string;
};

/** Union of the two supported scenario shapes returned by `makeScenario`. */
type ScenarioConfig = SmokeScenario | LoadScenario;

/**
 * Generates a single valid Brazilian CPF string (11 digits, no separators).
 * Uses the standard two-digit checksum algorithm.
 */
function generateCPF(): string {
    const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
    let sum = d.reduce((acc, n, i) => acc + n * (10 - i), 0);
    let r = (sum * 10) % 11;
    d.push(r >= 10 ? 0 : r);
    sum = d.reduce((acc, n, i) => acc + n * (11 - i), 0);
    r = (sum * 10) % 11;
    d.push(r >= 10 ? 0 : r);
    return d.join("");
}

/**
 * Pre-generated pool of unique valid CPFs shared across all VUs.
 * Size is controlled by `CPF_POOL_SIZE`. Deduplication is guaranteed.
 */
export const CPF_POOL = new SharedArray("cpfs", function () {
    const pool: string[] = [];
    const seen = new Set<string>();
    while (pool.length < CPF_POOL_SIZE) {
        const cpf = generateCPF();
        if (!seen.has(cpf)) {
            seen.add(cpf);
            pool.push(cpf);
        }
    }
    return pool;
});

/**
 * Returns a random element from a non-empty array.
 * Throws if the array is empty — callers must guarantee at least one element.
 */
export function randomItem<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error("randomItem called with empty array");
    return arr[Math.floor(Math.random() * arr.length)] as T;
}

/**
 * Picks a random value from a weighted list using proportional random selection.
 * Higher weights increase the probability of selection.
 * Falls back to the last element if floating-point rounding skips all checks.
 * Throws if the list is empty.
 */
export function weightedPick<T>(weighted: Weighted<T>[]): T {
    if (weighted.length === 0) throw new Error("weightedPick called with empty array");
    const total = weighted.reduce((sum, w) => sum + w.weight, 0);
    let r = Math.random() * total;
    for (const w of weighted) {
        r -= w.weight;
        if (r <= 0) return w.value;
    }
    return (weighted[weighted.length - 1] as Weighted<T>).value;
}

/**
 * Strips the scheme, host, and query string from a URL, returning just the path.
 * Uses a regex rather than `new URL()` because `new URL()` is broken in Goja (k6's JS runtime).
 */
function pathWithoutQueryString(url: string): string {
    return url.replace(/^https?:\/\/[^/]+/, "").split("?")[0] || "/";
}

/**
 * Resolves the metric name for a request.
 * Uses the explicit `name` tag if provided, otherwise derives it from the URL path.
 */
function resolvedName(params: Params, url: string): string {
    return params.tags?.["name"] ?? pathWithoutQueryString(url);
}

/** Returns true if the HTTP status code is in the set of acceptable statuses. */
function isAcceptableStatus(status: number): boolean {
    return (ACCEPTABLE_STATUSES as readonly number[]).includes(status);
}

/**
 * Registers the default response callback derived from `ACCEPTABLE_STATUSES`, so that
 * exactly those status codes are not counted as failures by k6's `http_req_failed` metric.
 * Call once at module level in each script.
 */
export function setDefaultResponseCallback(): void {
    http.setResponseCallback(http.expectedStatuses(...ACCEPTABLE_STATUSES));
}

/**
 * Makes an HTTP request and records a check against the acceptable status list.
 *
 * @param service - Value written to the `service` metric tag, used for grouping in dashboards.
 * @param method  - HTTP method (`GET`, `POST`, `DELETE`, etc.).
 * @param url     - Full request URL.
 * @param body    - Request body, or `null` for bodyless methods.
 * @param params  - Optional tags, headers, and timeout merged with defaults.
 * @returns The raw k6 HTTP response.
 */
export function call(
    service: string,
    method: HttpMethod,
    url: string,
    body: string | null = null,
    params: Params = {},
): RefinedResponse<ResponseType> {
    const name = resolvedName(params, url);
    const p = {
        ...params,
        tags: { service, name, ...params.tags },
        headers: { "Content-Type": "application/json", ...params.headers },
    };

    let res: RefinedResponse<ResponseType>;

    if (method === "GET" || method === "HEAD") {
        res = http.get(url, p);
    } else if (method === "DELETE") {
        res = http.del(url, body, p);
    } else {
        res = http.request(method, url, body, p);
    }

    check(res, {
        [`${service} ${method} ${name} status is acceptable`]: (r) => isAcceptableStatus(r.status),
    });

    return res;
}

/**
 * Builds a k6 scenario configuration for the named exec function.
 *
 * - **Smoke mode** (`SMOKE=true`): `per-vu-iterations` with 1 VU and 1 iteration — used for
 *   quick validation that the script runs without errors.
 * - **Load mode**: `ramping-arrival-rate` that ramps from 0 to `RPS_PER_SCENARIO` over 2 minutes,
 *   then holds for `SUSTAINED_DURATION`. Pre-allocates `RPS_PER_SCENARIO` VUs (sufficient at
 *   low latency) and caps at `4×` to absorb slow routes without exhausting node resources.
 *
 * @param exec - Name of the exported function to run as the scenario body.
 */
export function makeScenario(exec: string): ScenarioConfig {
    if (SMOKE) {
        return { executor: "per-vu-iterations", vus: 1, iterations: 1, exec };
    }
    return {
        executor: "ramping-arrival-rate",
        startRate: 0,
        timeUnit: "1s",
        preAllocatedVUs: RPS_PER_SCENARIO,
        maxVUs: RPS_PER_SCENARIO * 4,
        stages: [
            { duration: "2m", target: RPS_PER_SCENARIO },
            { duration: SUSTAINED_DURATION, target: RPS_PER_SCENARIO },
        ],
        exec,
    };
}

/**
 * k6 teardown hook. In smoke mode, sleeps for 30 seconds to allow
 * the OTEL exporter to flush all buffered metrics before the process exits.
 */
export function teardown(): void {
    if (SMOKE) sleep(30);
}
