import { sleep } from "k6";
import { BASE, CPF_POOL, FAKE_AUTH, SMOKE, call, makeScenario, randomItem, weightedPick } from "./lib.ts";

export const options = {
    scenarios: { rmi: makeScenario("default") },
    thresholds: {
        http_req_duration: ["p(95)<2000"],
        http_req_failed: ["rate<0.05"],
    },
};

export default function(): void {
    const choice = weightedPick([
        { weight: 20, value: "ethnicity" },
        { weight: 15, value: "gender" },
        { weight: 15, value: "disability" },
        { weight: 15, value: "education" },
        { weight: 10, value: "family_income" },
        { weight: 25, value: "citizen_cpf" },
    ]);

    const base = BASE.rmi;

    switch (choice) {
        case "ethnicity":
            call("rmi", "GET", `${base}/v1/citizen/ethnicity/options`, null, FAKE_AUTH);
            break;
        case "gender":
            call("rmi", "GET", `${base}/v1/citizen/gender/options`, null, FAKE_AUTH);
            break;
        case "disability":
            call("rmi", "GET", `${base}/v1/citizen/disability/options`, null, FAKE_AUTH);
            break;
        case "education":
            call("rmi", "GET", `${base}/v1/citizen/education/options`, null, FAKE_AUTH);
            break;
        case "family_income":
            call("rmi", "GET", `${base}/v1/citizen/family-income/options`, null, FAKE_AUTH);
            break;
        case "citizen_cpf":
            call("rmi", "GET", `${base}/v1/citizen/${randomItem(CPF_POOL)}`, null, FAKE_AUTH);
            break;
    }
}

export function teardown(): void {
    if (SMOKE) sleep(30);
}
