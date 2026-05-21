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

/** Base URL for the Busca service, overridable via environment variable. */
const BASE_URL = __ENV["BASE_URL_BUSCA"] ?? "http://app-busca-search.busca.svc.cluster.local:8080";

/** k6 options exported for the test runner. */
export const options = {
    scenarios: { busca: makeScenario("default") },
    systemTags: SYSTEM_TAGS,
    thresholds: {
        ...BASE_THRESHOLDS,
        "http_req_duration{service:busca}": ["p(95)<1000"],
    },
};

/**
 * Representative civic search terms covering a range of public services.
 * Drawn randomly to simulate realistic query diversity.
 */
const SEARCH_TERMS = [
    "habite-se",
    "IPTU",
    "creche",
    "vacina",
    "alvará",
    "CND",
    "CTPS",
    "habilitação",
    "passaporte",
    "certidão",
    "INSS",
    "BPC",
    "Bolsa Família",
    "consulta médica",
    "remédio",
    "escola",
    "matrícula",
    "transporte escolar",
    "coleta de lixo",
    "iluminação pública",
    "buraco na rua",
    "licença",
    "cadastro único",
    "auxílio emergencial",
    "habitação popular",
    "regularização",
    "MEI",
    "microempreendedor",
    "nota fiscal",
    "ISS",
    "IPTU lote",
] as const;

/** Available search types accepted by the v2 search endpoint. */
const SEARCH_TYPES = ["keyword", "hybrid"] as const;

/**
 * Weighted route table. Weights are relative — they do not need to sum to 100.
 * - `search_v1`: keyword-only search on the stable v1 endpoint (highest weight).
 * - `search_v2`: keyword or hybrid search on the v2 endpoint.
 * - `categories`: static category listing; lightweight.
 * - `search_by_id`: fetches a specific result by ID seeded from `setup`; falls back
 *   to categories when no IDs are available.
 */
const ROUTES = [
    { weight: 45, value: "search_v1" },
    { weight: 20, value: "categories" },
    { weight: 20, value: "search_v2" },
    { weight: 15, value: "search_by_id" },
] as const;

/** Data produced by `setup` and passed to each VU iteration. */
type SetupData = { buscaIds: string[] };

/**
 * Seeds `buscaIds` by running a search for "saúde" on the v1 endpoint.
 * If the request fails or returns no results, `buscaIds` will be empty and
 * `search_by_id` iterations will fall back to the categories endpoint.
 */
export function setup(): SetupData {
    const buscaIds: string[] = [];
    const res = http.get(`${BASE_URL}/api/v1/search?q=sa%C3%BAde&type=keyword&per_page=20`, {
        tags: { service: "busca_setup" },
    });
    if (res.status === 200) {
        try {
            const body = JSON.parse(res.body as string) as { results?: { id?: string }[] };
            for (const item of body.results ?? []) {
                if (item.id) buscaIds.push(item.id);
            }
        } catch (e) {
            console.warn(`[busca setup] failed to parse response: ${e}`);
        }
    }
    return { buscaIds };
}

/**
 * Main VU function. Picks a route via weighted random selection and fires the
 * corresponding search or category request. Search terms and types are drawn
 * randomly from their respective pools on each iteration.
 */
export default function(data: SetupData): void {
    const choice = weightedPick([...ROUTES]);

    switch (choice) {
        case "search_v1":
            call(
                "busca",
                "GET",
                `${BASE_URL}/api/v1/search?q=${encodeURIComponent(randomItem(SEARCH_TERMS))}&type=keyword&per_page=10`,
            );
            break;
        case "categories":
            call("busca", "GET", `${BASE_URL}/api/v1/categories`);
            break;
        case "search_v2":
            call(
                "busca",
                "GET",
                `${BASE_URL}/api/v2/search?q=${encodeURIComponent(randomItem(SEARCH_TERMS))}&type=${randomItem([...SEARCH_TYPES])}&per_page=10`,
            );
            break;
        case "search_by_id":
            call(
                "busca",
                "GET",
                data.buscaIds.length > 0
                    ? `${BASE_URL}/api/v1/search/${encodeURIComponent(randomItem(data.buscaIds))}`
                    : `${BASE_URL}/api/v1/categories`,
                null,
                data.buscaIds.length > 0 ? { tags: { name: "/api/v1/search/:id" } } : {},
            );
            break;
    }
}

export { teardown };
