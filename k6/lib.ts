import http, { RefinedResponse, ResponseType } from "k6/http";
import { check } from "k6";
import { SharedArray } from "k6/data";

export const SMOKE = __ENV["SMOKE"] === "true";
export const TARGET_RPS = parseInt(__ENV["TARGET_RPS"] ?? "75");
export const SUSTAINED_DURATION = __ENV["SUSTAINED_DURATION"] ?? "35m";
export const CPF_POOL_SIZE = parseInt(__ENV["CPF_POOL_SIZE"] ?? "7500");
export const RPS_PER_SCENARIO = Math.max(1, Math.round(TARGET_RPS / 5));

export const BASE = {
  busca: __ENV["BASE_URL_BUSCA"] ?? "http://app-busca-search.busca.svc.cluster.local:8080",
  go: __ENV["BASE_URL_GO"] ?? "http://go.go.svc.cluster.local",
  rmi: __ENV["BASE_URL_RMI"] ?? "http://rmi.rmi.svc.cluster.local",
  urlShortener:
    __ENV["BASE_URL_URL_SHORTENER"] ?? "http://url-shortener.url-shortener.svc.cluster.local",
  heimdall:
    __ENV["BASE_URL_HEIMDALL"] ?? "http://heimdall-admin.heimdall.svc.cluster.local",
};

export const FAKE_AUTH = { headers: { Authorization: "Bearer invalid" } };
export const URL_SHORTENER_AUTH = {
  headers: {
    Authorization:
      "Bearer AJAY08xP2nB9tRpiFO3GVuSPkyAy073AVI74gbdbVXvSKnFNLp5ZYQRhqvyvla1T",
  },
};

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

export function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

type Weighted<T> = { weight: number; value: T };

export function weightedPick<T>(weighted: Weighted<T>[]): T {
  const total = weighted.reduce((sum, w) => sum + w.weight, 0);
  let r = Math.random() * total;
  for (const w of weighted) {
    r -= w.weight;
    if (r <= 0) return w.value;
  }
  return (weighted[weighted.length - 1] as Weighted<T>).value;
}

type Params = {
  tags?: Record<string, string>;
  headers?: Record<string, string>;
};

export function call(
  service: string,
  method: string,
  url: string,
  body: string | null = null,
  params: Params = {},
): RefinedResponse<ResponseType> {
  const p = {
    ...params,
    tags: { service, ...params.tags },
    headers: { "Content-Type": "application/json", ...params.headers },
  };

  const m = method.toUpperCase();
  let res: RefinedResponse<ResponseType>;

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

type SmokeScenario = { executor: "per-vu-iterations"; vus: number; iterations: number; exec: string };
type LoadScenario = {
  executor: "ramping-arrival-rate";
  startRate: number;
  timeUnit: string;
  preAllocatedVUs: number;
  maxVUs: number;
  stages: { duration: string; target: number }[];
  exec: string;
};
type ScenarioConfig = SmokeScenario | LoadScenario;

export function makeScenario(exec: string): ScenarioConfig {
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
      { duration: "2m", target: RPS_PER_SCENARIO },
      { duration: SUSTAINED_DURATION, target: RPS_PER_SCENARIO },
    ],
    exec,
  };
}
