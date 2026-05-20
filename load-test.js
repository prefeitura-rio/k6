import http from "k6/http";
import { sleep } from "k6";
import { SMOKE, makeScenario } from "./scripts/lib.js";
import { setup as buscaSetup, default as buscaScenario } from "./scripts/superapp--busca.js";
import { setup as goApiSetup, default as goApiScenario } from "./scripts/superapp--go-api.js";
import { default as rmiScenario } from "./scripts/superapp--rmi.js";
import { setup as urlShortenerSetup, default as urlShortenerScenario } from "./scripts/superapp--url-shortener.js";
import { default as heimdallScenario } from "./scripts/superapp--heimdall.js";

http.setResponseCallback(http.expectedStatuses(
    { min: 200, max: 302 }, 401, 403, 404
));

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

export function setup() {
    const busca        = buscaSetup();
    const goApi        = goApiSetup();
    const urlShortener = urlShortenerSetup();
    console.log(`setup: seeded ${busca.buscaIds.length} busca IDs, ${urlShortener.shortPaths.length} short paths, ${goApi.vagaIds.length} vaga IDs`);
    return { ...busca, ...goApi, ...urlShortener };
}

export { buscaScenario, goApiScenario, rmiScenario, urlShortenerScenario, heimdallScenario };

export function teardown() {
    if (SMOKE) sleep(30);
}
