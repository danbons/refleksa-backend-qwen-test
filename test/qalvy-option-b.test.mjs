import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { after, mock, test } from "node:test";
import {
  createQalvyHospitalityHandler,
  createQalvyHospitalityTestHandler,
} from "../hospitality/qalvy-option-b.mjs";

let realTransportAttempts = 0;
const denyRealTransport = () => {
  realTransportAttempts++;
  throw new Error("Network not permitted in this suite");
};
mock.method(http, "request", denyRealTransport);
mock.method(https, "request", denyRealTransport);
mock.method(globalThis, "fetch", denyRealTransport);
after(() => assert.equal(realTransportAttempts, 0));

const text = "Could you bring us two towels?";
const spoken = "I’ve noted your request for two towels.";
const request = Object.freeze({ text, turnId: "a".repeat(64), language: "en" });
const prototypeDevice = Object.freeze({ deviceId: "authenticated-device-placeholder" });
const guestContext = Object.freeze({ room: "101", mirrorId: "mirror-01" });
// Internal example fields are deliberately present. The final SAY: line is a
// synthetic fixture for Roland's newly confirmed format, not captured HTTP.
const precedingLines = [
  "Department: Housekeeping",
  "Room: 101",
  "Request: two towels",
  "Urgency: normal",
  'Guest wording: "Could you bring us two towels?"',
].join("\n");
const sayContent = `${precedingLines}\n\nSAY: ${spoken}`;
const oldEmailContent = `${precedingLines}\n\nMirror reply: "Of course, two towels are on their way."`;
const env = Object.freeze({
  QALVY_OPTION_B_ENABLED: "true",
  QALVY_BASE_URL: "https://qalvy.invalid",
  QALVY_BEARER_TOKEN: "fixture-bearer-placeholder",
  QALVY_AGENT_ID: "fixture-agent-placeholder",
});
const testDeviceEnv = Object.freeze({
  ...env,
  QALVY_OPTION_B_TEST_DEVICE_ID: prototypeDevice.deviceId,
  QALVY_OPTION_B_TEST_ROOM: guestContext.room,
  QALVY_OPTION_B_TEST_MIRROR_ID: guestContext.mirrorId,
});
const qualifiedRequest = Object.freeze({
  ...request, service: { action: "bring_towels", quantity: 2 },
});

const upstream = (content) => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
const success = () => upstream(sayContent);

function capture() {
  const result = { headers: {} };
  const res = {
    setHeader(name, value) { result.headers[name] = value; },
    status(status) { result.status = status; return this; },
    json(body) { result.body = body; return this; },
  };
  return { res, result };
}

async function invoke(handler, body = request, device = prototypeDevice) {
  const { res, result } = capture();
  await handler({ body, prototypeDevice: device }, res);
  return result;
}

function harness(impl = success, overrides = {}) {
  const calls = [];
  const handler = createQalvyHospitalityHandler({
    env,
    resolveGuestContext: (device) => device === prototypeDevice ? guestContext : null,
    transport: (url, options) => {
      calls.push({ url, options });
      return impl(url, options);
    },
    ...overrides,
  });
  return { handler, calls };
}

function assertReview(result, status, reason) {
  assert.equal(result.status, status);
  assert.deepEqual(result.body, { status: "review_required", reason });
  assert.equal(Object.hasOwn(result.body, "mirrorReply"), false);
}

test("default OFF: no credential lookup or transport", async () => {
  const closedEnv = {
    get QALVY_BEARER_TOKEN() { assert.fail("read credentials while disabled"); },
    get QALVY_AGENT_ID() { assert.fail("read agent while disabled"); },
  };
  const { handler, calls } = harness(success, { env: closedEnv });
  assertReview(await invoke(handler), 503, "OPTION_B_DISABLED");
  assert.equal(calls.length, 0);
});

test("no transport: explicit enable still fails closed", async () => {
  const { handler, calls } = harness(success, { transport: undefined });
  assertReview(await invoke(handler), 503, "OPTION_B_TRANSPORT_UNAVAILABLE");
  assert.equal(calls.length, 0);
});

