import {
    BASE_THRESHOLDS,
    CPF_POOL,
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

/** Base URL for the RMI service, overridable via environment variable. */
const BASE_URL = __ENV["BASE_URL_RMI"] ?? "http://rmi.rmi.svc.cluster.local";

/** k6 options exported for the test runner. */
export const options = {
    scenarios: { rmi: makeScenario("default") },
    systemTags: SYSTEM_TAGS,
    thresholds: { ...BASE_THRESHOLDS },
};

/**
 * Weighted route table. Weights are relative — they do not need to sum to 100.
 * - `ethnicity` / `gender` / `disability` / `education` / `family_income`: static options
 *   endpoints backed by in-memory or cached data; respond quickly.
 * - `citizen_cpf`: MongoDB-backed lookup; can hang under load. A 5 s timeout is applied
 *   to prevent VU exhaustion when the database is slow.
 */
const ROUTES = [
    { weight: 20, value: "ethnicity" },
    { weight: 15, value: "gender" },
    { weight: 15, value: "disability" },
    { weight: 15, value: "education" },
    { weight: 10, value: "family_income" },
    { weight: 25, value: "citizen_cpf" },
] as const;

/**
 * Main VU function. Picks a route via weighted random selection and fires the
 * corresponding HTTP request using an invalid token to exercise the auth path.
 * The `citizen_cpf` route draws from the shared CPF pool and enforces a 5 s
 * per-request timeout to avoid blocking VUs on slow MongoDB queries.
 */
export default function(): void {
    const choice = weightedPick([...ROUTES]);

    switch (choice) {
        case "ethnicity":
            call("rmi", "GET", `${BASE_URL}/v1/citizen/ethnicity/options`, null, FAKE_AUTH);
            break;
        case "gender":
            call("rmi", "GET", `${BASE_URL}/v1/citizen/gender/options`, null, FAKE_AUTH);
            break;
        case "disability":
            call("rmi", "GET", `${BASE_URL}/v1/citizen/disability/options`, null, FAKE_AUTH);
            break;
        case "education":
            call("rmi", "GET", `${BASE_URL}/v1/citizen/education/options`, null, FAKE_AUTH);
            break;
        case "family_income":
            call("rmi", "GET", `${BASE_URL}/v1/citizen/family-income/options`, null, FAKE_AUTH);
            break;
        case "citizen_cpf":
            call("rmi", "GET", `${BASE_URL}/v1/citizen/${randomItem(CPF_POOL)}`, null, {
                ...FAKE_AUTH,
                tags: { name: "/v1/citizen/:cpf" },
                timeout: "5s",
            });
            break;
    }
}

export { teardown };
