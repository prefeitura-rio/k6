// ─────────────────────────────────────────────────────────────────────────────
// MIAW (Messaging for In-App and Web) load test against the Agentforce chat channel.
//
// Every change versus the previous version of this script is a defect fix or a
// fidelity fix (correctness or "closer to real WhatsApp behavior"):
//
//   FIX 1  Close each conversation (DELETE) in a finally block.
//          → the previous version never closed → sessions accumulated → breached the
//            Digital Engagement concurrent-session limit.
//   FIX 2  Retry-with-backoff on token/create failures.
//          → the previous version threw on failure; k6 then aborted the iteration and
//            the VU immediately restarted, SKIPPING think/cooldown sleeps — a hot retry
//            loop that AMPLIFIES load exactly when the platform is returning
//            RESOURCE_EXHAUSTED. Backoff turns a storm into a controlled retry.
//   FIX 3  Realistic pacing (default 3 messages/minute ≈ one every 20s).
//          → the previous version burst the 3 messages ~3s apart then looped to a
//            brand-new conversation. A real citizen types ~3 msg/min in ONE
//            conversation. Pacing both matches reality AND cuts conversation churn.
//   FIX 4  Correct agent-reply detection.
//          → System/Router entries were counted as the agent reply, inflating
//            turn_completed and (for Router) counting routing echoes as agent SUCCESS.
//            We only accept a real Agentforce message (Chatbot/Agent), classify
//            System/fallback text as a fallback = failure, and ignore Router entries.
//   FIX 5  Collision-free phone numbers at scale.
//          → the previous version strided 1000/VU and wrapped at %25000, colliding from
//            the 26th VU. We use a per-(VU,iter) unique index that does not wrap.
//   FIX 6  Success path holds the session open for the full conversation window
//          (~1 min) instead of closing early and idling OUTSIDE the conversation, so
//          concurrent VUs ≈ concurrent OPEN sessions. The cooldown becomes a
//          FAILURE-only anti-hammer backoff. FILL_CONVERSATION_MINUTE=false restores
//          the close-early-then-idle behavior.
//   FIX 7  A no-reply turn (send failure or poll timeout) records
//          agentforce_success=false instead of adding NO sample, so the success rate's
//          denominator covers ALL turn attempts.
//
// Every knob is env-driven, so the previous load shape can still be reproduced for
// comparison (e.g. CLOSE_CONVERSATION=false, MESSAGES_PER_MINUTE=20, MAX_RETRIES=0).
// ─────────────────────────────────────────────────────────────────────────────

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import { SYSTEM_TAGS, SMOKE, teardown } from "./lib.ts";

// Defaults point at the prefeitura-rio sandbox. Production requires ALLOW_PROD=true.
const SCRT_URL = (
    __ENV["MIAW_SCRT_URL"] ?? "https://prefeitura-rio--devmarcelo.sandbox.my.salesforce-scrt.com"
).replace(/\/+$/, "");
const ORG_ID = __ENV["MIAW_ORG_ID"] ?? "00D89000006oT9pEAE";
const DEPLOYMENT_NAME = __ENV["MIAW_DEPLOYMENT_NAME"] ?? "API_Chat_Agentforce_Prefeitura_Rio";
const CONCURRENT_VUS = Number(__ENV["CONCURRENT_VUS"] ?? "1");
const RAMP_DURATION = __ENV["RAMP_DURATION"] ?? "5m";
const HOLD_DURATION = __ENV["HOLD_DURATION"] ?? "10m";
// 1s polling triggers 429 on the entries endpoint even for a single conversation;
// 3s did not with 5 VUs in prod. 5s keeps the reply-time error under 5s.
const POLL_INTERVAL_SECONDS = Number(__ENV["POLL_INTERVAL_SECONDS"] ?? "5");
const MAX_POLL_TIMEOUT_SECONDS = Number(__ENV["MAX_POLL_TIMEOUT_SECONDS"] ?? "60");
// Must satisfy STRIDE * maxVUs <= MAX_UNIQUE_PHONES so the modulo in
// getUniquePhoneNumber never wraps (a wrap re-collides VU N with VU N+MAX/STRIDE).
// Default fills the full 9-digit phone space (STRIDE 100k → up to 10,000 VUs).
const MAX_UNIQUE_PHONES = Number(__ENV["MIAW_MAX_UNIQUE_PHONES"] ?? "1000000000");

