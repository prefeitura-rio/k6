import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import { SYSTEM_TAGS, SMOKE } from "./lib.ts";

const AGENT_ID = __ENV["AGENT_ID"] ?? "";
const TOKEN_URL = __ENV["SF_TOKEN_URL"] ?? "";
const ORG_ENDPOINT = __ENV["SF_ORG_ENDPOINT"] ?? "";
const AGENT_API_BASE = (__ENV["AGENT_API_BASE"] ?? "").replace(/\/+$/, "");
const CLIENT_ID = __ENV["SF_CLIENT_ID"] ?? "";
const CLIENT_SECRET = __ENV["SF_CLIENT_SECRET"] ?? "";
const THINK_TIME_SECONDS = Number(__ENV["THINK_TIME_SECONDS"] ?? "5");
const SESSION_COOLDOWN_SECONDS = Number(__ENV["SESSION_COOLDOWN_SECONDS"] ?? "0");
const NO_ACTION_PROFILE = __ENV["AGENT_PROFILE"] === "no_action";
const ACTIONS_PER_TURN_MIN = 1;
const ACTIONS_PER_TURN_ESTIMATE = 1.25;
const ACTIONS_PER_TURN_MAX = 1.5;
const DEFAULT_MESSAGES = [
    "Oi! Estou no Rock in Rio. O que você pode me ajudar a encontrar?",
    "Quais informações sobre o festival você tem?",
];
const NO_ACTION_MESSAGES = [
    "Oi!",
    "Quem é você e como você pode me ajudar?",
    "Obrigado, até mais!",
];

export const sessionCreateDuration = new Trend("agent_session_create_duration", true);
export const turnDuration = new Trend("agent_turn_duration", true);
export const sessionEndDuration = new Trend("agent_session_end_duration", true);
export const turnCompleted = new Rate("agent_turn_completed");
export const observedResultItems = new Counter("agent_observed_result_items");
export const estimatedActionsMin = new Counter("agent_estimated_actions_min");
export const estimatedActions = new Counter("agent_estimated_actions");
export const estimatedActionsMax = new Counter("agent_estimated_actions_max");

export const options = {
    scenarios: {
        agentforce: SMOKE
            ? {
                  executor: "per-vu-iterations",
                  vus: 1,
                  iterations: 1,
                  exec: "default",
              }
            : {
                  executor: "ramping-vus",
                  startVUs: 0,
                  stages: [
                      {
                          duration: __ENV["RAMP_DURATION"] ?? "5m",
                          target: Number(__ENV["CONCURRENT_VUS"] ?? "1"),
                      },
                      {
                          duration: __ENV["HOLD_DURATION"] ?? "10m",
                          target: Number(__ENV["CONCURRENT_VUS"] ?? "1"),
                      },
                      { duration: __ENV["RAMP_DURATION"] ?? "5m", target: 0 },
                  ],
                  gracefulRampDown: "30s",
                  gracefulStop: "30s",
                  exec: "default",
              },
    },
    systemTags: SYSTEM_TAGS,
    thresholds: SMOKE
        ? {}
        : {
              http_req_failed: ["rate<0.01"],
              agent_turn_completed: ["rate>0.99"],
              agent_turn_duration: ["p(95)<30000"],
          },
};

type JsonObject = { readonly [key: string]: unknown };

function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(body: string): JsonObject | null {
    try {
        const value: unknown = JSON.parse(body);
        return isJsonObject(value) ? value : null;
    } catch (error) {
        if (error instanceof SyntaxError) return null;
        throw error;
    }
}

function messages(): readonly string[] {
    const raw = __ENV["AGENT_MESSAGES_JSON"];
    if (!raw) return NO_ACTION_PROFILE ? NO_ACTION_MESSAGES : DEFAULT_MESSAGES;
    const parsed: unknown = JSON.parse(raw);
    if (
        !Array.isArray(parsed) ||
        parsed.length === 0 ||
        !parsed.every((item) => typeof item === "string")
    ) {
        throw new Error("AGENT_MESSAGES_JSON must be a non-empty string array");
    }
    return parsed;
}

function authHeaders(token: string): Record<string, string> {
    return {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
    };
}

function getAccessToken(): string {
    const body =
        `grant_type=client_credentials&client_id=${encodeURIComponent(CLIENT_ID)}` +
        `&client_secret=${encodeURIComponent(CLIENT_SECRET)}`;
    const response = http.post(TOKEN_URL, body, {
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
        },
        tags: { service: "sf", operation: "oauth_token" },
    });
    const payload = parseJson(response.body ?? "");
    const token = payload?.["access_token"];
    if (response.status !== 200 || typeof token !== "string" || token.length === 0) {
        throw new Error(`Agentforce OAuth failed with HTTP ${response.status}`);
    }
    return token;
}

