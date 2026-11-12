import { createQalvyOptionAPrototype } from "./qalvy-option-a.mjs";

export const QALVY_HOSPITALITY_ROUTE = "/hospitality/requests";
const OPTION_B_PATH = "/qalvy/api/agents/v1/chat/completions";
const MAX_TEXT_LENGTH = 1_000;
const MAX_RESPONSE_BYTES = 32 * 1024;
const MAX_CLAIMED_TURNS = 4_096;
const LEGACY_FIXTURE_LANGUAGES = new Set(["it", "en", "fr"]);
const PRIMARY_GUEST_LANGUAGE = /^(?!und$|mul$|zxx$)[a-z]{2,3}$/u;

function review(res, status, reason) {
  return res.status(status).json({ status: "review_required", reason });
}

function readConfig(env) {
  const key = env.QALVY_BEARER_TOKEN;
  const agentId = env.QALVY_AGENT_ID;
  if (typeof key !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(key) ||
      typeof agentId !== "string" || !/^[\x21-\x7e]{1,256}$/.test(agentId)) return null;
  try {
    const base = new URL(env.QALVY_BASE_URL);
    if (base.protocol !== "https:" || base.username || base.password ||
        base.pathname !== "/" || base.search || base.hash) return null;
    return { url: new URL(OPTION_B_PATH, base).href, key, agentId };
  } catch {
    return null;
  }
}

function readGuestContext(device, resolveGuestContext) {
  if (!device || typeof resolveGuestContext !== "function") return null;
  try {
    const { room, mirrorId } = resolveGuestContext(device) ?? {};
    const id = /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/;
    if (typeof room !== "string" || !id.test(room) ||
        typeof mirrorId !== "string" || !id.test(mirrorId)) return null;
    return { room, mirrorId };
  } catch {
    return null;
  }
}

function readQualifiedService(service) {
  if (!service || typeof service !== "object" || Array.isArray(service) ||
      Object.keys(service).length !== 2 || !Object.hasOwn(service, "action") ||
      !Object.hasOwn(service, "quantity")) return null;
  const { action, quantity } = service;
  if ((action !== "bring_towels" && action !== "replace_towels") ||
      (quantity !== null && (!Number.isInteger(quantity) || quantity < 1 || quantity > 20))) return null;
  return { action, quantity };
}

function isRoom101PilotRequest(context, input, service) {
  const normalized = input.text.trim().replace(/[.?!]+$/u, "").trimEnd().toLowerCase();
  return context.room === "101" && context.mirrorId === "mirror-01" && input.language === "en" &&
    service?.action === "bring_towels" && service.quantity === 2 &&
    normalized === "could you bring us two towels";
}

function reportPilotEvent(onPilotEvent, event) {
  try {
    onPilotEvent?.(event);
    return true;
  } catch {
    return false;
  }
}

function encodeOptionB({ agentId, text, room, mirrorId, language, service }) {
  let content = `Guest request from room ${room} (${mirrorId}, language ${language}): ${JSON.stringify(text)}`;
  if (service) {
    const action = service.action === "bring_towels" ? "bring" : "replace";
    const towels = service.quantity === null ? "towels (quantity unspecified)" :
      (service.quantity === 1 ? "1 towel" : `${service.quantity} towels`);
    content += `\nQualified housekeeping action: ${action} ${towels}.` +
      ` Use only this qualified action and end with one SAY: line in language ${language}.`;
  }
  return JSON.stringify({
    model: agentId,
    stream: false,
    messages: [{ role: "user", content }],
  });
}

