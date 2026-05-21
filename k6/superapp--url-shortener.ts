import http from "k6/http";
import {
    BASE_THRESHOLDS,
    SYSTEM_TAGS,
    call,
    makeScenario,
    randomItem,
    setDefaultResponseCallback,
    teardown,
    weightedPick,
} from "./lib.ts";

setDefaultResponseCallback();

/** Base URL for the URL Shortener service, overridable via environment variable. */
const BASE_URL =
    __ENV["BASE_URL_URL_SHORTENER"] ?? "http://url-shortener.url-shortener.svc.cluster.local";

/**
 * API token for the URL Shortener service, injected at submit time from the cluster's
 * `url-shortener-api-auth` AuthorizationPolicy. Produces an empty object (no header)
 * when absent, which will be rejected by Istio with 403.
 */
const URL_SHORTENER_AUTH = __ENV["URL_SHORTENER_API_TOKEN"]
    ? { headers: { Authorization: __ENV["URL_SHORTENER_API_TOKEN"] } }
    : {};

/** k6 options exported for the test runner. */
export const options = {
    scenarios: { url_shortener: makeScenario("default") },
    systemTags: SYSTEM_TAGS,
    thresholds: { ...BASE_THRESHOLDS },
};

/**
 * Weighted route table. Weights are relative — they do not need to sum to 100.
 * - `list`: paginated listing of shortened URLs.
 * - `create`: creates a new shortened URL and captures the `id` and `short_path` for reuse.
 * - `redirect`: follows a short path to its destination; prefers paths seeded by `setup`,
 *   falls back to paths captured during the run, then falls back to a list request.
 * - `get_by_id`: fetches a URL record by ID; falls back to a list request when no IDs
 *   have been captured yet.
 */
const ROUTES = [
    { weight: 35, value: "list" },
    { weight: 30, value: "create" },
    { weight: 20, value: "redirect" },
    { weight: 15, value: "get_by_id" },
] as const;

/**
 * IDs of URLs created during the run. Local to each VU isolate — k6 does not share
 * module-level arrays across VUs. Capped at `MAX_CAPTURED` to bound memory growth per isolate.
 */
const capturedIds: string[] = [];

/**
 * Short paths of URLs created during the run. Local to each VU isolate.
 * Used as a fallback pool for `redirect` when setup returned no results.
 */
const capturedShortPaths: string[] = [];

/** Maximum number of IDs and short paths to retain per VU isolate. */
const MAX_CAPTURED = 20;

/** Data produced by `setup` and passed to each VU iteration. */
type SetupData = { shortPaths: string[] };

/**
 * Fetches the first 50 existing short paths to seed the redirect pool.
 * If the request fails or returns no results, `redirect` iterations will fall back
 * to `capturedShortPaths` populated during the run, then to a list request.
 */
export function setup(): SetupData {
    const shortPaths: string[] = [];
    const res = http.get(`${BASE_URL}/api/urls?page=1&limit=50`, {
        tags: { service: "url_shortener_setup" },
        ...URL_SHORTENER_AUTH,
    });
    if (res.status === 200) {
        try {
            const body = JSON.parse(res.body as string) as { urls?: { short_path?: string }[] };
            for (const u of body.urls ?? []) {
                if (u.short_path) shortPaths.push(u.short_path);
            }
        } catch (e) {
            console.warn(`[url_shortener setup] failed to parse response: ${e}`);
        }
    }
    return { shortPaths };
}

/**
 * Main VU function. Picks a route via weighted random selection and fires the
 * corresponding HTTP request. Created URLs are captured for reuse by `redirect`
 * and `get_by_id` in subsequent iterations.
 */
export default function (data: SetupData): void {
    const choice = weightedPick([...ROUTES]);

    switch (choice) {
        case "list": {
            const page = Math.floor(Math.random() * 5) + 1;
            call(
                "url_shortener",
                "GET",
                `${BASE_URL}/api/urls?page=${page}&limit=20`,
                null,
                URL_SHORTENER_AUTH,
            );
            break;
        }
        case "create": {
            const slug = Math.random().toString(36).substring(2, 10);
            const res = call(
                "url_shortener",
                "POST",
                `${BASE_URL}/api/urls`,
                JSON.stringify({
                    destination: `https://prefeitura.rio/servicos/${slug}`,
                    title: `Serviço ${slug}`,
                }),
                URL_SHORTENER_AUTH,
            );
            if (res.status === 201 && capturedIds.length < MAX_CAPTURED) {
                try {
                    const json = JSON.parse(res.body as string) as {
                        id?: string;
                        short_path?: string;
                    };
                    if (json.id) capturedIds.push(json.id);
                    if (json.short_path) capturedShortPaths.push(json.short_path);
                } catch (e) {
                    console.warn(`[url_shortener create] failed to parse response: ${e}`);
                }
            }
            break;
        }
        case "redirect": {
            const pool = data.shortPaths.length > 0 ? data.shortPaths : capturedShortPaths;
            call(
                "url_shortener",
                "GET",
                pool.length > 0
                    ? `${BASE_URL}/${randomItem(pool)}`
                    : `${BASE_URL}/api/urls?page=1&limit=20`,
                null,
                pool.length > 0 ? { tags: { name: "/:short_path" } } : URL_SHORTENER_AUTH,
            );
            break;
        }
        case "get_by_id":
            call(
                "url_shortener",
                "GET",
                capturedIds.length > 0
                    ? `${BASE_URL}/api/urls/${randomItem(capturedIds)}`
                    : `${BASE_URL}/api/urls?page=1&limit=20`,
                null,
                capturedIds.length > 0
                    ? { ...URL_SHORTENER_AUTH, tags: { name: "/api/urls/:id" } }
                    : URL_SHORTENER_AUTH,
            );
            break;
    }
}

export { teardown };