test("missing or invalid server-side guest context never dispatches", async () => {
  for (const resolveGuestContext of [
    undefined,
    () => null,
    () => ({}),
    () => ({ ...guestContext, room: "101\nGuest request:" }),
    () => ({ ...guestContext, mirrorId: "mirror-01, foreign" }),
  ]) {
    const { handler, calls } = harness(success, { resolveGuestContext });
    assertReview(await invoke(handler), 503, "OPTION_B_CONTEXT_UNAVAILABLE");
    assert.equal(calls.length, 0);
  }
});

test("missing config or non-HTTPS origin never dispatches", async () => {
  for (const config of [
    { ...env, QALVY_AGENT_ID: undefined },
    { ...env, QALVY_BEARER_TOKEN: "x\r\nnot-a-header" },
    { ...env, QALVY_BASE_URL: "http://qalvy.invalid" },
    { ...env, QALVY_BASE_URL: "https://qalvy.invalid/path" },
  ]) {
    const { handler, calls } = harness(success, { env: config });
    assertReview(await invoke(handler), 503, "OPTION_B_CONFIG_INVALID");
    assert.equal(calls.length, 0);
  }
});

test("caller cannot override agent, destination, guest context or request bounds", async () => {
  const { handler, calls } = harness();
  for (const body of [
    { ...request, agentId: "foreign" }, { ...request, url: "https://other.invalid" },
    { ...request, room: "102" }, { ...request, mirrorId: "other-mirror" },
    { ...request, deviceId: "foreign" }, { ...request, language: "IT" }, { ...request, language: "de" },
    { ...request, text: " " }, { ...request, text: "a".repeat(1001) },
    { ...request, turnId: "A".repeat(64) }, { ...request, turnId: "a".repeat(63) },
    { ...request, turnId: "a".repeat(64) + "\n" }, { text }, { text, language: "en" },
  ]) {
    assertReview(await invoke(handler, body), 400, "INVALID_GUEST_REQUEST");
  }
  assert.equal(calls.length, 0);
});

test("Roland SAY format: one documented POST and only the final guest-facing sentence", async () => {
  let resolvedDevice;
  const { handler, calls } = harness(success, {
    resolveGuestContext(device) {
      resolvedDevice = device;
      return guestContext;
    },
  });
  const result = await invoke(handler);
  assert.equal(resolvedDevice, prototypeDevice);
  assert.deepEqual(result.body, { status: "reply", mirrorReply: spoken });
  assert.equal(result.status, 200);
  assert.equal(result.headers["Cache-Control"], "no-store");
  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.equal(url, "https://qalvy.invalid/qalvy/api/agents/v1/chat/completions");
  assert.equal(options.method, "POST");
  assert.equal(options.headers.Authorization, "Bearer fixture-bearer-placeholder");
  assert.equal(options.headers["Content-Type"], "application/json");
  assert.equal(options.redirect, "error");
  assert.deepEqual(JSON.parse(options.body), {
    model: "fixture-agent-placeholder",
    stream: false,
    messages: [{
      role: "user",
      content: 'Guest request from room 101 (mirror-01, language en): "Could you bring us two towels?"',
    }],
  });
});

test("Italian service request carries the guest language with server-owned room and mirror", async () => {
  const italianText = "Mi portate due asciugamani?";
  const italianReply = "Questa è una risposta di prova.";
  const italianContent = sayContent
    .replace(`Guest wording: "${text}"`, `Guest wording: "${italianText}"`)
    .replace(`SAY: ${spoken}`, `SAY: ${italianReply}`);
  const { handler, calls } = harness(() => upstream(italianContent));
  const result = await invoke(handler, { ...request, text: italianText, language: "it" });
  assert.deepEqual(result.body, { status: "reply", mirrorReply: italianReply });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].options.body).messages, [{
    role: "user",
    content: 'Guest request from room 101 (mirror-01, language it): "Mi portate due asciugamani?"',
  }]);
});