// FIX 3 — pacing. Default 3 messages/minute → one message every 20s, matching a
// real citizen. Set MESSAGES_PER_MINUTE high (e.g. 20) to reproduce the burst.
const MESSAGES_PER_MINUTE = Number(__ENV["MESSAGES_PER_MINUTE"] ?? "3");
const TURN_INTERVAL_SECONDS = MESSAGES_PER_MINUTE > 0 ? 60 / MESSAGES_PER_MINUTE : 0;
// Gap between a closed conversation and the VU opening the next one. FIX 6 turns
// this into a FAILURE-ONLY anti-hammer backoff: on the success path the session is
// held open to fill the conversation window instead.
const SESSION_COOLDOWN_SECONDS = Number(__ENV["SESSION_COOLDOWN_SECONDS"] ?? "15");

// FIX 6 — on the success path, keep the conversation (session) open until the full
// conversation window elapses, then close, with no extra out-of-conversation idle.
// CONVERSATION_WINDOW_SECONDS should match the pacing window (3 msg/min → ~60s).
const FILL_CONVERSATION_MINUTE =
    (__ENV["FILL_CONVERSATION_MINUTE"] ?? "true").toLowerCase() !== "false";
const CONVERSATION_WINDOW_SECONDS = Number(__ENV["CONVERSATION_WINDOW_SECONDS"] ?? "60");

// FIX 1 — close the conversation after its turns. On the real WhatsApp channel a
// user cannot close a session; on this MIAW test path we CAN, and doing so keeps
// live sessions bounded to ~concurrent users instead of exploding.
const CLOSE_CONVERSATION = (__ENV["CLOSE_CONVERSATION"] ?? "true").toLowerCase() !== "false";

// FIX 2 — retry/backoff for token + createConversation. MAX_RETRIES=0 reproduces
// the throw-and-hot-loop behavior.
const MAX_RETRIES = Number(__ENV["MAX_RETRIES"] ?? "3");
const RETRY_BASE_BACKOFF_SECONDS = Number(__ENV["RETRY_BASE_BACKOFF_SECONDS"] ?? "2");
const RETRY_MAX_BACKOFF_SECONDS = Number(__ENV["RETRY_MAX_BACKOFF_SECONDS"] ?? "30");

// Startup jitter — on a VU's FIRST iteration, sleep a random 0..N seconds so the
// initial herd of VUs does not fire their createConversation in lockstep.
// IMPORTANT: under an arrival-rate executor almost every iteration is a VU's first,
// so this jitter instead DELAYS each scheduled arrival by up to N seconds.
// Arrival-rate runs MUST set STARTUP_JITTER_SECONDS=0.
const STARTUP_JITTER_SECONDS = Number(__ENV["STARTUP_JITTER_SECONDS"] ?? "20");

// Production safety guard. Any run whose resolved target is the production host or
// org aborts at init (before the first HTTP call) unless ALLOW_PROD=true.
const PROD_SCRT_HOST = "prefeitura-rio.my.salesforce-scrt.com";
const PROD_ORG_ID = "00Das00000CQdja";
const ALLOW_PROD = (__ENV["ALLOW_PROD"] ?? "").toLowerCase() === "true";
if ((SCRT_URL.includes(PROD_SCRT_HOST) || ORG_ID === PROD_ORG_ID) && !ALLOW_PROD) {
    throw new Error(
        `REFUSING to run against production (host=${SCRT_URL}, org=${ORG_ID}). ` +
            `Point MIAW_SCRT_URL/MIAW_ORG_ID/MIAW_DEPLOYMENT_NAME at a sandbox, ` +
            `or set ALLOW_PROD=true to override.`,
    );
}

