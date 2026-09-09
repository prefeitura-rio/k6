import http from "k6/http";
import { check } from "k6";
import {
    BASE_THRESHOLDS,
    makeScenario,
    SMOKE,
    SYSTEM_TAGS,
    teardown,
} from "./lib.ts";

const MCP_BASE_URL = (__ENV["MCP_BASE_URL"] ?? "").replace(/\/+$/, "");
const MCP_TOKEN = __ENV["MCP_TOKEN"] ?? "";
const MCP_URL = `${MCP_BASE_URL}/mcp`;
const MCP_HEADERS = {
    Authorization: `Bearer ${MCP_TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
};

// Do not use the shared response callback: MCP checks require HTTP 200, not its broader status set.

export const options = {
    scenarios: {
        mcp: makeScenario("default"),
    },
    systemTags: SYSTEM_TAGS,
    thresholds: SMOKE ? {} : { ...BASE_THRESHOLDS, checks: ["rate>0.99"] },
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

function postMcp(body: string, name: string): JsonObject | null {
    const response = http.post(MCP_URL, body, {
        headers: MCP_HEADERS,
        tags: { service: "mcp", name },
    });
    const envelope = parseSseData(response.body ?? "");
    check(response, {
        [`${name} returns HTTP 200`]: (res) => res.status === 200,
        [`${name} returns SSE`]: (res) =>
            (res.headers["Content-Type"] ?? "").includes("text/event-stream"),
    });
    check(envelope, { [`${name} contains valid SSE data`]: (value) => value !== null });
    return envelope;
}

function hasResult(envelope: JsonObject | null): boolean {
    return envelope !== null && isJsonObject(envelope["result"]);
}

function resultObject(envelope: JsonObject | null): JsonObject | null {
    return envelope !== null && isJsonObject(envelope["result"]) ? envelope["result"] : null;
}

export default function (): void {
    if (!MCP_BASE_URL) throw new Error("MCP_BASE_URL is required");
    if (!MCP_TOKEN) throw new Error("MCP_TOKEN is required");

    const health = http.get(`${MCP_BASE_URL}/health`, {
        tags: { service: "mcp_setup", name: "/health" },
    });
    check(health, {
        "health returns HTTP 200": (response) => response.status === 200,
        "health returns text/plain": (response) =>
            (response.headers["Content-Type"] ?? "").includes("text/plain"),
        "health returns OK": (response) => response.body === "OK",
    });

    const initialize = postMcp(
        JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "k6-app-mcp-server", version: "1" },
            },
        }),
        "initialize",
    );
    check(initialize, {
        "initialize has result": hasResult,
        "initialize identifies the server": (value) => {
            const result = resultObject(value);
            return (
                result !== null &&
                isJsonObject(result["serverInfo"]) &&
                result["serverInfo"]["name"] === "Rio de Janeiro MCP Server"
            );
        },
        "initialize has protocol version": (value) => {
            const result = resultObject(value);
            return result !== null && typeof result["protocolVersion"] === "string";
        },
        "initialize exposes tools capability": (value) => {
            const result = resultObject(value);
            return (
                result !== null &&
                isJsonObject(result["capabilities"]) &&
                isJsonObject(result["capabilities"]["tools"])
            );
        },
    });

    const tools = postMcp(
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
        "tools_list",
    );
    check(tools, {
        "tools/list has result": hasResult,
        "tools/list exposes at least 10 tools": (value) => {
            const result = resultObject(value);
            return (
                result !== null &&
                Array.isArray(result["tools"]) &&
                result["tools"].length >= 10
            );
        },
        "tools/list exposes calculator_add": (value) => {
            const result = resultObject(value);
            return (
                result !== null &&
                Array.isArray(result["tools"]) &&
                result["tools"].some(
                    (tool) => isJsonObject(tool) && tool["name"] === "calculator_add",
                )
            );
        },
    });

    const calculator = postMcp(
        JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "calculator_add", arguments: { a: 2, b: 3 } },
        }),
        "calculator_add",
    );
    check(calculator, {
        "calculator_add has result": hasResult,
        "calculator_add is not an error": (value) =>
            resultObject(value)?.["isError"] === false,
        "calculator_add returns 5.0": (value) => {
            const result = resultObject(value);
            return (
                result !== null &&
                isJsonObject(result["structuredContent"]) &&
                result["structuredContent"]["result"] === 5
            );
        },
    });
}

export { teardown };