// Only the final guest-facing line is eligible for speech. Earlier lines
// can contain operational details and are never part of the returned text.
function parseMirrorReply(content) {
  if (typeof content !== "string") return { check: "CONTENT_TYPE" };
  if (content.length > 2_000) return { check: "CONTENT_LENGTH" };
  const normalized = content.replace(/\r\n/g, "\n");
  if (/[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]|\p{Cf}|\p{Cs}/u.test(normalized)) {
    return { check: "CONTENT_CONTROL_CHAR" };
  }
  const lines = normalized.replace(/[ \n]+$/u, "").split("\n");
  const sayLines = lines.filter((line) => /^\p{Zs}*SAY\p{Zs}*:/iu.test(line));
  if (sayLines.length === 0) return { check: "REPLY_LABEL_MISSING" };
  if (sayLines.length > 1) return { check: "REPLY_LABEL_DUPLICATE" };
  const finalLine = lines.at(-1);
  if (sayLines[0] !== finalLine) return { check: "REPLY_LABEL_NOT_FINAL" };
  if (!finalLine.startsWith("SAY:")) return { check: "REPLY_LABEL_FORMAT" };
  const reply = finalLine.slice("SAY:".length).trim();
  if (!reply) return { check: "REPLY_EMPTY" };
  if (/\b(?:department|room|request|urgency|guest wording|mirror reply|mirror response|say)\s*:|[<>\x60{}\[\]]/iu.test(reply) ||
      /^(?:[#>*+-] +|\*\*|__)/u.test(reply)) {
    return { check: "REPLY_UNSAFE_TEXT" };
  }
  // Preserve the guest-facing sentence without paraphrasing or truncation.
  if (!/^[^.!?…。！？؟۔।॥։።]+[.!?。！？؟۔।॥։።]?$/u.test(reply)) return { check: "REPLY_SENTENCE" };
  if (!/\p{L}/u.test(reply)) return { check: "REPLY_NO_LETTER" };
  return { reply };
}

async function sendOnce({ transport, url, key, body, timeoutMs }) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      resolve({ status: 504, reason: "UPSTREAM_TIMEOUT" });
      controller.abort();
    }, timeoutMs);
  });
  const pending = (async () => {
    let upstream;
    try {
      upstream = await transport(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body,
        redirect: "error",
        size: MAX_RESPONSE_BYTES, // node-fetch bounds consumption of the JSON body.
        signal: controller.signal,
      });
    } catch {
      return { status: 502, reason: "UPSTREAM_TRANSPORT_ERROR" };
    }
    try {
      if (controller.signal.aborted || upstream?.ok !== true) {
        controller.abort();
        return { status: 502, reason: "UPSTREAM_HTTP_ERROR" };
      }
      const data = await upstream.json();
      const content = Array.isArray(data?.choices) ? data.choices[0]?.message?.content : undefined;
      const parsed = parseMirrorReply(content);
      return parsed.reply ? parsed : {
        status: 200, reason: "MIRROR_REPLY_AMBIGUOUS", replyCheck: parsed.check,
      };
    } catch {
      controller.abort();
      return { status: 502, reason: "UPSTREAM_INVALID_RESPONSE" };
    }
  })();
  try {
    return await Promise.race([deadline, pending]);
  } finally {
    clearTimeout(timer);
  }
}

