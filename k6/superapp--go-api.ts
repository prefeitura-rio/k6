import http from "k6/http";
import { sleep } from "k6";
import { BASE, FAKE_AUTH, SMOKE, call, makeScenario, randomItem, weightedPick } from "./lib.ts";

http.setResponseCallback(http.expectedStatuses({ min: 200, max: 302 }, 401, 403, 404));

export const options = {
    scenarios: { go_api: makeScenario("default") },
    thresholds: {
        http_req_duration: ["p(95)<2000"],
        http_req_failed: ["rate<0.05"],
    },
};

type SetupData = { vagaIds: string[] };

export function setup(): SetupData {
    const vagaIds: string[] = [];
    const res = http.get(`${BASE.go}/api/public/empregabilidade/vagas`, {
        tags: { service: "go_setup" },
    });
    if (res.status === 200) {
        try {
            const body = JSON.parse(res.body as string) as { data?: { id?: string }[] };
            for (const v of body.data ?? []) {
                if (v.id) vagaIds.push(v.id);
            }
        } catch { }
    }
    return { vagaIds };
}

export default function(data: SetupData): void {
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
            const ids = data.vagaIds.length > 0 ? data.vagaIds : null;
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

export function teardown(): void {
    if (SMOKE) sleep(30);
}