test("French reformulation and duplicate callback preserve original transcript and outcome", async () => {
  const frenchText = "  Pourriez-vous déposer deux serviettes supplémentaires dans notre chambre, s’il vous plaît ?  ";
  const frenchReply = "La demande a été transmise, mais la livraison reste à confirmer.";
  const frenchContent = sayContent
    .replace('Guest wording: "Could you bring us two towels?"', () => `Guest wording: ${JSON.stringify(frenchText)}`)
    .replace(`SAY: ${spoken}`, `SAY: ${frenchReply}`);
  const { handler, calls } = harness(() => upstream(frenchContent));
  const frenchRequest = { text: frenchText, turnId: "f".repeat(64), language: "fr" };

  const [original, duplicate] = await Promise.all([
    invoke(handler, frenchRequest),
    invoke(handler, { ...frenchRequest }),
  ]);

  assert.equal(original.status, 200);
  assert.deepEqual(original.body, { status: "reply", mirrorReply: frenchReply });
  assertReview(duplicate, 409, "GUEST_TURN_ALREADY_CLAIMED");
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].options.body).messages, [{
    role: "user",
    content: `Guest request from room 101 (mirror-01, language fr): ${JSON.stringify(frenchText)}`,
  }]);
});

test("single-phrase policy never truncates or rewords a qualified upstream outcome", async () => {
  for (const reply of [
    "La demande est transmise. La livraison n’est pas confirmée.",
    "La demande est transmise.La livraison n’est pas confirmée.",
    "La demande est transmise!la livraison n’est pas confirmée.",
    "...",
  ]) {
    const content = sayContent.replace(`SAY: ${spoken}`, `SAY: ${reply}`);
    const { handler, calls } = harness(() => upstream(content));
    assertReview(await invoke(handler, { ...request, language: "fr" }), 200, "MIRROR_REPLY_AMBIGUOUS");
    assertReview(await invoke(handler, { ...request, language: "fr" }), 409, "GUEST_TURN_ALREADY_CLAIMED");
    assert.equal(calls.length, 1);
  }
});

test("no authenticated device never claims or dispatches a turn", async () => {
  const { handler, calls } = harness();
  assertReview(await invoke(handler, request, null), 401, "AUTHENTICATED_DEVICE_REQUIRED");
  assert.equal(calls.length, 0);
  assert.deepEqual((await invoke(handler)).body, { status: "reply", mirrorReply: spoken });
  assert.equal(calls.length, 1);
});

test("concurrent and later duplicates of the same authenticated turn are never dispatched", async () => {
  let complete;
  const pending = new Promise((resolve) => { complete = resolve; });
  const { handler, calls } = harness(() => pending);
  const first = invoke(handler);
  try {
    assertReview(await invoke(handler), 409, "GUEST_TURN_ALREADY_CLAIMED");
    assertReview(await invoke(handler, { ...request, language: "it" }), 409, "GUEST_TURN_ALREADY_CLAIMED");
    assert.equal(calls.length, 1);
  } finally {
    complete(success());
  }
  assert.deepEqual((await first).body, { status: "reply", mirrorReply: spoken });
  assertReview(await invoke(handler), 409, "GUEST_TURN_ALREADY_CLAIMED");
  assert.equal(calls.length, 1);
});

test("turn ownership is scoped to authenticated device and capacity fails closed without eviction", async () => {
  const second = { deviceId: "second-authenticated-device" };
  const third = { deviceId: "third-authenticated-device" };
  const { handler, calls } = harness(success, {
    resolveGuestContext: () => guestContext,
    maxClaimedTurns: 2,
  });
  assert.equal((await invoke(handler)).status, 200);
  assert.equal((await invoke(handler, request, second)).status, 200);
  assertReview(await invoke(handler, request, third), 503, "GUEST_TURN_CLAIMS_FULL");
  assertReview(await invoke(handler), 409, "GUEST_TURN_ALREADY_CLAIMED");
  assert.equal(calls.length, 2);
});

