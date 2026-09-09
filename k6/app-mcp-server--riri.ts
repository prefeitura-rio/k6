import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";
import { SYSTEM_TAGS, SMOKE, teardown } from "./lib.ts";

const MCP_BASE_URL = (__ENV["MCP_BASE_URL"] ?? "").replace(/\/+$/, "");
const MCP_TOKEN = __ENV["MCP_TOKEN"] ?? "";
const MCP_URL = `${MCP_BASE_URL}/mcp`;
const CONCURRENT_VUS = Number(__ENV["CONCURRENT_VUS"] ?? "100");
const RAMP_DURATION = __ENV["RAMP_DURATION"] ?? "5m";
const HOLD_DURATION = __ENV["HOLD_DURATION"] ?? "10m";
const SESSION_COOLDOWN_SECONDS = Number(__ENV["SESSION_COOLDOWN_SECONDS"] ?? "60");
const MCP_HEADERS = {
    Authorization: `Bearer ${MCP_TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
};

export const mcpRequestDuration = new Trend("mcp_request_duration", true);
export const chatbotIterationDuration = new Trend("chatbot_iteration_duration", true);
export const chatbotWaitDuration = new Trend("chatbot_wait_duration", true);
export const chatbotTurns = new Trend("chatbot_turns");
export const chatbotCompleted = new Rate("chatbot_completed");

export const options = {
    scenarios: {
        rockInRio: SMOKE
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
                      { duration: RAMP_DURATION, target: CONCURRENT_VUS },
                      { duration: HOLD_DURATION, target: CONCURRENT_VUS },
                      { duration: RAMP_DURATION, target: 0 },
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
              mcp_request_duration: ["p(95)<2000"],
              chatbot_completed: ["rate>0.99"],
          },
};

type JsonObject = { readonly [key: string]: unknown };

function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSseData(body: string): JsonObject | null {
    const line = body.split(/\r?\n/).find((entry) => /^data:\s*/.test(entry));
    if (!line) return null;
    try {
        const parsed: unknown = JSON.parse(line.replace(/^data:\s*/, ""));
        return isJsonObject(parsed) ? parsed : null;
    } catch (error) {
        if (error instanceof SyntaxError) return null;
        throw error;
    }
}

function resultObject(envelope: JsonObject | null): JsonObject | null {
    return envelope !== null && isJsonObject(envelope["result"])
        ? envelope["result"]
        : null;
}

function postMcp(body: string, operation: string, turn: number): JsonObject | null {
    const startedAt = Date.now();
    const response = http.post(MCP_URL, body, {
        headers: MCP_HEADERS,
        tags: { service: "riri", name: operation, turn: String(turn) },
    });
    mcpRequestDuration.add(Date.now() - startedAt, { operation });
    const envelope = parseSseData(response.body ?? "");
    check(response, {
        [`${operation} returns HTTP 200`]: (res) => res.status === 200,
        [`${operation} returns SSE`]: (res) =>
            (res.headers["Content-Type"] ?? "").includes("text/event-stream"),
    });
    check(envelope, { [`${operation} contains valid SSE data`]: (value) => value !== null });
    return envelope;
}

function sampleWaitSeconds(): number {
    const roll = Math.random();
    if (roll < 0.5) return Math.random() * 6;
    if (roll < 0.95) return 6 + Math.random() * 19;
    if (roll < 0.99) return 25 + Math.random() * 21;
    return 46 + Math.random() * 44;
}

function sampleTurnCount(): number {
    return Math.random() < 0.7 ? 2 : 3;
}

function hasSuccessfulLineup(envelope: JsonObject | null): boolean {
    const result = resultObject(envelope);
    if (result === null || result["isError"] === true) return false;
    const structuredContent = result["structuredContent"];
    if (!isJsonObject(structuredContent)) return false;
    const data = structuredContent["data"];
    return isJsonObject(data) && data["disponivel"] === true;
}

function initialize(turn: number): JsonObject | null {
    return postMcp(
        JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "k6-rock-in-rio", version: "1" },
            },
        }),
        "initialize",
        turn,
    );
}

function listTools(turn: number): JsonObject | null {
    return postMcp(
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
        "tools_list",
        turn,
    );
}

function callRockInRio(turn: number): JsonObject | null {
    const response = postMcp(
        JSON.stringify({
            jsonrpc: "2.0",
            id: 3 + turn,
            method: "tools/call",
            params: { name: "rock_in_rio_lineup", arguments: {} },
        }),
        "rock_in_rio_lineup",
        turn,
    );
    check(response, {
        "rock_in_rio_lineup returns available data": hasSuccessfulLineup,
    });
    return response;
}

export default function (): void {
    if (!MCP_BASE_URL) throw new Error("MCP_BASE_URL is required");
    if (!MCP_TOKEN) throw new Error("MCP_TOKEN is required");

    const iterationStartedAt = Date.now();
    const turns = sampleTurnCount();
    let completed = true;

    const initialized = initialize(0);
    completed = resultObject(initialized) !== null;

    const tools = listTools(0);
    completed = completed && resultObject(tools) !== null;
    check(tools, {
        "tools/list exposes rock_in_rio_lineup": (value) => {
            const result = resultObject(value);
            return (
                result !== null &&
                Array.isArray(result["tools"]) &&
                result["tools"].some(
                    (tool) => isJsonObject(tool) && tool["name"] === "rock_in_rio_lineup",
                )
            );
        },
    });

    for (let turn = 1; turn <= turns; turn += 1) {
        completed = hasSuccessfulLineup(callRockInRio(turn)) && completed;
        if (turn < turns) {
            const waitSeconds = sampleWaitSeconds();
            chatbotWaitDuration.add(waitSeconds * 1000);
            sleep(waitSeconds);
        }
    }

    chatbotTurns.add(turns);
    chatbotIterationDuration.add(Date.now() - iterationStartedAt);
    chatbotCompleted.add(completed);
    sleep(SESSION_COOLDOWN_SECONDS);
}

export { teardown };
