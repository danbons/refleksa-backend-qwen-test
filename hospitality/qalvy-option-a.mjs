import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const EVENTS_PATH = "/qalvy/api/agents/v1/events";
const MAX_CLAIMED_TURNS = 4_096;
const MAX_RESPONSE_BYTES = 32 * 1024;
const OBSERVED_STATES = new Set(["pending", "leased", "dead", "succeeded"]);
const SAFE_DEVICE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SAFE_CONTEXT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const OPERATION_ID = /^trigger_[0-9a-fA-F]{64}$/u;
const LANGUAGE = /^(?!und$|mul$|zxx$)[a-z]{2,3}$/u;
const isVisibleAscii = (value, limit) =>
  typeof value === "string" && value.length > 0 && value.length <= limit && !/[^\x21-\x7e]/u.test(value);
const digest = (text) => createHash("sha256").update(text).digest("hex");

function readConfig(env) {
  if (!isVisibleAscii(env.QALVY_BEARER_TOKEN, 4096) || !isVisibleAscii(env.QALVY_AGENT_ID, 256)) return null;
  try {
    const base = new URL(env.QALVY_BASE_URL);
    if (base.protocol !== "https:" || base.username || base.password ||
        base.pathname !== "/" || base.search || base.hash) return null;
    return { url: new URL(EVENTS_PATH, base), key: env.QALVY_BEARER_TOKEN, agentId: env.QALVY_AGENT_ID };
  } catch {
    return null;
  }
}

function readContext(device, resolveGuestContext) {
  try {
    const { hotelId, mirrorId, room } = resolveGuestContext(device) ?? {};
    if (![hotelId, mirrorId, room].every((part) => typeof part === "string" &&
          SAFE_CONTEXT_ID.test(part) && !/\s/u.test(part))) return null;
    return { hotelId, mirrorId, room };
  } catch {
    return null;
  }
}

function encodeEvent({ idempotencyKey, occurredAt, context, language, text, agentId }) {
  return JSON.stringify({
    mode: "fire",
    event: {
      id: idempotencyKey,
      type: "guest.request",
      occurredAt,
      payload: { ...context, language, transcript: text },
    },
    target: { agentId },
    input: "Guest request from room " + context.room + " (" + context.mirrorId +
      ", language " + language + "): " + JSON.stringify(text),
  });
}

function readOperationId(value) {
  return typeof value === "string" && OPERATION_ID.test(value) ? value : null;
}

function readStatusLocation(location, operationId, url) {
  if (!operationId || !isVisibleAscii(location, 2_048)) return null;
  // Qalvy may omit the proxy mount prefix in Location. Map only the
  // exact operation path from the receipt to the canonical HTTPS endpoint.
  const expected = new URL(EVENTS_PATH + "/" + operationId, url);
  const unprefixed = expected.pathname.slice("/qalvy".length);
  if (location !== expected.href && location !== expected.pathname &&
      location !== expected.origin + unprefixed && location !== unprefixed) return null;
  return expected.href;
}

function observeStatusShape(state, operationId) {
  const jsonType = state === null ? "null" : Array.isArray(state) ? "array" : typeof state;
  if (jsonType !== "object") return { jsonType };
  const fieldType = (key) => Object.hasOwn(state, key) ? typeof state[key] : "missing";
  return {
    jsonType,
    fieldCount: Object.keys(state).length,
    idType: fieldType("id"),
    statusType: fieldType("status"),
    idMatches: Object.hasOwn(state, "id") && state.id === operationId,
    observedStatus: OBSERVED_STATES.has(state.status) ? state.status : "unexpected",
  };
}