test("only choices[0].message.content is inspected", async () => {
  const choices = [{ message: { content: "Unlabelled", get tool_calls() { assert.fail("read tool calls"); } } }];
  Object.defineProperty(choices, "1", { get: () => assert.fail("read second choice") });
  const { handler } = harness(() => ({
    ok: true,
    json: async () => ({ choices, get mirrorReply() { assert.fail("read alternative field"); } }),
  }));
  assertReview(await invoke(handler), 200, "MIRROR_REPLY_AMBIGUOUS");
});

test("accepts a final SAY line with CRLF, trailing spaces, and no blank separator", async () => {
  for (const content of [
    `SAY: ${spoken}   `,
    `${precedingLines}\nSAY: ${spoken}   \n  \n`,
    `${precedingLines}\n\nSAY:   ${spoken}  \n`.replaceAll("\n", "\r\n"),
  ]) {
    const checks = [];
    const { handler, calls } = harness(() => upstream(content), { onReplyRejected: (check) => checks.push(check) });
    assert.deepEqual((await invoke(handler)).body, { status: "reply", mirrorReply: spoken });
    assert.deepEqual(checks, []);
    assert.equal(calls.length, 1);
  }
});

test("previous Mirror reply and interface labels remain outside the SAY contract", async () => {
  for (const content of [oldEmailContent, oldEmailContent.replace("Mirror reply:", "Mirror response:")]) {
    const checks = [];
    const { handler, calls } = harness(() => upstream(content), { onReplyRejected: (check) => checks.push(check) });
    assertReview(await invoke(handler), 200, "MIRROR_REPLY_AMBIGUOUS");
    assert.deepEqual(checks, ["REPLY_LABEL_MISSING"]);
    assert.equal(calls.length, 1);
  }
});

test("SAY rejection emits only the fixed code for the first failed check", async (t) => {
  const fixtures = [
    ["missing SAY", precedingLines, "REPLY_LABEL_MISSING"],
    ["unlabelled sentence", spoken, "REPLY_LABEL_MISSING"],
    ["duplicate SAY", `${sayContent}\nSAY: A second reply.`, "REPLY_LABEL_DUPLICATE"],
    ["indented alternate duplicate", ` say : A competing reply.\n${sayContent}`, "REPLY_LABEL_DUPLICATE"],
    ["unexpected line after SAY", `${sayContent}\nInternal details.`, "REPLY_LABEL_NOT_FINAL"],
    ["indented marker", `  SAY: ${spoken}`, "REPLY_LABEL_FORMAT"],
    ["lowercase marker", `say: ${spoken}`, "REPLY_LABEL_FORMAT"],
    ["missing content field", undefined, "CONTENT_TYPE"],
    ["null content", null, "CONTENT_TYPE"],
    ["array content", [{ text: spoken }], "CONTENT_TYPE"],
    ["content limit", "x".repeat(2_001), "CONTENT_LENGTH"],
    ["trailing tab", `${sayContent}\t`, "CONTENT_CONTROL_CHAR"],
    ["Unicode line separator", "SAY: First\u2028second", "CONTENT_CONTROL_CHAR"],
    ["bidirectional format character", "SAY: Visible\u202Ehidden", "CONTENT_CONTROL_CHAR"],
    ["empty reply", "SAY:   \n", "REPLY_EMPTY"],
    ["markup", "SAY: <speak>Hidden details</speak>", "REPLY_UNSAFE_TEXT"],
    ["Markdown", "SAY: **Hidden details**", "REPLY_UNSAFE_TEXT"],
    ["internal label in reply", `SAY: Room: 101; ${spoken}`, "REPLY_UNSAFE_TEXT"],
    ["second marker on same line", `SAY: Please wait; SAY: ${spoken}`, "REPLY_UNSAFE_TEXT"],
    ["multiple sentences", "SAY: One sentence. Another.", "REPLY_SENTENCE"],
    ["no letters", "SAY: 123.", "REPLY_NO_LETTER"],
  ];
  for (const [name, content, check] of fixtures) {
    await t.test(name, async () => {
      const checks = [];
      const { handler, calls } = harness(() => upstream(content), {
        onReplyRejected: (...args) => checks.push(args),
      });
      assertReview(await invoke(handler), 200, "MIRROR_REPLY_AMBIGUOUS");
      assert.deepEqual(checks, [[check]]);
      assert.equal(calls.length, 1);
    });
  }
});

