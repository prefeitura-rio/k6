import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import { SYSTEM_TAGS, SMOKE, teardown } from "./lib.ts";

const SCRT_URL = (__ENV["MIAW_SCRT_URL"] ?? "https://prefeitura-rio.my.salesforce-scrt.com").replace(/\/+$/, "");
const ORG_ID = __ENV["MIAW_ORG_ID"] ?? "00Das00000CQdja";
const DEPLOYMENT_NAME = __ENV["MIAW_DEPLOYMENT_NAME"] ?? "API_Chat_Agentforce_Prefeitura_Rio";
const CONCURRENT_VUS = Number(__ENV["CONCURRENT_VUS"] ?? "1");
const RAMP_DURATION = __ENV["RAMP_DURATION"] ?? "5m";
const HOLD_DURATION = __ENV["HOLD_DURATION"] ?? "10m";
const THINK_TIME_SECONDS = Number(__ENV["THINK_TIME_SECONDS"] ?? "3");
const SESSION_COOLDOWN_SECONDS = Number(__ENV["SESSION_COOLDOWN_SECONDS"] ?? "15");
const POLL_INTERVAL_SECONDS = Number(__ENV["POLL_INTERVAL_SECONDS"] ?? "1");
const MAX_POLL_TIMEOUT_SECONDS = Number(__ENV["MAX_POLL_TIMEOUT_SECONDS"] ?? "60");

const MAX_UNIQUE_PHONES = Number(__ENV["MIAW_MAX_UNIQUE_PHONES"] ?? "25000");

const NO_ACTION_MESSAGES = [
    "Oi!",
    "Quem é você e como você pode me ajudar?",
    "Obrigado, até mais!",
];

export const tokenDuration = new Trend("miaw_token_duration", true);
export const conversationCreateDuration = new Trend("miaw_conversation_create_duration", true);
export const messageSendDuration = new Trend("miaw_message_send_duration", true);
export const agentResponseDuration = new Trend("miaw_agent_response_duration", true);
export const turnCompleted = new Rate("miaw_turn_completed");
export const agentforceSuccessRate = new Rate("miaw_agentforce_success_rate");
export const conversationCompleted = new Rate("miaw_conversation_completed");
export const botResponses = new Counter("miaw_bot_responses");
export const fallbackResponses = new Counter("miaw_fallback_responses");

