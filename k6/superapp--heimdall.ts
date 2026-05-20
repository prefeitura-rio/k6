import { sleep } from "k6";
import { BASE, FAKE_AUTH, SMOKE, call, makeScenario } from "./lib.ts";

export const options = {
    scenarios: { heimdall: makeScenario("default") },
    thresholds: {
        http_req_duration: ["p(95)<2000"],
        http_req_failed: ["rate<0.05"],
    },
};

export default function(): void {
    const base = BASE.heimdall;
    if (Math.random() < 0.5) {
        call("heimdall", "GET", `${base}/api/v1/users/`, null, FAKE_AUTH);
    } else {
        call("heimdall", "GET", `${base}/api/v1/groups/`, null, FAKE_AUTH);
    }
}

export function teardown(): void {
    if (SMOKE) sleep(30);
}