test("a late malformed response after timeout emits no parser rejection check", async () => {
  let finishBody;
  const checks = [];
  const { handler, calls } = harness(() => ({
    ok: true,
    json: () => new Promise((resolve) => { finishBody = resolve; }),
  }), { timeoutMs: 15, onReplyRejected: (...args) => checks.push(args) });
  assertReview(await invoke(handler), 504, "UPSTREAM_TIMEOUT");
  finishBody({ choices: [{ message: { content: "An unlabelled response." } }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(checks, []);
  assert.equal(calls.length, 1);
});

test("HTTP failures including redirect never consume upstream body and never retry", async () => {
  const { handler, calls } = harness(() => ({
    ok: false, status: 307, json: () => assert.fail("read unsuccessful response body"),
  }));
  assertReview(await invoke(handler), 502, "UPSTREAM_HTTP_ERROR");
  assert.equal(calls.length, 1);
});

test("transport errors are sanitized; a failed POST is not retried", async () => {
  const { handler, calls } = harness(() => { throw new Error("sensitive fixture detail"); });
  assertReview(await invoke(handler), 502, "UPSTREAM_TRANSPORT_ERROR");
  assertReview(await invoke(handler), 409, "GUEST_TURN_ALREADY_CLAIMED");
  assert.equal(calls.length, 1);
});

test("invalid JSON is review-required, not a spoken raw response", async () => {
  const { handler, calls } = harness(() => ({ ok: true, json: async () => { throw new SyntaxError("fixture raw body"); } }));
  assertReview(await invoke(handler), 502, "UPSTREAM_INVALID_RESPONSE");
  assert.equal(calls.length, 1);
});

test("unexpected response accessor failure is sanitized and never retried", async () => {
  const { handler, calls } = harness(() => ({ get ok() { throw new Error("fixture detail"); } }));
  assertReview(await invoke(handler), 502, "UPSTREAM_INVALID_RESPONSE");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.signal.aborted, true);
});

test("timeout before headers aborts once and does not retry", { timeout: 1000 }, async () => {
  const { handler, calls } = harness(() => new Promise(() => {}), { timeoutMs: 15 });
  assertReview(await invoke(handler), 504, "UPSTREAM_TIMEOUT");
  assertReview(await invoke(handler), 409, "GUEST_TURN_ALREADY_CLAIMED");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.signal.aborted, true);
});

test("timeout includes reading JSON and a late reply cannot become speech", { timeout: 1000 }, async () => {
  let finishBody;
  const { handler, calls } = harness(() => ({
    ok: true, json: () => new Promise((resolve) => { finishBody = resolve; }),
  }), { timeoutMs: 15 });
  const result = await invoke(handler);
  assertReview(result, 504, "UPSTREAM_TIMEOUT");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.signal.aborted, true);
  finishBody({ choices: [{ message: { content: sayContent } }] });
  await Promise.resolve();
  assertReview(result, 504, "UPSTREAM_TIMEOUT");
});

test("TEST route sends one authenticated Italian turn for its configured room only", async () => {
  const italian = {
    ...qualifiedRequest, language: "it", text: "Mi sostituite due asciugamani, per favore?",
    service: { action: "replace_towels", quantity: 2 },
  };
  const reply = "La richiesta è stata ricevuta per il collaudo.";
  const fixture = sayContent.replace(spoken, reply);
  const calls = [];
  const handler = createQalvyHospitalityTestHandler({
    env: testDeviceEnv,
    transport: (url, options) => {
      calls.push({ url, options });
      return upstream(fixture);
    },
  });
  assertReview(await invoke(handler, italian, { deviceId: "other-device" }), 503, "OPTION_B_CONTEXT_UNAVAILABLE");
  assert.equal(calls.length, 0);
  assert.deepEqual((await invoke(handler, italian)).body, { status: "reply", mirrorReply: reply });
  assertReview(await invoke(handler, italian), 409, "GUEST_TURN_ALREADY_CLAIMED");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://qalvy.invalid/qalvy/api/agents/v1/chat/completions");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    model: "fixture-agent-placeholder",
    stream: false,
    messages: [{
      role: "user",
      content: 'Guest request from room 101 (mirror-01, language it): "Mi sostituite due asciugamani, per favore?"\n' +
        "Qualified housekeeping action: replace 2 towels. Use only this qualified action and end with one SAY: line in language it.",
    }],
  });
});