export const options = {
    scenarios: {
        miaw: SMOKE
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
              miaw_turn_completed: ["rate>0.90"],
              miaw_agent_response_duration: ["p(95)<30000"],
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

function generateUuid(): string {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

function getUniquePhoneNumber(vuId: number, iter: number): string {
    const globalIndex = (((vuId - 1) * 1000) + iter) % MAX_UNIQUE_PHONES + 1;
    const invalidDdd = "00"; // Non-existent Brazilian DDD, ensures zero collision with real phone numbers
    return `55${invalidDdd}${String(globalIndex).padStart(9, "0")}`;
}

function getUnauthenticatedToken(): string {
    const startedAt = Date.now();
    const url = `${SCRT_URL}/iamessage/api/v2/authorization/unauthenticated/access-token`;
    const payload = JSON.stringify({
        orgId: ORG_ID,
        esDeveloperName: DEPLOYMENT_NAME,
        capabilitiesVersion: "1",
        platform: "Web",
    });

    const response = http.post(url, payload, {
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        tags: { service: "miaw", operation: "token" },
        timeout: "30s",
    });
    tokenDuration.add(Date.now() - startedAt);

    const data = parseJson(response.body ?? "");
    const token = data?.["accessToken"];
    check(response, { "MIAW token obtained": (res) => res.status === 200 || res.status === 201 });

    if (typeof token !== "string" || token.length === 0) {
        throw new Error(`Failed to obtain MIAW token: HTTP ${response.status} ${response.body}`);
    }
    return token;
}

function createConversation(token: string, conversationId: string, phoneNumber: string): void {
    const startedAt = Date.now();
    const url = `${SCRT_URL}/iamessage/api/v2/conversation`;
    const payload = JSON.stringify({
        conversationId,
        esDeveloperName: DEPLOYMENT_NAME,
        routingAttributes: {
            _phone: phoneNumber,
            PhoneNumber: phoneNumber,
            MessagingPlatformKey: phoneNumber,
            _MessagingPlatformKey: phoneNumber,
        },
    });

    const response = http.post(url, payload, {
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
        },
        tags: { service: "miaw", operation: "conversation_create" },
        timeout: "30s",
    });
    conversationCreateDuration.add(Date.now() - startedAt);

    check(response, { "MIAW conversation created": (res) => res.status === 200 || res.status === 201 });
    if (response.status !== 200 && response.status !== 201) {
        throw new Error(`Failed to create conversation: HTTP ${response.status} ${response.body}`);
    }
}

function sendMessageAndPollResponse(
    token: string,
    conversationId: string,
    text: string,
    turnNumber: number,
    phoneNumber: string,
): boolean {
    const messageId = generateUuid();
    const sendStartedAt = Date.now();
    const sendUrl = `${SCRT_URL}/iamessage/api/v2/conversation/${conversationId}/message`;
    const payload = JSON.stringify({
        message: {
            id: messageId,
            messageType: "StaticContentMessage",
            staticContent: {
                formatType: "Text",
                text,
            },
        },
        esDeveloperName: DEPLOYMENT_NAME,
        routingAttributes: {
            _phone: phoneNumber,
            PhoneNumber: phoneNumber,
            MessagingPlatformKey: phoneNumber,
            _MessagingPlatformKey: phoneNumber,
        },
    });

    const sendResponse = http.post(sendUrl, payload, {
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
        },
        tags: { service: "miaw", operation: "message_send", turn: String(turnNumber) },
        timeout: "30s",
    });
    messageSendDuration.add(Date.now() - sendStartedAt);

    const sendSuccess = sendResponse.status === 200 || sendResponse.status === 201 || sendResponse.status === 202;
    check(sendResponse, { "MIAW message sent": () => sendSuccess });
    if (!sendSuccess) {
        turnCompleted.add(false);
        return false;
    }

    const pollUrl = `${SCRT_URL}/iamessage/api/v2/conversation/${conversationId}/entries?limit=20`;
    const pollDeadline = Date.now() + MAX_POLL_TIMEOUT_SECONDS * 1000;
    let agentReplied = false;

    while (Date.now() < pollDeadline) {
        sleep(POLL_INTERVAL_SECONDS);
        const entriesResponse = http.get(pollUrl, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/json",
            },
            tags: { service: "miaw", operation: "entries_poll" },
            timeout: "15s",
        });

        if (entriesResponse.status !== 200) continue;
        const body = parseJson(entriesResponse.body ?? "");
        const entries = body?.["conversationEntries"];

        if (Array.isArray(entries)) {
            const botEntry = entries.find((e: unknown) => {
                if (!isJsonObject(e)) return false;
                const sender = e["sender"];
                const entryType = e["entryType"];
                const isFromAgent =
                    isJsonObject(sender) &&
                    (sender["role"] === "Chatbot" || sender["role"] === "Agent" || sender["role"] === "System" || sender["role"] === "Router");
                const entryTimestamp = Number(e["clientTimestamp"] ?? e["transcriptedTimestamp"] ?? 0);
                return isFromAgent && entryType === "Message" && entryTimestamp >= (sendStartedAt - 1000);
            });

            if (botEntry) {
                agentReplied = true;
                const senderObj = isJsonObject(botEntry["sender"]) ? botEntry["sender"] : {};
                const role = String(senderObj["role"] ?? "unknown");
                const subject = String(senderObj["subject"] ?? "unknown");
                const displayName = String(botEntry["senderDisplayName"] ?? role);

                const payloadRaw = botEntry["entryPayload"];
                const payloadObj = typeof payloadRaw === "string" ? parseJson(payloadRaw) : (isJsonObject(payloadRaw) ? payloadRaw : {});
                const abstractMsg = isJsonObject(payloadObj?.["abstractMessage"]) ? payloadObj?.["abstractMessage"] : {};
                const staticContent = isJsonObject(abstractMsg?.["staticContent"]) ? abstractMsg?.["staticContent"] : {};
                const replyText = String(staticContent?.["text"] ?? "");

                const isFallback =
                    role === "System" ||
                    replyText.toLowerCase().includes("não está disponível") ||
                    replyText.toLowerCase().includes("atendimento ao cliente") ||
                    replyText.toLowerCase().includes("chat ao vivo");

                if (isFallback) {
                    fallbackResponses.add(1, { role, subject });
                    agentforceSuccessRate.add(false);
                } else {
                    botResponses.add(1, { role, subject });
                    agentforceSuccessRate.add(true);
                }

                check(replyText, {
                    "Agentforce responded (not fallback message)": () => !isFallback,
                });

                agentResponseDuration.add(Date.now() - sendStartedAt, {
                    turn: String(turnNumber),
                    role,
                    is_fallback: String(isFallback),
                });
                break;
            }
        }
    }

    check(agentReplied, { "Agent replied to turn": (value) => value === true });
    turnCompleted.add(agentReplied);
    return agentReplied;
}

export default function (): void {
    if (__ITER === 0 && !SMOKE) {
        sleep(Math.random() * 20);
    }

    const phoneNumber = getUniquePhoneNumber(__VU, __ITER);
    const token = getUnauthenticatedToken();
    const conversationId = generateUuid();
    createConversation(token, conversationId, phoneNumber);

    let allTurnsSucceeded = true;
    for (let i = 0; i < NO_ACTION_MESSAGES.length; i += 1) {
        const text = NO_ACTION_MESSAGES[i] ?? "Oi!";
        const turnSuccess = sendMessageAndPollResponse(token, conversationId, text, i + 1, phoneNumber);
        allTurnsSucceeded = allTurnsSucceeded && turnSuccess;

        if (i < NO_ACTION_MESSAGES.length - 1) {
            sleep(THINK_TIME_SECONDS);
        }
    }

    conversationCompleted.add(allTurnsSucceeded);
    if (SESSION_COOLDOWN_SECONDS > 0) {
        sleep(SESSION_COOLDOWN_SECONDS);
    }
}

export { teardown };
