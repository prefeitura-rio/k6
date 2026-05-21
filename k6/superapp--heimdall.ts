import {
    BASE_THRESHOLDS,
    FAKE_AUTH,
    SYSTEM_TAGS,
    call,
    makeScenario,
    setDefaultResponseCallback,
    teardown,
    weightedPick,
} from "./lib.ts";

setDefaultResponseCallback();

/** Base URL for the Heimdall admin service, overridable via environment variable. */
const BASE_URL = __ENV["BASE_URL_HEIMDALL"] ?? "http://heimdall-admin.heimdall.svc.cluster.local";

/** k6 options exported for the test runner. */
export const options = {
    scenarios: { heimdall: makeScenario("default") },
    systemTags: SYSTEM_TAGS,
    thresholds: { ...BASE_THRESHOLDS },
};

/**
 * Weighted route table. Both routes carry equal weight, producing an even
 * split between user and group listing requests.
 */
const ROUTES = [
    { weight: 1, value: "users" },
    { weight: 1, value: "groups" },
] as const;

/**
 * Main VU function. Picks a route via weighted random selection and fires the
 * corresponding admin endpoint with an invalid token to exercise the auth path.
 */
export default function(): void {
    const choice = weightedPick([...ROUTES]);

    switch (choice) {
        case "users":
            call("heimdall", "GET", `${BASE_URL}/api/v1/users`, null, FAKE_AUTH);
            break;
        case "groups":
            call("heimdall", "GET", `${BASE_URL}/api/v1/groups`, null, FAKE_AUTH);
            break;
    }
}

export { teardown };
