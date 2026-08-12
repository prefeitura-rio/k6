import http from "k6/http";
import {
    BASE_THRESHOLDS,
    CPF_POOL,
    SYSTEM_TAGS,
    call,
    makeScenario,
    randomItem,
    setDefaultResponseCallback,
    teardown,
    weightedPick,
} from "./lib.ts";

setDefaultResponseCallback();

/** Internal cluster URL for the staging PostgREST service. Override via `BASE_URL`. */
const BASE_URL = __ENV["BASE_URL"]
    ?? "http://data-proxy-postgrest.data-proxy-staging.svc.cluster.local:3000";

/** Keycloak token endpoint. Override via `OIDC_TOKEN_URL`. */
const OIDC_TOKEN_URL = __ENV["OIDC_TOKEN_URL"]
    ?? "https://auth-idriohom.apps.rio.gov.br/auth/realms/idrio_cidadao/protocol/openid-connect/token";

/** OIDC client ID. Override via `OIDC_CLIENT_ID`. */
const OIDC_CLIENT_ID = __ENV["OIDC_CLIENT_ID"] ?? "app-pic";

/**
 * OIDC client secret. Must be supplied via `OIDC_CLIENT_SECRET` — injected from a
 * Kubernetes Secret via `secretKeyRef` in the TestRun manifest. Never set a default here.
 */
const OIDC_CLIENT_SECRET = __ENV["OIDC_CLIENT_SECRET"] ?? "";

/** k6 options exported for the test runner. */
export const options = {
    scenarios: { postgrest: makeScenario("default") },
    systemTags: SYSTEM_TAGS,
    thresholds: {
        ...BASE_THRESHOLDS,
        "http_req_duration{service:data-proxy}": ["p(95)<500"],
    },
};

/**
 * Weighted route table. Weights are relative — they do not need to sum to 100.
 * - `cpf_lookup`: primary use case — index lookup by CPF on `protocolo_detalhes`.
 * - `paginated_scan`: secondary — paginated full scan with random offset.
 * - `rls_table`: RLS path — `endpoint_participante_visao_geral` filtered by `dp_row_access`.
 * - `small_table`: small table — `endpoint_data_access`, 12 rows, no RLS.
 */
const ROUTES = [
    { weight: 60, value: "cpf_lookup" },
    { weight: 20, value: "paginated_scan" },
    { weight: 15, value: "rls_table" },
    { weight: 5,  value: "small_table" },
] as const;

/** Data produced by `setup` and passed to each VU iteration. */
type SetupData = { token: string };

/**
 * Fetches an OAuth2 access token via `client_credentials` grant once before VUs start.
 * The token is shared across all iterations. Token lifetime must exceed the test duration
 * (Keycloak default is 300 s — sufficient for a 5-minute load test).
 */
export function setup(): SetupData {
    const res = http.post(
        OIDC_TOKEN_URL,
        `grant_type=client_credentials&client_id=${OIDC_CLIENT_ID}&client_secret=${OIDC_CLIENT_SECRET}`,
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );
    const body = JSON.parse(res.body as string) as { access_token: string };
    return { token: body.access_token };
}

/**
 * Main VU function. Picks a route via weighted random selection and fires the
 * corresponding authenticated GET request against the PostgREST API.
 */
export default function(data: SetupData): void {
    const auth = { headers: { Authorization: `Bearer ${data.token}` } };
    const offset = Math.floor(Math.random() * 200) * 10;

    switch (weightedPick([...ROUTES])) {
        case "cpf_lookup":
            call(
                "data-proxy",
                "GET",
                `${BASE_URL}/protocolo_detalhes?cpf=eq.${randomItem(CPF_POOL)}`,
                null,
                { ...auth, tags: { name: "/protocolo_detalhes?cpf=eq.:cpf" } },
            );
            break;
        case "paginated_scan":
            call(
                "data-proxy",
                "GET",
                `${BASE_URL}/protocolo_detalhes?limit=10&offset=${offset}`,
                null,
                { ...auth, tags: { name: "/protocolo_detalhes?limit=10" } },
            );
            break;
        case "rls_table":
            call(
                "data-proxy",
                "GET",
                `${BASE_URL}/endpoint_participante_visao_geral?limit=10`,
                null,
                auth,
            );
            break;
        case "small_table":
            call(
                "data-proxy",
                "GET",
                `${BASE_URL}/endpoint_data_access?limit=10`,
                null,
                auth,
            );
            break;
    }
}

export { teardown };