// Conversation messages — ONE per turn; the turn count follows the list length.
// Default = 3 small-talk NO_ACTION probes. Override with MIAW_MESSAGES
// ("||"-separated) to drive a different journey without touching this file.
const DEFAULT_MESSAGES = ["Oi!", "Quem é você e como você pode me ajudar?", "Obrigado, até mais!"];
const NO_ACTION_MESSAGES: string[] = (() => {
    const raw = __ENV["MIAW_MESSAGES"];
    if (typeof raw === "string" && raw.trim().length > 0) {
        const parts = raw
            .split("||")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        if (parts.length > 0) return parts;
    }
    return DEFAULT_MESSAGES;
})();

// Agent reply p95 per turn. The closing (last) turn triggers the session-end flow
// and is much slower (prod, 5 VUs: ~34s avg vs 8–13s for the others), so a single
// p95 would always fail on it rather than on real degradation.
const AGENT_P95_MS = Number(__ENV["AGENT_P95_MS"] ?? "30000");
const CLOSING_TURN_P95_MS = Number(__ENV["CLOSING_TURN_P95_MS"] ?? "60000");

function agentResponseThresholds(): Record<string, string[]> {
    const thresholds: Record<string, string[]> = {};
    const turns = NO_ACTION_MESSAGES.length;
    for (let turn = 1; turn <= turns; turn += 1) {
        const p95 = turn === turns && turns > 1 ? CLOSING_TURN_P95_MS : AGENT_P95_MS;
        thresholds[`miaw_agent_response_duration{turn:${turn}}`] = [`p(95)<${p95}`];
    }
    return thresholds;
}

export const tokenDuration = new Trend("miaw_token_duration", true);
export const conversationCreateDuration = new Trend("miaw_conversation_create_duration", true);
export const conversationCloseDuration = new Trend("miaw_conversation_close_duration", true);
export const messageSendDuration = new Trend("miaw_message_send_duration", true);
export const agentResponseDuration = new Trend("miaw_agent_response_duration", true);
export const turnCompleted = new Rate("miaw_turn_completed");
export const agentforceSuccessRate = new Rate("miaw_agentforce_success_rate");
export const conversationCompleted = new Rate("miaw_conversation_completed");
export const conversationClosed = new Rate("miaw_conversation_closed");
export const botResponses = new Counter("miaw_bot_responses");
export const fallbackResponses = new Counter("miaw_fallback_responses");
export const retriesCounter = new Counter("miaw_retries");
// A bot entry (Chatbot/Agent) whose text is empty/whitespace: replied but not a
// valid answer, so it must NOT count as agent success.
export const invalidResponses = new Counter("miaw_invalid_responses");
// Turns abandoned because a prior turn never got a reply (timeout / send error).
// Counted so they never masquerade as passes or vanish.
export const turnsNotExecuted = new Counter("miaw_turns_not_executed");
// Conversations whose close was requested but never confirmed (all close attempts
// failed): candidates for server-side reconciliation.
export const closePending = new Counter("miaw_close_pending");
// Token-endpoint 429s, surfaced separately to test the hypothesis that the 200
// access-tokens/min/org Enhanced-Chat cap (not TPM/sessions) is the first wall.
export const tokenRateLimited = new Counter("miaw_token_rate_limited");
// Best-effort close of a conversation whose create FAILED client-side (it may still
// exist server-side). Informational only: kept out of every other indicator.
export const orphanCleanup = new Counter("miaw_orphan_cleanup");

// STEP_LADDER — climb through several VU plateaus in ONE run to find WHERE the
// platform breaks, not just whether it survives a single target. Each step ramps to
// its target over STEP_RAMP, then holds for STEP_HOLD; a final ramp returns to 0.
// Falls back to the single-target ramp (CONCURRENT_VUS) when disabled, and is
// ignored entirely under SMOKE.
// Example: STEP_LADDER=true STEPS=100,500,1000,1500,2000,2500 STEP_RAMP=2m STEP_HOLD=5m
const STEP_LADDER = (__ENV["STEP_LADDER"] ?? "false").toLowerCase() === "true";
const STEP_TARGETS = (__ENV["STEPS"] ?? "100,500,1000,1500,2000,2500")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
const STEP_RAMP = __ENV["STEP_RAMP"] ?? "2m";
const STEP_HOLD = __ENV["STEP_HOLD"] ?? "5m";