test("TEST route accepts qualified Spanish and German reformulations and contextual confirmations once", async () => {
  const fixtures = [
    {
      language: "es", text: "Nos vendrían bien un par de toallas limpias en la habitación",
      service: { action: "bring_towels", quantity: 2 }, qualifiedAction: "bring 2 towels",
      reply: "La solicitud de dos toallas se ha enviado.",
    },
    {
      language: "es", text: "Sí, dos por favor",
      service: { action: "replace_towels", quantity: 2 }, qualifiedAction: "replace 2 towels",
      reply: "La solicitud de cambio de toallas se ha enviado.",
    },
    {
      language: "de", text: "Unsere Handtücher sind durchnässt, könnten wir frische bekommen?",
      service: { action: "replace_towels", quantity: null }, qualifiedAction: "replace towels (quantity unspecified)",
      reply: "Die Anfrage nach frischen Handtüchern wurde weitergeleitet.",
    },
    {
      language: "de", text: "Ja, bitte zwei",
      service: { action: "bring_towels", quantity: 2 }, qualifiedAction: "bring 2 towels",
      reply: "Die Anfrage für zwei Handtücher wurde weitergeleitet.",
    },
  ];
  const calls = [];
  const handler = createQalvyHospitalityTestHandler({
    env: testDeviceEnv,
    transport: (url, options) => {
      calls.push({ url, options });
      const fixture = fixtures[calls.length - 1];
      return upstream(sayContent.replace(spoken, fixture.reply));
    },
  });

  for (const [index, fixture] of fixtures.entries()) {
    const input = {
      text: fixture.text, turnId: (index + 1).toString().repeat(64),
      language: fixture.language, service: fixture.service,
    };
    const [first, duplicate] = await Promise.all([invoke(handler, input), invoke(handler, input)]);
    assert.deepEqual(first.body, { status: "reply", mirrorReply: fixture.reply });
    assertReview(duplicate, 409, "GUEST_TURN_ALREADY_CLAIMED");
    assert.equal(calls.length, index + 1);
    const { messages } = JSON.parse(calls[index].options.body);
    assert.deepEqual(messages, [{
      role: "user",
      content: `Guest request from room 101 (mirror-01, language ${fixture.language}): ${JSON.stringify(fixture.text)}\n` +
        `Qualified housekeeping action: ${fixture.qualifiedAction}. Use only this qualified action and end with one SAY: line in language ${fixture.language}.`,
    }]);
  }
});

test("TEST route rejects unqualified Spanish and German turns and extra scope before transport", async () => {
  const calls = [];
  const handler = createQalvyHospitalityTestHandler({
    env: testDeviceEnv,
    transport: (...args) => {
      calls.push(args);
      return success();
    },
  });
  for (const input of [
    { ...request, text: "¿Hay toallas en la habitación?", language: "es" },
    { ...request, text: "Bitte keine Handtücher bringen", language: "de" },
    { ...qualifiedRequest, history: ["unrelated preceding conversation"] },
    { ...qualifiedRequest, language: "de-DE" },
    { ...qualifiedRequest, language: "und" },
  ]) {
    assertReview(await invoke(handler, input), 400, "INVALID_GUEST_REQUEST");
  }
  for (const denied of [
    { text: "No cambien las toallas", language: "es", service: { action: "deny", quantity: null } },
    { text: "Könnten Sie uns zwei Kissen bringen?", language: "de", service: { action: "bring_pillows", quantity: 2 } },
    { text: "¿Hay toallas limpias?", language: "es", service: { action: "information", quantity: null } },
    { text: "Ja, bitte zwei", language: "de", service: { action: "clarify", quantity: 2 } },
    { service: { action: "bring_towels", quantity: 0 } },
    { service: { action: "replace_towels", quantity: 21 } },
    { service: { action: "bring_towels", quantity: "2" } },
    { service: { action: "bring_towels", quantity: 2, otherItem: "pillows" } },
  ]) {
    assertReview(await invoke(handler, { ...qualifiedRequest, ...denied }), 422, "TOWEL_SERVICE_REQUIRED");
  }
  assert.equal(calls.length, 0);
});