async function deliver({
  config, idempotencyKey, body, transport, timeoutMs, maxPolls, pollIntervalMs, onAccepted, onStatusObserved,
}) {
  const controller = new AbortController();
  const { signal } = controller;
  const headers = { Authorization: "Bearer " + config.key, "Content-Type": "application/json" };
  let operationId;
  const failure = (status) => operationId ? { status, operationId } : { status };
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      resolve(failure("timeout"));
      controller.abort();
    }, timeoutMs);
  });
  const attempt = async () => {
    try {
      const accepted = await transport(config.url.href, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": idempotencyKey },
        body,
        redirect: "error",
        size: MAX_RESPONSE_BYTES,
        signal,
      });
      signal.throwIfAborted();
      if (accepted?.status === 409) return { status: "idempotency_conflict", httpStatus: 409 };
      if (accepted?.status !== 202) return { status: "event_not_accepted" };

      const receipt = await accepted.json();
      signal.throwIfAborted();
      operationId = readOperationId(receipt?.id);
      if (operationId) {
        try {
          onAccepted?.({ operationId, idempotencyKey });
        } catch {
          return failure("audit_unavailable");
        }
      }
      const location = readStatusLocation(accepted.headers?.get("Location"), operationId, config.url);
      if (!location) return failure("invalid_receipt");

      for (let poll = 0; poll < maxPolls; poll++) {
        if (poll > 0 && pollIntervalMs > 0) await delay(pollIntervalMs, undefined, { signal });
        signal.throwIfAborted();
        const response = await transport(location, {
          method: "GET",
          headers: { Authorization: headers.Authorization, Accept: "application/json" },
          redirect: "error",
          size: MAX_RESPONSE_BYTES,
          signal,
        });
        signal.throwIfAborted();
        if (response?.status !== 200) return { status: "status_unavailable", operationId };
        let shape;
        try {
          shape = observeStatusShape(await response.json(), operationId);
        } catch {
          shape = { jsonType: "invalid_json" };
        }
        signal.throwIfAborted();
        try {
          onStatusObserved?.({ operationId, ...shape });
        } catch {
          return failure("audit_unavailable");
        }
        if (!shape.idMatches || shape.statusType !== "string") {
          return failure("invalid_status");
        }
        switch (shape.observedStatus) {
          case "succeeded":
            return { status: "succeeded", operationId };
          case "dead":
            return { status: "dead", operationId };
          case "pending":
          case "leased":
            break;
          default:
            return { status: "invalid_status", operationId };
        }
      }
      return { status: "poll_limit", operationId };
    } catch {
      return failure(signal.aborted ? "timeout" : "transport_error");
    }
  };
  try {
    return await Promise.race([deadline, attempt()]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Option A with an injected transport. Identity, occurredAt (captured once
 * when accepting the turn), and context are supplied by server-side code.
 */
export function createQalvyOptionAPrototype({
  env = {}, transport, resolveGuestContext, timeoutMs = 5_000, maxPolls = 5, pollIntervalMs = 100,
} = {}) {
  if (typeof transport !== "function" || typeof resolveGuestContext !== "function") {
    throw new TypeError("A simulated Option A transport and server context resolver are required");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 ||
      !Number.isInteger(maxPolls) || maxPolls < 1 || maxPolls > 20 ||
      !Number.isInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 5_000) {
    throw new RangeError("Invalid Option A polling bounds");
  }

  const config = readConfig(env);
  // A claim is local to this instance. Store the body digest rather than the
  // transcript, and retain the claim after a failure or unknown outcome.
  const claimedBodies = new Map();

  return async function dispatch(turn, { onAccepted, onStatusObserved } = {}) {
    const { authenticatedDevice, turnId, occurredAt, language, text } = turn ?? {};
    const deviceId = authenticatedDevice?.deviceId;
    if (typeof deviceId !== "string" || !SAFE_DEVICE_ID.test(deviceId) || /\s/u.test(deviceId) ||
        typeof turnId !== "string" || turnId.length !== 64 || /[^0-9a-f]/u.test(turnId) ||
        !Number.isSafeInteger(occurredAt) || occurredAt < 0 ||
        typeof language !== "string" || !LANGUAGE.test(language) || /\s/u.test(language) ||
        typeof text !== "string" || !text.trim() || text.length > 1_000 ||
        /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(text)) {
      return { status: "invalid_turn" };
    }
    if (!config) return { status: "invalid_config" };
    const context = readContext(authenticatedDevice, resolveGuestContext);
    if (!context) return { status: "context_unavailable" };

    const idempotencyKey = digest(JSON.stringify(["refleksa/qalvy/option-a", deviceId, turnId]));
    const body = encodeEvent({ idempotencyKey, occurredAt, context, language, text, agentId: config.agentId });
    const bodyDigest = digest(body);
    const claimed = claimedBodies.get(idempotencyKey);
    if (claimed === bodyDigest) return { status: "already_claimed", idempotencyKey };
    if (claimed) return { status: "idempotency_conflict", httpStatus: 409, idempotencyKey };
    if (claimedBodies.size >= MAX_CLAIMED_TURNS) return { status: "claim_capacity_reached" };
    claimedBodies.set(idempotencyKey, bodyDigest);

    const result = await deliver({
      config, idempotencyKey, body, transport, timeoutMs, maxPolls, pollIntervalMs, onAccepted, onStatusObserved,
    });
    return { ...result, idempotencyKey };
  };
}
