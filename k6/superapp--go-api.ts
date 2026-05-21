import http from "k6/http";
import {
    BASE_THRESHOLDS,
    FAKE_AUTH,
    SYSTEM_TAGS,
    call,
    makeScenario,
    randomItem,
    setDefaultResponseCallback,
    teardown,
    weightedPick,
} from "./lib.ts";

setDefaultResponseCallback();

/** Base URL for the Go API service, overridable via environment variable. */
const BASE_URL = __ENV["BASE_URL_GO"] ?? "http://go.go.svc.cluster.local";

/** k6 options exported for the test runner. */
export const options = {
    scenarios: { go_api: makeScenario("default") },
    systemTags: SYSTEM_TAGS,
    thresholds: { ...BASE_THRESHOLDS },
};

/**
 * Weighted route table. Weights are relative — they do not need to sum to 100.
 * - `public_vagas` / `public_vaga_id`: unauthenticated listing and detail endpoints.
 * - `auth_courses` / `auth_vagas` / `auth_categorias`: authenticated endpoints hit with an
 *   invalid token to exercise the auth-rejection path.
 */
const ROUTES = [
    { weight: 25, value: "public_vagas" },
    { weight: 15, value: "public_vaga_id" },
    { weight: 20, value: "auth_courses" },
    { weight: 20, value: "auth_vagas" },
    { weight: 20, value: "auth_categorias" },
] as const;

/** Data produced by `setup` and passed to each VU iteration. */
type SetupData = { vagaIds: string[] };

/**
 * Fetches the first page of public job listings to seed `vagaIds`.
 * If the request fails or returns no results, `vagaIds` will be empty and
 * `public_vaga_id` iterations will fall back to the listing endpoint.
 */
export function setup(): SetupData {
    const vagaIds: string[] = [];
    const res = http.get(`${BASE_URL}/api/public/empregabilidade/vagas`, {
        tags: { service: "go_api_setup" },
    });
    if (res.status === 200) {
        try {
            const body = JSON.parse(res.body as string) as { data?: { id?: string }[] };
            for (const v of body.data ?? []) {
                if (v.id) vagaIds.push(v.id);
            }
        } catch (e) {
            console.warn(`[go_api setup] failed to parse response: ${e}`);
        }
    }
    return { vagaIds };
}

/**
 * Main VU function. Picks a route via weighted random selection and fires the
 * corresponding HTTP request. Authenticated routes use `FAKE_AUTH` to exercise
 * the 401/403 path without requiring real credentials.
 */
export default function(data: SetupData): void {
    const choice = weightedPick([...ROUTES]);

    switch (choice) {
        case "public_vagas":
            call("go_api", "GET", `${BASE_URL}/api/public/empregabilidade/vagas`);
            break;
        case "public_vaga_id":
            call(
                "go_api",
                "GET",
                data.vagaIds.length > 0
                    ? `${BASE_URL}/api/public/empregabilidade/vagas/${randomItem(data.vagaIds)}`
                    : `${BASE_URL}/api/public/empregabilidade/vagas`,
                null,
                data.vagaIds.length > 0
                    ? { tags: { name: "/api/public/empregabilidade/vagas/:id" } }
                    : {},
            );
            break;
        case "auth_courses":
            call("go_api", "GET", `${BASE_URL}/api/v1/courses`, null, FAKE_AUTH);
            break;
        case "auth_vagas":
            call("go_api", "GET", `${BASE_URL}/api/v1/empregabilidade/vagas`, null, FAKE_AUTH);
            break;
        case "auth_categorias":
            call("go_api", "GET", `${BASE_URL}/api/v1/categorias`, null, FAKE_AUTH);
            break;
    }
}

export { teardown };