function room101Pilot({ overrides = {}, respond = success, onPilotEvent, onReplyRejected, timeoutMs } = {}) {
  const calls = [];
  const events = [];
  const pilotEnv = { ...testDeviceEnv, QALVY_OPTION_B_ROOM_101_PILOT: "true", ...overrides };
  const handler = createQalvyHospitalityTestHandler({
    env: pilotEnv,
    timeoutMs,
    onReplyRejected,
    onPilotEvent(event) {
      events.push(event);
      onPilotEvent?.(event);
    },
    transport(url, options) {
      calls.push({ url, options });
      return respond(url, options);
    },
  });
  return { handler, calls, events, pilotEnv };
}

test("room 101 pilot sends the exact Option B English fixture and returns only SAY text", async () => {
  const { handler, calls, events, pilotEnv } = room101Pilot();
  // Only startup selects the exact pilot protocol.
  pilotEnv.QALVY_OPTION_B_ROOM_101_PILOT = "false";
  const result = await invoke(handler, qualifiedRequest);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { status: "reply", mirrorReply: spoken });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://qalvy.invalid/qalvy/api/agents/v1/chat/completions");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.redirect, "error");
  assert.deepEqual(calls[0].options.headers, {
    Authorization: "Bearer fixture-bearer-placeholder", "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    model: "fixture-agent-placeholder",
    stream: false,
    messages: [{
      role: "user",
      content: 'Guest request from room 101 (mirror-01, language en): "Could you bring us two towels?"',
    }],
  });
  const common = { turnId: qualifiedRequest.turnId, room: "101", language: "en", action: "bring_towels", quantity: 2 };
  assert.deepEqual(events, [
    { phase: "dispatch", ...common },
    { phase: "result", ...common, routeStatus: 200, outcome: "MIRROR_REPLY_VALIDATED" },
  ]);
});

test("room 101 pilot normalizes the STT comparison while preserving the accepted text in Option B", async () => {
  const { handler, calls } = room101Pilot();
  const acceptedText = "could you bring us two towels.";
  assert.equal((await invoke(handler, { ...qualifiedRequest, text: acceptedText })).status, 200);
  assert.deepEqual(JSON.parse(calls[0].options.body).messages, [{
    role: "user",
    content: `Guest request from room 101 (mirror-01, language en): ${JSON.stringify(acceptedText)}`,
  }]);
});

test("room 101 pilot requires enablement, the bound TEST device, exact room, mirror and English towel request", async () => {
  const closed = room101Pilot({ overrides: { QALVY_OPTION_B_ENABLED: "false" } });
  assertReview(await invoke(closed.handler, qualifiedRequest), 503, "OPTION_B_DISABLED");
  assert.equal(closed.calls.length, 0);
  const { handler, calls, events } = room101Pilot();
  assertReview(await invoke(handler, qualifiedRequest, { deviceId: "different-device" }), 503, "OPTION_B_CONTEXT_UNAVAILABLE");
  for (const change of [
    { language: "it" },
    { service: { action: "replace_towels", quantity: 2 } },
    { service: { action: "bring_towels", quantity: 1 } },
    { text: "Could you bring us two pillows?" },
    { text: "Could you bring us two towels and a pillow?" },
    { text: "Please don't bring us two towels." },
  ]) {
    assertReview(await invoke(handler, { ...qualifiedRequest, ...change }), 422, "ROOM_101_PILOT_SCOPE_REQUIRED");
  }
  for (const overrides of [
    { QALVY_OPTION_B_TEST_ROOM: "102" },
    { QALVY_OPTION_B_TEST_MIRROR_ID: "mirror-02" },
  ]) {
    const foreign = room101Pilot({ overrides });
    assertReview(await invoke(foreign.handler, qualifiedRequest), 422, "ROOM_101_PILOT_SCOPE_REQUIRED");
    assert.equal(foreign.calls.length, 0);
  }
  assert.equal(calls.length, 0);
  assert.equal(events.length, 0);
  assert.equal((await invoke(handler, qualifiedRequest)).status, 200);
  assert.equal(calls.length, 1);
});

