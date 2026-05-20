import http from "k6/http";
import { sleep } from "k6";
import { BASE, SMOKE, call, makeScenario, randomItem, weightedPick } from "./lib.js";

http.setResponseCallback(http.expectedStatuses(
    { min: 200, max: 302 }, 401, 403, 404
));

const BUSCA_TERMS = [
    "habite-se", "IPTU", "creche", "vacina", "alvará", "CND", "CTPS",
    "habilitação", "passaporte", "certidão", "INSS", "BPC", "Bolsa Família",
    "consulta médica", "remédio", "escola", "matrícula", "transporte escolar",
    "coleta de lixo", "iluminação pública", "buraco na rua", "licença",
    "cadastro único", "auxílio emergencial", "habitação popular", "regularização",
    "MEI", "microempreendedor", "nota fiscal", "ISS", "IPTU lote",
];

export const options = {
    scenarios: { busca: makeScenario("default") },
    thresholds: {
        http_req_duration:                  ["p(95)<2000"],
        http_req_failed:                    ["rate<0.05"],
        "http_req_duration{service:busca}": ["p(95)<1000"],
    },
};

export function setup() {
    const buscaIds = [];
    const res = http.get(
        `${BASE.busca}/api/v1/search?q=sa%C3%BAde&type=keyword&per_page=20`,
        { tags: { service: "busca_setup" } }
    );
    if (res.status === 200) {
        try {
            const body = JSON.parse(res.body);
            for (const item of (body.results || [])) {
                if (item.id) buscaIds.push(item.id);
            }
        } catch (_) { }
    }
    return { buscaIds };
}

export default function (data) {
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
        case "categories":
            call("busca", "GET", `${base}/api/v1/categories`);
            break;
        case "search_v2": {
            const q = encodeURIComponent(randomItem(BUSCA_TERMS));
            // semantic returns 500 server-side (Vertex AI text-embedding-004 unavailable in staging)
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

export function teardown() {
    if (SMOKE) sleep(30);
}