export function setup(): { readonly accessToken: string } {
    if (
        !TOKEN_URL ||
        !ORG_ENDPOINT ||
        !AGENT_API_BASE ||
        !AGENT_ID ||
        !CLIENT_ID ||
        !CLIENT_SECRET
    ) {
        throw new Error(
            "Agentforce endpoint, Agent ID, and credential environment variables are required",
        );
    }
    return { accessToken: getAccessToken() };
}

function startSession(token: string, externalSessionKey: string): string {
    const variables = __ENV["ROUTABLE_ID"]
        ? [{ name: "RoutableId", type: "Text", value: __ENV["ROUTABLE_ID"] }]
        : [];
    const startedAt = Date.now();
    const response = http.post(
        `${AGENT_API_BASE}/agents/${AGENT_ID}/sessions`,
        JSON.stringify({
            externalSessionKey,
            instanceConfig: { endpoint: ORG_ENDPOINT },
            streamingCapabilities: { chunkTypes: ["Text"] },
            bypassUser: true,
            variables,
        }),
        {
            headers: authHeaders(token),
            tags: { service: "sf", operation: "session_create" },
            timeout: "130s",
        },
    );
    sessionCreateDuration.add(Date.now() - startedAt);
    const payload = parseJson(response.body ?? "");
    const sessionId = payload?.["sessionId"];
    check(response, {
        "Agentforce session created": (res) => res.status === 201 || res.status === 200,
    });
    if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new Error(`Agentforce session creation failed with HTTP ${response.status}`);
    }
    return sessionId;
}

function sendMessage(token: string, sessionId: string, sequenceId: number, text: string): void {
    const startedAt = Date.now();
    const response = http.post(
        `${AGENT_API_BASE}/sessions/${sessionId}/messages`,
        JSON.stringify({ message: { sequenceId, type: "Text", text } }),
        {
            headers: { ...authHeaders(token), Accept: "application/json" },
            tags: { service: "sf", operation: "message" },
            timeout: "130s",
        },
    );
    turnDuration.add(Date.now() - startedAt);
    const payload = parseJson(response.body ?? "");
    estimatedActionsMin.add(NO_ACTION_PROFILE ? 0 : ACTIONS_PER_TURN_MIN);
    estimatedActions.add(NO_ACTION_PROFILE ? 0 : ACTIONS_PER_TURN_ESTIMATE);
    estimatedActionsMax.add(NO_ACTION_PROFILE ? 0 : ACTIONS_PER_TURN_MAX);
    const responseMessages = payload?.["messages"];
    const hasMessages = Array.isArray(responseMessages) && responseMessages.length > 0;
    const resultItems = Array.isArray(responseMessages)
        ? responseMessages.reduce(
              (count, item) =>
                  isJsonObject(item) && Array.isArray(item["result"])
                      ? count + item["result"].length
                      : count,
              0,
          )
        : 0;
    observedResultItems.add(resultItems);
    const succeeded = response.status === 200 && hasMessages;
    check(response, {
        "Agentforce message returned HTTP 200": (res) => res.status === 200,
    });
    check(responseMessages, { "Agentforce returned messages": () => hasMessages });
    check(responseMessages, {
        "no-action profile returned no result items": () =>
            !NO_ACTION_PROFILE || resultItems === 0,
    });
    turnCompleted.add(succeeded);
}

function endSession(token: string, sessionId: string): void {
    const startedAt = Date.now();
    const response = http.del(`${AGENT_API_BASE}/sessions/${sessionId}`, null, {
        headers: { ...authHeaders(token), "x-session-end-reason": "UserRequest" },
        tags: { service: "sf", operation: "session_end" },
        timeout: "130s",
    });
    sessionEndDuration.add(Date.now() - startedAt);
    check(response, {
        "Agentforce session ended": (res) => res.status >= 200 && res.status < 300,
    });
}

export default function (data: { readonly accessToken: string }): void {
    if (__ITER === 0 && !SMOKE) {
        sleep(Math.random() * 30);
    }
    const sessionId = startSession(data.accessToken, `k6-${__VU}-${__ITER}-${Date.now()}`);
    const promptSequence = messages();
    promptSequence.forEach((text, index) => {
        sendMessage(data.accessToken, sessionId, index + 1, text);
        if (index < promptSequence.length - 1) sleep(THINK_TIME_SECONDS);
    });
    endSession(data.accessToken, sessionId);
    if (SESSION_COOLDOWN_SECONDS > 0) sleep(SESSION_COOLDOWN_SECONDS);
}