function buildLadderStages(): { duration: string; target: number }[] {
    const stages: { duration: string; target: number }[] = [];
    for (const target of STEP_TARGETS) {
        stages.push({ duration: STEP_RAMP, target }); // ramp up to this plateau
        stages.push({ duration: STEP_HOLD, target }); // hold to measure the plateau
    }
    stages.push({ duration: STEP_RAMP, target: 0 }); // ramp back down to zero
    return stages;
}

// EXECUTOR — load MODEL. Default "ramping-vus" holds N CONCURRENT users, each
// looping conversations back-to-back. "arrival-rate" instead opens NEW SESSIONS at
// a fixed rate (sessions/min); concurrency emerges from the rate (Little's law:
// concurrent ≈ rate × ~1min). Messaging limits are distinct and must not be
// conflated: ~11,000 CONCURRENT active sessions, 50 NEW sessions/second, and up to
// 1,000 subsequent messages/second, shared across the org's channels. STEPS /
// CONCURRENT_VUS values are read as sessions/min in this mode.
const EXECUTOR = (__ENV["EXECUTOR"] ?? "ramping-vus").toLowerCase();
const SESSIONS_PER_MINUTE = Number(__ENV["SESSIONS_PER_MINUTE"] ?? String(CONCURRENT_VUS));
// Each session lasts ~1 min, so peak concurrency ≈ peak rate; preallocate VUs to
// cover it (upfront allocation avoids mid-test VU-spawn hiccups).
const ARRIVAL_PEAK = STEP_LADDER ? Math.max(...STEP_TARGETS) : SESSIONS_PER_MINUTE;
const ARRIVAL_MAX_VUS = Number(__ENV["ARRIVAL_MAX_VUS"] ?? String(Math.ceil(ARRIVAL_PEAK * 1.3)));
const ARRIVAL_PREALLOC_VUS = Number(__ENV["ARRIVAL_PREALLOC_VUS"] ?? String(ARRIVAL_MAX_VUS));

function buildLoadScenario(): Record<string, unknown> {
    const target = EXECUTOR === "arrival-rate" ? SESSIONS_PER_MINUTE : CONCURRENT_VUS;
    const stages = STEP_LADDER
        ? buildLadderStages()
        : [
              { duration: RAMP_DURATION, target },
              { duration: HOLD_DURATION, target },
              { duration: RAMP_DURATION, target: 0 },
          ];

    if (EXECUTOR === "arrival-rate") {
        // target = sessions opened per minute (timeUnit "1m").
        return {
            executor: "ramping-arrival-rate",
            timeUnit: "1m",
            startRate: 0,
            preAllocatedVUs: ARRIVAL_PREALLOC_VUS,
            maxVUs: ARRIVAL_MAX_VUS,
            stages,
            gracefulStop: "30s",
            exec: "default",
        };
    }

    // target = concurrent VUs.
    return {
        executor: "ramping-vus",
        startVUs: 0,
        stages,
        gracefulRampDown: "30s",
        gracefulStop: "30s",
        exec: "default",
    };
}