test("room 101 pilot claims before transport and rejects both replay and a distinct second turn", async () => {
  let release;
  const { handler, calls, events } = room101Pilot({ respond: () => new Promise((resolve) => { release = resolve; }) });
  const first = invoke(handler, qualifiedRequest);
  assert.equal(calls.length, 1);
  assert.deepEqual(events.map(({ phase }) => phase), ["dispatch"]);
  assertReview(await invoke(handler, qualifiedRequest), 409, "GUEST_TURN_ALREADY_CLAIMED");
  assertReview(await invoke(handler, { ...qualifiedRequest, turnId: "b".repeat(64) }), 409, "ROOM_101_PILOT_ALREADY_CLAIMED");
  release(success());
  assert.equal((await first).status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(events.map(({ phase }) => phase), ["dispatch", "result"]);
});

test("room 101 pilot is spent after a transport failure or timeout without a retry", async () => {
  for (const [respond, status, reason] of [
    [() => { throw new Error("fixture transport failure"); }, 502, "UPSTREAM_TRANSPORT_ERROR"],
    [() => new Promise(() => {}), 504, "UPSTREAM_TIMEOUT"],
  ]) {
    const { handler, calls, events } = room101Pilot({ respond, timeoutMs: 15 });
    assertReview(await invoke(handler, qualifiedRequest), status, reason);
    assertReview(await invoke(handler, { ...qualifiedRequest, turnId: "b".repeat(64) }), 409, "ROOM_101_PILOT_ALREADY_CLAIMED");
    assert.equal(calls.length, 1);
    assert.equal(events.length, 2);
    assert.equal(events[1].routeStatus, status);
    assert.equal(events[1].outcome, reason);
  }
});

test("pilot parser rejection emits the check alone and consumes the attempt", async () => {
  const checks = [];
  const { handler, calls, events } = room101Pilot({
    respond: () => upstream(sayContent.replace(spoken, "<speak>Hidden details</speak>")),
    onReplyRejected: (...args) => checks.push(args),
  });
  assertReview(await invoke(handler, qualifiedRequest), 200, "MIRROR_REPLY_AMBIGUOUS");
  assertReview(await invoke(handler, { ...qualifiedRequest, turnId: "b".repeat(64) }), 409, "ROOM_101_PILOT_ALREADY_CLAIMED");
  assert.equal(calls.length, 1);
  assert.deepEqual(events.map(({ phase }) => phase), ["dispatch"]);
  assert.deepEqual(checks, [["REPLY_UNSAFE_TEXT"]]);
});

test("pilot parser rejection never falls back to a metadata-bearing result log", async () => {
  const { handler, calls, events } = room101Pilot({ respond: () => upstream(precedingLines) });
  assertReview(await invoke(handler, qualifiedRequest), 200, "MIRROR_REPLY_AMBIGUOUS");
  assert.equal(calls.length, 1);
  assert.deepEqual(events.map(({ phase }) => phase), ["dispatch"]);
});

test("room 101 pilot burns the claim if its supplied dispatch audit callback throws", async () => {
  const { handler, calls } = room101Pilot({ onPilotEvent() { throw new Error("fixture audit error"); } });
  assertReview(await invoke(handler, qualifiedRequest), 503, "ROOM_101_PILOT_LOG_UNAVAILABLE");
  assertReview(await invoke(handler, { ...qualifiedRequest, turnId: "b".repeat(64) }), 409, "ROOM_101_PILOT_ALREADY_CLAIMED");
  assert.equal(calls.length, 0);
});