export function createQalvyHospitalityHandler({
  env, transport, resolveGuestContext, requireQualifiedService = false,
  room101Pilot = false, onPilotEvent, onReplyRejected, optionA,
  timeoutMs = 5_000, maxClaimedTurns = MAX_CLAIMED_TURNS,
}) {
  if (optionA && (!room101Pilot || !requireQualifiedService || typeof onPilotEvent !== "function")) {
    throw new TypeError("Option A requires the audited, qualified room 101 pilot");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new RangeError("Invalid Qalvy timeout");
  }
  if (!Number.isInteger(maxClaimedTurns) || maxClaimedTurns < 1 || maxClaimedTurns > MAX_CLAIMED_TURNS) {
    throw new RangeError("Invalid guest-turn claim capacity");
  }
  // A claim is retained even when the upstream outcome is unknown. Evicting it
  // would allow another dispatch. This bounded store covers one process only.
  const claimedTurns = new Set();
  let pilotClaimed = false;
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (env.QALVY_OPTION_B_ENABLED !== "true") return review(res, 503, "OPTION_B_DISABLED");
    if (optionA && env.QALVY_OPTION_A_ENABLED !== "true") return review(res, 503, "OPTION_A_DISABLED");
    if (optionA && env.QALVY_OPTION_B_ROOM_101_PILOT !== "true") return review(res, 503, "ROOM_101_PILOT_DISABLED");
    if (typeof transport !== "function") return review(res, 503, "OPTION_B_TRANSPORT_UNAVAILABLE");
    const input = req.body;
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).length !== (requireQualifiedService ? 4 : 3) ||
        !Object.hasOwn(input, "text") || !Object.hasOwn(input, "turnId") || !Object.hasOwn(input, "language") ||
        typeof input.text !== "string" || input.text.length > MAX_TEXT_LENGTH || !input.text.trim() ||
        typeof input.turnId !== "string" || !/^[0-9a-f]{64}$/.test(input.turnId) ||
        typeof input.language !== "string" ||
        !(requireQualifiedService ? PRIMARY_GUEST_LANGUAGE.test(input.language) :
          LEGACY_FIXTURE_LANGUAGES.has(input.language))) {
      return review(res, 400, "INVALID_GUEST_REQUEST");
    }
    const deviceId = req.prototypeDevice?.deviceId;
    if (typeof deviceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(deviceId)) {
      return review(res, 401, "AUTHENTICATED_DEVICE_REQUIRED");
    }
    const context = readGuestContext(req.prototypeDevice, resolveGuestContext);
    if (!context) return review(res, 503, "OPTION_B_CONTEXT_UNAVAILABLE");
    const service = requireQualifiedService && Object.hasOwn(input, "service") ?
      readQualifiedService(input.service) : null;
    if (requireQualifiedService && !service) {
      return review(res, 422, "TOWEL_SERVICE_REQUIRED");
    }
    if (room101Pilot && !isRoom101PilotRequest(context, input, service)) {
      return review(res, 422, "ROOM_101_PILOT_SCOPE_REQUIRED");
    }
    const config = readConfig(env);
    if (!config) return review(res, 503, "OPTION_B_CONFIG_INVALID");
    const claim = JSON.stringify([deviceId, input.turnId]);
    if (claimedTurns.has(claim)) return review(res, 409, "GUEST_TURN_ALREADY_CLAIMED");
    if (room101Pilot && pilotClaimed) return review(res, 409, "ROOM_101_PILOT_ALREADY_CLAIMED");
    if (claimedTurns.size >= maxClaimedTurns) return review(res, 503, "GUEST_TURN_CLAIMS_FULL");
    const body = encodeOptionB({
      ...context, agentId: config.agentId, text: input.text, language: input.language,
      service: room101Pilot ? null : service,
    });
    // Claim before the first await, including for timeouts and uncertain outcomes.
    claimedTurns.add(claim);
    const pilotEvidence = room101Pilot ? {
      turnId: input.turnId, room: context.room, language: input.language,
      action: service.action, quantity: service.quantity,
    } : null;
    if (pilotEvidence) {
      pilotClaimed = true;
      if (!reportPilotEvent(onPilotEvent, { phase: optionA ? "turn_claimed" : "dispatch", ...pilotEvidence })) {
        return review(res, 503, "ROOM_101_PILOT_LOG_UNAVAILABLE");
      }
    }
    if (optionA) {
      const delivery = await optionA({
        authenticatedDevice: req.prototypeDevice,
        turnId: input.turnId,
        occurredAt: Date.now(),
        text: input.text,
        language: input.language,
      }, {
        onAccepted: ({ operationId, idempotencyKey }) => onPilotEvent({
          phase: "option_a_accepted", ...pilotEvidence, operationId, idempotencyKey,
        }),
        onStatusObserved: (shape) => onPilotEvent({
          phase: "option_a_status", ...pilotEvidence, ...shape,
        }),
      });
      if (!reportPilotEvent(onPilotEvent, {
        phase: "option_a_result", ...pilotEvidence, outcome: delivery.status,
        operationId: delivery.operationId, idempotencyKey: delivery.idempotencyKey,
      })) return review(res, 503, "ROOM_101_PILOT_LOG_UNAVAILABLE");
      if (delivery.status !== "succeeded") {
        const status = {
          idempotency_conflict: 409, timeout: 504, invalid_config: 503,
          context_unavailable: 503, audit_unavailable: 503,
        }[delivery.status] ?? 502;
        return review(res, status, "OPTION_A_" + delivery.status.toUpperCase());
      }
      if (!reportPilotEvent(onPilotEvent, { phase: "option_b_dispatch", ...pilotEvidence })) {
        return review(res, 503, "ROOM_101_PILOT_LOG_UNAVAILABLE");
      }
    }
    const result = await sendOnce({ transport, url: config.url, key: config.key, body, timeoutMs });
    if (result.replyCheck) {
      // Emit only the check from the result that won the timeout race.
      try { onReplyRejected?.(result.replyCheck); } catch { /* Keep the rejection. */ }
    } else if (pilotEvidence && !reportPilotEvent(onPilotEvent, {
      phase: "result", ...pilotEvidence,
      routeStatus: result.reply ? 200 : result.status,
      outcome: result.reply ? "MIRROR_REPLY_VALIDATED" : result.reason,
    })) {
      return review(res, 503, "ROOM_101_PILOT_LOG_UNAVAILABLE");
    }
    return result.reply
      ? res.status(200).json({ status: "reply", mirrorReply: result.reply })
      : review(res, result.status, result.reason);
  };
}

// The pilot binds one authenticated TEST device to its server-configured room.
function resolveTestGuestContext(env, device) {
  if (device.deviceId !== env.QALVY_OPTION_B_TEST_DEVICE_ID) return null;
  return { room: env.QALVY_OPTION_B_TEST_ROOM, mirrorId: env.QALVY_OPTION_B_TEST_MIRROR_ID };
}

export function createQalvyHospitalityTestHandler({ env, transport, onPilotEvent, onReplyRejected, timeoutMs }) {
  return createQalvyHospitalityHandler({
    env,
    transport,
    onPilotEvent,
    onReplyRejected,
    timeoutMs,
    requireQualifiedService: true,
    room101Pilot: env.QALVY_OPTION_B_ROOM_101_PILOT === "true",
    resolveGuestContext: (device) => resolveTestGuestContext(env, device),
  });
}

export function createQalvyRoom101HospitalityHandler({ env, transport, onPilotEvent, onReplyRejected }) {
  const resolveGuestContext = (device) => resolveTestGuestContext(env, device);
  const optionA = createQalvyOptionAPrototype({
    env,
    transport,
    maxPolls: 7,
    pollIntervalMs: 750,
    resolveGuestContext(device) {
      const context = resolveGuestContext(device);
      return context && { ...context, hotelId: env.QALVY_OPTION_A_TEST_HOTEL_ID };
    },
  });
  return createQalvyHospitalityHandler({
    env, transport, onPilotEvent, onReplyRejected, resolveGuestContext, optionA,
    requireQualifiedService: true,
    room101Pilot: true,
  });
}