export const options = {
    scenarios: {
        miaw: {
            ...(SMOKE
                ? { executor: "per-vu-iterations", vus: 1, iterations: 1, exec: "default" }
                : buildLoadScenario()),
            // Every request is part of the measured journey (phase=main) except the
            // orphan cleanup close, which overrides it with phase=cleanup so thresholds
            // ignore it. Set on the scenario, not options.tags: the harness passes
            // `--tag testrun=...`, and CLI tags REPLACE options.tags entirely.
            tags: { phase: "main" },
        },
    },
    systemTags: SYSTEM_TAGS,
    thresholds: SMOKE
        ? {}
        : {
              // SAFETY KILL — k6 aborts the WHOLE run (stops climbing the ladder) when
              // >10% of HTTP requests fail sustained for 30s. The strict rate<0.01 stays
              // as the pass/fail SLO. Global only with PARALLELISM=1 (submit.py enforces).
              "http_req_failed{phase:main}": [
                  "rate<0.01",
                  { threshold: "rate<0.10", abortOnFail: true, delayAbortEval: "30s" },
              ],
              miaw_turn_completed: ["rate>0.90"],
              ...agentResponseThresholds(),
              // Gate on REAL agent success, not just transport: without these a
              // 100%-fallback run passes every other threshold.
              miaw_agentforce_success_rate: ["rate>0.90"],
              miaw_conversation_completed: ["rate>0.90"],
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

// Stable identity for a conversation entry, used to dedup entries already consumed
// by a previous turn. Prefers the API's own id; falls back to a synthetic key
// (timestamp + payload) only when no id field is present.
function entryKey(e: JsonObject): string {
    const id = e["identifier"] ?? e["id"] ?? e["messageId"];
    if (typeof id === "string" && id.length > 0) return id;
    const ts = String(e["clientTimestamp"] ?? e["transcriptedTimestamp"] ?? "");
    const payload =
        typeof e["entryPayload"] === "string"
            ? e["entryPayload"]
            : JSON.stringify(e["entryPayload"] ?? "");
    return `${ts}:${payload}`;
}

function generateUuid(): string {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

// FIX 5 — unique phone per (VU, iteration). Invariant for zero collisions:
// iter < STRIDE AND STRIDE * maxVUs <= MAX_UNIQUE_PHONES. Uses the invalid
// Brazilian DDD "00" so no real phone is ever contacted.
function getUniquePhoneNumber(vuId: number, iter: number): string {
    const STRIDE = 100000;
    const globalIndex = ((vuId - 1) * STRIDE + iter) % MAX_UNIQUE_PHONES;
    const invalidDdd = "00"; // Non-existent Brazilian DDD → zero collision with real numbers.
    return `55${invalidDdd}${String(globalIndex).padStart(9, "0")}`;
}

// FIX 2 — exponential backoff helper. Returns after sleeping; caller decides to
// retry. Jittered to avoid a synchronized thundering herd of VUs.
function backoffSleep(attempt: number, countRetry = true): void {
    const exp = Math.min(
        RETRY_BASE_BACKOFF_SECONDS * Math.pow(2, attempt),
        RETRY_MAX_BACKOFF_SECONDS,
    );
    const jittered = exp * (0.5 + Math.random() * 0.5); // 50%–100% of exp
    if (countRetry) retriesCounter.add(1);
    sleep(jittered);
}

// Returns a token, or null after exhausting retries (caller aborts the iteration
// GRACEFULLY — no throw, so the VU's normal pacing/cooldown still applies).
function getUnauthenticatedToken(): string | null {
    const url = `${SCRT_URL}/iamessage/api/v2/authorization/unauthenticated/access-token`;
    const payload = JSON.stringify({
        orgId: ORG_ID,
        esDeveloperName: DEPLOYMENT_NAME,
        capabilitiesVersion: "1",
        platform: "Web",
    });

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        const startedAt = Date.now();
        const response = http.post(url, payload, {
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            tags: { service: "miaw", operation: "token" },
            timeout: "30s",
        });
        tokenDuration.add(Date.now() - startedAt);
        if (response.status === 429) tokenRateLimited.add(1);

        const ok = response.status === 200 || response.status === 201;
        const data = parseJson(typeof response.body === "string" ? response.body : "");
        const token = data?.["accessToken"];
        if (ok && typeof token === "string" && token.length > 0) {
            check(response, { "MIAW token obtained": () => true });
            return token;
        }
        if (attempt < MAX_RETRIES) backoffSleep(attempt);
    }
    check(null, { "MIAW token obtained": () => false });
    return null;
}

// Returns true on success, false after exhausting retries (no throw — see above).
function createConversation(token: string, conversationId: string, phoneNumber: string): boolean {
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

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        const startedAt = Date.now();
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

        if (response.status === 200 || response.status === 201) {
            check(response, { "MIAW conversation created": () => true });
            return true;
        }
        if (attempt < MAX_RETRIES) backoffSleep(attempt);
    }
    check(null, { "MIAW conversation created": () => false });
    return false;
}

// FIX 1 — close a conversation, with limited retry on recoverable failures
// (honoring Retry-After). HTTP 2xx is a REQUEST ack, not proof the Salesforce
// session slot was freed immediately.
//
// mode "normal"  — the conversation WAS created; closing it is part of the measured
//   journey. Only 200/202/204 succeed. A 404 is an anomaly (the conversation existed)
//   and counts as a failed close, but not as pending: there is nothing left open.
//   A close that never confirms is recorded as pending for reconciliation.
// mode "cleanup" — the create FAILED client-side, but may have succeeded server-side
//   (lost/edge response). This best-effort close is NOT part of the test: it is
//   tagged service=miaw_setup (the report excludes it) and phase=cleanup (thresholds
//   ignore it), 404 is expected (it never existed), and it only feeds
//   miaw_orphan_cleanup — no checks, close metrics, or retry counts.
function closeConversation(
    token: string,
    conversationId: string,
    mode: "normal" | "cleanup",
): void {
    const cleanup = mode === "cleanup";
    const url = `${SCRT_URL}/iamessage/api/v2/conversation/${conversationId}?esDeveloperName=${encodeURIComponent(DEPLOYMENT_NAME)}`;
    const tags: Record<string, string> = cleanup
        ? { service: "miaw_setup", operation: "conversation_cleanup", phase: "cleanup" }
        : { service: "miaw", operation: "conversation_close" };
    const params = {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
        },
        tags,
        timeout: "30s",
        ...(cleanup ? { responseCallback: http.expectedStatuses(200, 202, 204, 404) } : {}),
    };

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        const startedAt = Date.now();
        const response = http.del(url, null, params);
        if (!cleanup) conversationCloseDuration.add(Date.now() - startedAt);

        const closed =
            response.status === 200 || response.status === 202 || response.status === 204;
        if (closed || response.status === 404) {
            if (cleanup) {
                orphanCleanup.add(1, { result: closed ? "closed" : "not_found" });
            } else {
                conversationClosed.add(closed);
                check(response, { "MIAW conversation closed": () => closed });
            }
            return;
        }
        // Only 429/5xx are worth retrying; any other 4xx will not recover.
        const recoverable = response.status === 429 || response.status >= 500;
        if (recoverable && attempt < MAX_RETRIES) {
            const retryAfter = Number(response.headers?.["Retry-After"] ?? 0);
            if (retryAfter > 0) {
                if (!cleanup) retriesCounter.add(1);
                sleep(Math.min(retryAfter, RETRY_MAX_BACKOFF_SECONDS));
            } else {
                backoffSleep(attempt, !cleanup);
            }
            continue;
        }
        break;
    }
    if (cleanup) {
        orphanCleanup.add(1, { result: "failed" });
        return;
    }
    conversationClosed.add(false);
    closePending.add(1);
    check(null, { "MIAW conversation closed": () => false });
}

