import http from "k6/http";
import { sleep } from "k6";
import { BASE, SMOKE, URL_SHORTENER_AUTH, call, makeScenario, randomItem, weightedPick } from "./lib.js";

http.setResponseCallback(http.expectedStatuses(
    { min: 200, max: 302 }, 401, 403, 404
));

// Two separate capture arrays: UUIDs for /api/urls/{id}, short_paths for public redirects.
const capturedUrlUUIDs      = [];
const capturedUrlShortPaths = [];
const MAX_CAPTURED          = 100;

export const options = {
    scenarios: { url_shortener: makeScenario("default") },
    thresholds: {
        http_req_duration: ["p(95)<2000"],
        http_req_failed:   ["rate<0.05"],
    },
};

export function setup() {
    const shortPaths = [];
    const res = http.get(
        `${BASE.urlShortener}/api/urls?page=1&limit=50`,
        { tags: { service: "url_shortener_setup" }, headers: URL_SHORTENER_AUTH.headers }
    );
    if (res.status === 200) {
        try {
            const body = JSON.parse(res.body);
            for (const u of (body.urls || [])) {
                if (u.short_path) shortPaths.push(u.short_path);
            }
        } catch (_) { }
    }
    return { shortPaths };
}

export default function (data) {
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
            const pool = (data && data.shortPaths && data.shortPaths.length > 0)
                ? data.shortPaths
                : capturedUrlShortPaths;
            if (pool.length > 0) {
                call("url_shortener", "GET", `${base}/${randomItem(pool)}`);
            } else {
                call("url_shortener", "GET", `${base}/api/urls?page=1&limit=20`, null, URL_SHORTENER_AUTH);
            }
            break;
        }
        case "get_by_id": {
            if (capturedUrlUUIDs.length > 0) {
                call("url_shortener", "GET", `${base}/api/urls/${randomItem(capturedUrlUUIDs)}`, null, URL_SHORTENER_AUTH);
            } else {
                call("url_shortener", "GET", `${base}/api/urls?page=1&limit=20`, null, URL_SHORTENER_AUTH);
            }
            break;
        }
    }
}

export function teardown() {
    if (SMOKE) sleep(30);
}
