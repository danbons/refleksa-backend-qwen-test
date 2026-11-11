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
      ` Use only this qualified action and write Mirror reply in language ${language}.`;
  }
  return JSON.stringify({
    model: agentId,
    stream: false,
    messages: [{ role: "user", content }],
  });
}

// Only the written email layout is supported. "Mirror response:" is not
// established as an API alias. No internal field is copied into speech.
const EMAIL_FIELDS = ["Department: ", "Room: ", "Request: ", "Urgency: ", "Guest wording: "];
function mirrorReply(content) {
  if (typeof content !== "string" || content.length > 2_000) return null;
  const normalized = content.replace(/\r\n/g, "\n");
  if (/[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]|\p{Cf}/u.test(normalized)) return null;
  const lines = normalized.trim().split("\n");
  if (lines.length !== 7 || lines[5] !== "" ||
      !EMAIL_FIELDS.every((field, i) => lines[i].startsWith(field) &&
        lines[i].slice(field.length).trim() && !/\bMirror (?:reply|response)\s*:/i.test(lines[i]))) {
    return null;
  }
  const match = /^Mirror reply: "([^"\r\n\u2028\u2029]+)"$/u.exec(lines[6]);
  const reply = match?.[1].trim();
  if (!reply ||
      /\b(?:department|room|request|urgency|guest wording|mirror reply|mirror response)\s*:|[<>\x00-\x1f\x7f]|\p{Cf}/iu.test(reply)) return null;
  // Keep the validated guest-facing outcome verbatim. Punctuation inside the
  // phrase makes a safe single-phrase interpretation ambiguous in this pilot.
  if (!/^[^.!?…。！？؟۔।॥։።]+[.!?。！？؟۔।॥։።]?$/u.test(reply) || !/\p{L}/u.test(reply)) return null;
  return reply;
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
      const reply = mirrorReply(content);
      return reply ? { reply } : { status: 200, reason: "MIRROR_REPLY_AMBIGUOUS" };
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
  room101Pilot = false, onPilotEvent, timeoutMs = 5_000, maxClaimedTurns = MAX_CLAIMED_TURNS,
}) {
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
      if (!reportPilotEvent(onPilotEvent, { phase: "dispatch", ...pilotEvidence })) {
        return review(res, 503, "ROOM_101_PILOT_LOG_UNAVAILABLE");
      }
    }
    const result = await sendOnce({ transport, url: config.url, key: config.key, body, timeoutMs });
    if (pilotEvidence && !reportPilotEvent(onPilotEvent, {
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
// No context supplied in the request can select a different room or mirror.
export function createQalvyHospitalityTestHandler({ env, transport, onPilotEvent, timeoutMs }) {
  return createQalvyHospitalityHandler({
    env,
    transport,
    onPilotEvent,
    timeoutMs,
    requireQualifiedService: true,
    room101Pilot: env.QALVY_OPTION_B_ROOM_101_PILOT === "true",
    resolveGuestContext(device) {
      if (device.deviceId !== env.QALVY_OPTION_B_TEST_DEVICE_ID) return null;
      return {
        room: env.QALVY_OPTION_B_TEST_ROOM,
        mirrorId: env.QALVY_OPTION_B_TEST_MIRROR_ID,
      };
    },
  });
}