// replied = got ANY bot entry back (transport/latency completion, incl. fallback).
// success = got a REAL, non-empty agent reply (not a fallback, not empty payload).
// The caller uses `replied` to decide whether to keep the journey going: if a turn
// never got a reply, sending the next message would let this turn's late reply be
// misattributed to it, so the journey is aborted.
type TurnResult = { replied: boolean; success: boolean };

function sendMessageAndPollResponse(
    token: string,
    conversationId: string,
    text: string,
    turnNumber: number,
    phoneNumber: string,
    consumedEntryIds: Set<string>,
): TurnResult {
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

    const sendSuccess =
        sendResponse.status === 200 || sendResponse.status === 201 || sendResponse.status === 202;
    check(sendResponse, { "MIAW message sent": () => sendSuccess });
    if (!sendSuccess) {
        turnCompleted.add(false);
        // FIX 7 — a turn whose send failed got no agent reply: record it as a failed
        // attempt so the success rate's denominator covers all attempts.
        agentforceSuccessRate.add(false);
        return { replied: false, success: false };
    }

    const pollUrl = `${SCRT_URL}/iamessage/api/v2/conversation/${conversationId}/entries?limit=20`;
    const pollDeadline = Date.now() + MAX_POLL_TIMEOUT_SECONDS * 1000;
    let agentReplied = false; // got ANY bot entry back (transport/latency completion)
    let turnSucceeded = false; // got a REAL agent reply (not a fallback)

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
        const body = parseJson(
            typeof entriesResponse.body === "string" ? entriesResponse.body : "",
        );
        const entries = body?.["conversationEntries"];
        if (!Array.isArray(entries)) continue;

        // FIX 4 — a real agent reply is an Agentforce message (Chatbot/Agent). A
        // System entry is also a candidate, but only to classify it as a fallback =
        // failure (the "não disponível / atendimento" message a user sees when the
        // agent fails). Router entries are internal routing echoes and are ignored.
        const candidate = entries.find((e: unknown) => {
            if (!isJsonObject(e)) return false;
            // Never re-use an entry a previous turn already consumed.
            if (consumedEntryIds.has(entryKey(e))) return false;
            const sender = e["sender"];
            const role = isJsonObject(sender) ? sender["role"] : undefined;
            const isAgentOrFallback = role === "Chatbot" || role === "Agent" || role === "System";
            const entryTimestamp = Number(e["clientTimestamp"] ?? e["transcriptedTimestamp"] ?? 0);
            return (
                isAgentOrFallback &&
                e["entryType"] === "Message" &&
                entryTimestamp >= sendStartedAt - 1000
            );
        });

        if (!candidate) continue;
        // Claim this entry so no later turn can match it again.
        consumedEntryIds.add(entryKey(candidate as JsonObject));

        agentReplied = true;
        const senderObj = isJsonObject(candidate["sender"]) ? candidate["sender"] : {};
        const role = String(senderObj["role"] ?? "unknown");
        const subject = String(senderObj["subject"] ?? "unknown");

        const payloadRaw = candidate["entryPayload"];
        const payloadObj =
            typeof payloadRaw === "string"
                ? parseJson(payloadRaw)
                : isJsonObject(payloadRaw)
                  ? payloadRaw
                  : {};
        const abstractMsg = isJsonObject(payloadObj?.["abstractMessage"])
            ? payloadObj?.["abstractMessage"]
            : {};
        const staticContent = isJsonObject(abstractMsg?.["staticContent"])
            ? abstractMsg?.["staticContent"]
            : {};
        const replyText = String(staticContent?.["text"] ?? "");

        const isFallback =
            role === "System" ||
            replyText.toLowerCase().includes("não está disponível") ||
            replyText.toLowerCase().includes("atendimento ao cliente") ||
            replyText.toLowerCase().includes("chat ao vivo");
        // An empty/whitespace payload is NOT a valid answer even from a
        // Chatbot/Agent role: it is a malformed reply and must fail the turn.
        const hasText = replyText.trim().length > 0;

        if (isFallback) {
            fallbackResponses.add(1, { role, subject });
            agentforceSuccessRate.add(false);
        } else if (!hasText) {
            invalidResponses.add(1, { role, subject });
            agentforceSuccessRate.add(false);
        } else {
            botResponses.add(1, { role, subject });
            agentforceSuccessRate.add(true);
            turnSucceeded = true;
        }

        check(replyText, {
            "Agentforce responded (valid, non-fallback message)": () => !isFallback && hasText,
        });
        agentResponseDuration.add(Date.now() - sendStartedAt, {
            turn: String(turnNumber),
            role,
            is_fallback: String(isFallback),
        });
        break;
    }

    check(agentReplied, { "Agent replied to turn": (value) => value === true });
    if (!agentReplied) {
        // Some turns never get a reply at all (~8% of turn 2 in prod, even after
        // 180s): log the conversation so it can be looked up on the Salesforce side.
        console.warn(
            `MIAW no agent reply: conversation=${conversationId} turn=${turnNumber} ` +
                `waited=${MAX_POLL_TIMEOUT_SECONDS}s`,
        );
    }
    // FIX 7 — poll timed out with no reply at all: record the turn as a failed
    // attempt. Guarded by !agentReplied so a turn that already added a sample above
    // is never double-counted.
    if (!agentReplied) agentforceSuccessRate.add(false);
    // turn_completed = transport-level (got any bot reply, incl. fallback). The
    // return value drives conversation SUCCESS, so it must exclude fallbacks.
    turnCompleted.add(agentReplied);
    return { replied: agentReplied, success: turnSucceeded };
}

export default function (): void {
    if (__ITER === 0 && !SMOKE && STARTUP_JITTER_SECONDS > 0) {
        sleep(Math.random() * STARTUP_JITTER_SECONDS);
    }

    const phoneNumber = getUniquePhoneNumber(__VU, __ITER);
    const token = getUnauthenticatedToken();
    if (token === null) {
        // FIX 2 — graceful abort: no conversation was created, so nothing to close.
        // Still pace before the VU's next iteration so a failing platform is not
        // hammered by a hot restart loop.
        conversationCompleted.add(false);
        if (SESSION_COOLDOWN_SECONDS > 0) sleep(SESSION_COOLDOWN_SECONDS);
        return;
    }

    const conversationId = generateUuid();
    if (!createConversation(token, conversationId, phoneNumber)) {
        conversationCompleted.add(false);
        // The create may have succeeded server-side even though the client saw a
        // failure. Best-effort close of the client-minted conversationId reclaims
        // that potential orphan, outside every test indicator.
        if (CLOSE_CONVERSATION) closeConversation(token, conversationId, "cleanup");
        if (SESSION_COOLDOWN_SECONDS > 0) sleep(SESSION_COOLDOWN_SECONDS);
        return;
    }

    let allTurnsSucceeded = true;
    // FIX 6 — track whether the journey was aborted (timeout / send failure) so the
    // success path can hold the session open to fill the minute, while the abort
    // path instead backs off (cooldown) to avoid hammering a struggling platform.
    let journeyAborted = false;
    // FIX 3 — pace messages to fixed offsets from the conversation start
    // (msg i fires at convStart + i*TURN_INTERVAL). At MESSAGES_PER_MINUTE=3 that is
    // 0s / 20s / 40s. We sleep only the REMAINING time to the next slot; if a reply
    // took longer than the interval we send immediately instead of drifting.
    const convStart = Date.now();
    // Entry IDs already matched by earlier turns of THIS conversation, so a late
    // reply from a prior turn can never be counted again for a later turn.
    const consumedEntryIds = new Set<string>();
    // FIX 1 — try/finally guarantees the conversation is closed even if a turn
    // throws, so a mid-conversation error can never leak an open session.
    try {
        for (let i = 0; i < NO_ACTION_MESSAGES.length; i += 1) {
            if (TURN_INTERVAL_SECONDS > 0) {
                const nextSlotMs = convStart + i * TURN_INTERVAL_SECONDS * 1000;
                const waitSeconds = (nextSlotMs - Date.now()) / 1000;
                if (waitSeconds > 0) sleep(waitSeconds);
            }

            const text = NO_ACTION_MESSAGES[i] ?? "Oi!";
            const result = sendMessageAndPollResponse(
                token,
                conversationId,
                text,
                i + 1,
                phoneNumber,
                consumedEntryIds,
            );
            allTurnsSucceeded = allTurnsSucceeded && result.success;

            // If this turn never got a reply (timeout or send error), abort the
            // journey: sending the next message would let this turn's late reply be
            // misattributed, and the unsent turns are recorded as not-executed.
            if (!result.replied) {
                turnsNotExecuted.add(NO_ACTION_MESSAGES.length - (i + 1));
                allTurnsSucceeded = false;
                journeyAborted = true;
                break;
            }
        }

        // FIX 6 — on a healthy journey, hold the conversation OPEN until the full
        // window elapses instead of closing early and idling outside it.
        if (FILL_CONVERSATION_MINUTE && !journeyAborted) {
            const remainingSeconds =
                (convStart + CONVERSATION_WINDOW_SECONDS * 1000 - Date.now()) / 1000;
            if (remainingSeconds > 0) sleep(remainingSeconds);
        }
    } finally {
        if (CLOSE_CONVERSATION) {
            closeConversation(token, conversationId, "normal");
        }
    }

    conversationCompleted.add(allTurnsSucceeded);
    // FIX 6 — the cooldown is a FAILURE-ONLY anti-hammer backoff. When filling is
    // disabled, fall back to the always-cooldown behavior.
    const applyCooldown =
        SESSION_COOLDOWN_SECONDS > 0 && (journeyAborted || !FILL_CONVERSATION_MINUTE);
    if (applyCooldown) {
        sleep(SESSION_COOLDOWN_SECONDS);
    }
}

export { teardown };
