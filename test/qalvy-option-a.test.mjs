import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { after, mock, test } from "node:test";
import { createQalvyOptionAPrototype } from "../hospitality/qalvy-option-a.mjs";

let networkAttempts = 0;
const denyNetwork = () => {
  networkAttempts++;
  throw new Error("Network is forbidden in Option A tests");
};
mock.method(http, "request", denyNetwork);
mock.method(https, "request", denyNetwork);
mock.method(globalThis, "fetch", denyNetwork);
after(() => assert.equal(networkAttempts, 0));

const env = Object.freeze({
  QALVY_BASE_URL: "https://qalvy.invalid",
  QALVY_BEARER_TOKEN: "fixture-bearer-placeholder",
  QALVY_AGENT_ID: "fixture-agent-placeholder",
});
const postUrl = env.QALVY_BASE_URL + "/qalvy/api/agents/v1/events";
const operationId = "trigger_" + "aBc123ef".repeat(8);
const statusUrl = postUrl + "/" + operationId;
const context = Object.freeze({ hotelId: "demo-hotel", mirrorId: "mirror-01", room: "101" });
const device = Object.freeze({ deviceId: "authenticated-device-placeholder" });
const acceptedTurn = Object.freeze({
  authenticatedDevice: device,
  turnId: "a".repeat(64),
  occurredAt: 1_784_000_000_123,
  language: "en",
  text: "Could you bring us two towels?",
});

const reply = (status, body, location) => ({
  status,
  headers: new Headers(location ? { Location: location } : {}),
  json: async () => body,
});
const accepted = () => reply(202, { id: operationId }, statusUrl);
const status = (value, id = operationId) => reply(200, { id, status: value });

function makeDispatch(transport, overrides = {}) {
  return createQalvyOptionAPrototype({
    env,
    transport,
    resolveGuestContext: (authenticatedDevice) => authenticatedDevice.deviceId === device.deviceId ? context : null,
    pollIntervalMs: 0,
    ...overrides,
  });
}

// Models upstream byte-for-byte idempotency. Each identical POST returns the
// same operation; a different body under the same key returns HTTP 409.
function fakeProvider(states = ["pending", "leased", "succeeded"]) {
  const calls = [];
  const bodies = new Map();
  const transport = (url, options) => {
    calls.push({ url, ...options });
    if (options.method === "POST") {
      assert.equal(url, postUrl);
      const key = options.headers["Idempotency-Key"];
      assert.match(key, /^[0-9a-f]{64}$/);
      assert.equal(JSON.parse(options.body).event.id, key);
      if (bodies.has(key) && bodies.get(key) !== options.body) {
        return { status: 409, json: () => assert.fail("Do not read the conflict body") };
      }
      bodies.set(key, options.body);
      return accepted();
    }
    assert.equal(options.method, "GET");
    assert.equal(url, statusUrl);
    return status(states.length > 1 ? states.shift() : states[0]);
  };
  return { calls, bodies, transport };
}

test("Option A serializes the authenticated room, submits once and reads through succeeded", async () => {
  const { transport, calls } = fakeProvider();
  const dispatch = makeDispatch(transport);
  const result = await dispatch({
    ...acceptedTurn, hotelId: "caller-hotel", mirrorId: "caller-mirror", room: "999",
  });

  assert.match(result.idempotencyKey, /^[a-f0-9]{64}$/);
  assert.deepEqual(result, { status: "succeeded", operationId, idempotencyKey: result.idempotencyKey });
  assert.notEqual(result.operationId, result.idempotencyKey);
  assert.deepEqual(calls.map(({ method, url }) => [method, url]), [
    ["POST", postUrl], ["GET", statusUrl], ["GET", statusUrl], ["GET", statusUrl],
  ]);
  assert.deepEqual(calls[0].headers, {
    Authorization: "Bearer fixture-bearer-placeholder",
    "Content-Type": "application/json",
    "Idempotency-Key": result.idempotencyKey,
  });
  assert.deepEqual(JSON.parse(calls[0].body), {
    mode: "fire",
    event: {
      id: result.idempotencyKey,
      type: "guest.request",
      occurredAt: acceptedTurn.occurredAt,
      payload: {
        hotelId: "demo-hotel", mirrorId: "mirror-01", room: "101", language: "en",
        transcript: acceptedTurn.text,
      },
    },
    target: { agentId: "fixture-agent-placeholder" },
    input: 'Guest request from room 101 (mirror-01, language en): "Could you bring us two towels?"',
  });
  assert.ok(calls.every(({ redirect }) => redirect === "error"));
  for (const poll of calls.slice(1)) {
    assert.deepEqual(poll.headers, { Authorization: "Bearer fixture-bearer-placeholder", Accept: "application/json" });
    assert.equal(Object.hasOwn(poll, "body"), false);
  }
});

test("Location with or without the proxy prefix resolves to the same pinned GET", async () => {
  const path = new URL(statusUrl).pathname;
  const unprefixed = path.slice("/qalvy".length);
  for (const location of [path, unprefixed, env.QALVY_BASE_URL + unprefixed]) {
    const urls = [];
    const dispatch = makeDispatch((url, options) => {
      urls.push(url);
      return options.method === "POST" ? reply(202, { id: operationId }, location) : status("succeeded");
    });
    assert.equal((await dispatch(acceptedTurn)).status, "succeeded");
    assert.deepEqual(urls, [postUrl, statusUrl]);
  }
});

test("identical turns use byte-identical bodies and one key across adapter instances", async () => {
  const { transport, calls, bodies } = fakeProvider(["succeeded"]);
  const original = await makeDispatch(transport)(acceptedTurn);
  const replay = await makeDispatch(transport)({ ...acceptedTurn });
  assert.deepEqual(replay, original);
  const [first, second] = calls.filter(({ method }) => method === "POST");
  assert.equal(first.headers["Idempotency-Key"], second.headers["Idempotency-Key"]);
  assert.equal(first.body, second.body);
  assert.equal(bodies.size, 1);
});

test("same key with a changed body gets an upstream 409 without polling or retrying", async () => {
  const { transport, calls, bodies } = fakeProvider(["succeeded"]);
  const original = await makeDispatch(transport)(acceptedTurn);
  const originalBody = bodies.get(original.idempotencyKey);
  const dispatch = makeDispatch(transport);
  const conflict = await dispatch({ ...acceptedTurn, text: "Could you replace our two towels?" });
  assert.deepEqual(conflict, {
    status: "idempotency_conflict", httpStatus: 409, idempotencyKey: original.idempotencyKey,
  });
  assert.deepEqual(calls.map(({ method }) => method), ["POST", "GET", "POST"]);
  assert.notEqual(calls.at(-1).body, originalBody);
  assert.equal(bodies.get(original.idempotencyKey), originalBody);
  assert.deepEqual(await dispatch({ ...acceptedTurn, text: "Could you replace our two towels?" }), {
    status: "already_claimed", idempotencyKey: original.idempotencyKey,
  });
  assert.equal(calls.length, 3);
});

test("a concurrent duplicate and a local mutation cannot send another POST", async () => {
  let release;
  const requests = [];
  const dispatch = makeDispatch((url, { method }) => {
    requests.push([method, url]);
    return method === "POST" ? new Promise((resolve) => { release = resolve; }) : status("succeeded");
  });
  const first = dispatch(acceptedTurn);
  const duplicate = await dispatch(acceptedTurn);
  assert.equal(duplicate.status, "already_claimed");
  assert.deepEqual(await dispatch({ ...acceptedTurn, occurredAt: acceptedTurn.occurredAt + 1 }), {
    status: "idempotency_conflict", httpStatus: 409, idempotencyKey: duplicate.idempotencyKey,
  });
  assert.deepEqual(requests, [["POST", postUrl]]);
  release(accepted());
  assert.deepEqual(await first, { status: "succeeded", operationId, idempotencyKey: duplicate.idempotencyKey });
  assert.deepEqual(requests, [["POST", postUrl], ["GET", statusUrl]]);
});

test("different devices and turns have different idempotency keys", async () => {
  const { transport } = fakeProvider(["succeeded"]);
  const dispatch = makeDispatch(transport, { resolveGuestContext: () => context });
  const original = await dispatch(acceptedTurn);
  const otherDevice = await dispatch({ ...acceptedTurn, authenticatedDevice: { deviceId: "second-fixture-device" } });
  const otherTurn = await dispatch({ ...acceptedTurn, turnId: "b".repeat(64) });
  assert.ok([original, otherDevice, otherTurn].every(({ status }) => status === "succeeded"));
  assert.equal(new Set([original.idempotencyKey, otherDevice.idempotencyKey, otherTurn.idempotencyKey]).size, 3);
});

test("missing device, malformed input, unknown room and invalid config never send", async () => {
  const neverSend = () => assert.fail("A rejected turn reached the transport");
  const dispatch = makeDispatch(neverSend);
  for (const turn of [
    null, { ...acceptedTurn, authenticatedDevice: null },
    { ...acceptedTurn, authenticatedDevice: { deviceId: "mock\n" } },
    { ...acceptedTurn, turnId: "A".repeat(64) },
    { ...acceptedTurn, occurredAt: "1784000000123" },
    { ...acceptedTurn, occurredAt: -1 },
    { ...acceptedTurn, language: "en\n" },
    { ...acceptedTurn, text: "a\nb" },
  ]) {
    assert.deepEqual(await dispatch(turn), { status: "invalid_turn" });
  }
  assert.deepEqual(await dispatch({ ...acceptedTurn, authenticatedDevice: { deviceId: "unbound" } }), {
    status: "context_unavailable",
  });
  assert.deepEqual(await makeDispatch(neverSend, { resolveGuestContext: () => ({ ...context, room: "101\n" }) })(acceptedTurn), {
    status: "context_unavailable",
  });
  for (const badEnv of [
    { ...env, QALVY_BASE_URL: "http://qalvy.invalid" },
    { ...env, QALVY_BASE_URL: "https://qalvy.invalid/extra" },
    { ...env, QALVY_BEARER_TOKEN: "fixture\nbearer" },
    { ...env, QALVY_AGENT_ID: undefined },
  ]) {
    assert.deepEqual(await makeDispatch(neverSend, { env: badEnv })(acceptedTurn), { status: "invalid_config" });
  }
});

test("202 with missing, inconsistent or foreign receipt never forwards the bearer", async () => {
  const invalidIds = [
    "operation-01",
    "trigger_" + "a".repeat(63),
    "trigger_" + "a".repeat(65),
    "trigger_" + "g".repeat(64),
  ];
  for (const receipt of [
    reply(202, {}, statusUrl),
    reply(202, { event: { id: operationId } }, statusUrl),
    ...invalidIds.map((id) => reply(202, { id }, postUrl + "/" + id)),
    reply(202, { id: operationId + "\n" }, statusUrl),
    reply(202, { id: operationId }),
    reply(202, { id: operationId }, statusUrl.replace("qalvy.invalid", "foreign.invalid")),
    reply(202, { id: operationId }, statusUrl.replace("https://qalvy.invalid", "//foreign.invalid")),
    reply(202, { id: operationId }, statusUrl.replace("qalvy.invalid/qalvy", "foreign.invalid")),
    reply(202, { id: operationId }, statusUrl.replace("qalvy.invalid", "fixture@qalvy.invalid")),
    reply(202, { id: operationId }, statusUrl + "?unexpected=1"),
    reply(202, { id: operationId }, statusUrl.replace(operationId, "other-id")),
    reply(202, { id: operationId }, statusUrl.replace(operationId, "../" + operationId)),
  ]) {
    const methods = [];
    const dispatch = makeDispatch((_url, { method }) => { methods.push(method); return receipt; });
    assert.equal((await dispatch(acceptedTurn)).status, "invalid_receipt");
    assert.deepEqual(methods, ["POST"]);
  }
});

test("only the accepted operation reaching succeeded confirms event delivery", async () => {
  for (const [response, expected] of [
    [status("queued"), "invalid_status"],
    [status("running"), "invalid_status"],
    [status("mystery"), "invalid_status"],
    [status("succeeded", "trigger_" + "b".repeat(64)), "invalid_status"],
    [reply(503, {}), "status_unavailable"],
  ]) {
    const methods = [];
    const dispatch = makeDispatch((_url, { method }) => {
      methods.push(method);
      return method === "POST" ? accepted() : response;
    });
    assert.equal((await dispatch(acceptedTurn)).status, expected);
    assert.deepEqual(methods, ["POST", "GET"]);
  }
});

test("dead is terminal, with no more polls or POST", async () => {
  const { transport, calls } = fakeProvider(["pending", "leased", "dead", "succeeded"]);
  const dispatch = makeDispatch(transport);
  const result = await dispatch(acceptedTurn);
  assert.deepEqual(result, { status: "dead", operationId, idempotencyKey: result.idempotencyKey });
  assert.equal((await dispatch(acceptedTurn)).status, "already_claimed");
  assert.deepEqual(calls.map(({ method }) => method), ["POST", "GET", "GET", "GET"]);
});

test("polls are bounded, and a leased event is not reported delivered", async () => {
  const { transport, calls } = fakeProvider(["leased"]);
  const dispatch = makeDispatch(transport, { maxPolls: 2 });
  const pending = await dispatch(acceptedTurn);
  assert.equal(pending.status, "poll_limit");
  assert.equal(pending.operationId, operationId);
  assert.deepEqual(calls.map(({ method }) => method), ["POST", "GET", "GET"]);
});

test("POST failure consumes the turn and does not retry or poll", async () => {
  let attempts = 0;
  const dispatch = makeDispatch(() => { attempts++; throw new Error("sensitive fixture detail"); });
  const failed = await dispatch(acceptedTurn);
  assert.deepEqual(failed, { status: "transport_error", idempotencyKey: failed.idempotencyKey });
  assert.equal((await dispatch(acceptedTurn)).status, "already_claimed");
  assert.equal(attempts, 1);
});

test("deadline aborts a pending POST and a late 202 cannot start polling", async () => {
  let release;
  const calls = [];
  const dispatch = makeDispatch((url, options) => {
    calls.push({ url, ...options });
    return new Promise((resolve) => { release = resolve; });
  }, { timeoutMs: 15 });
  assert.equal((await dispatch(acceptedTurn)).status, "timeout");
  assert.equal(calls[0].signal.aborted, true);
  release(accepted());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.map(({ method }) => method), ["POST"]);
});


test("an unexpected GET JSON keeps the accepted ID and stops polling", async () => {
  const methods = [];
  const receipts = [];
  const dispatch = makeDispatch((_url, { method }) => {
    methods.push(method);
    return method === "POST" ? accepted() : {
      status: 200, json: async () => { throw new SyntaxError("unexpected fixture JSON"); },
    };
  });
  const result = await dispatch(acceptedTurn, { onAccepted: (receipt) => receipts.push(receipt) });
  assert.deepEqual(result, { status: "invalid_status", operationId, idempotencyKey: result.idempotencyKey });
  assert.deepEqual(receipts, [{ operationId, idempotencyKey: result.idempotencyKey }]);
  assert.deepEqual(methods, ["POST", "GET"]);
  assert.equal((await dispatch(acceptedTurn)).status, "already_claimed");
});

test("GET body timeout retains the receipt, with no subsequent polling", async () => {
  const methods = [];
  let resolveBody;
  let getSignal;
  const dispatch = makeDispatch((_url, { method, signal }) => {
    methods.push(method);
    if (method === "POST") return accepted();
    getSignal = signal;
    return { status: 200, json: () => new Promise((resolve) => { resolveBody = resolve; }) };
  }, { timeoutMs: 30 });

  const result = await dispatch(acceptedTurn);
  assert.deepEqual(result, { status: "timeout", operationId, idempotencyKey: result.idempotencyKey });
  assert.equal(getSignal.aborted, true);
  resolveBody({ id: operationId, status: "leased" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(methods, ["POST", "GET"]);
});

test("unavailable receipt audit stops before reading status", async () => {
  const methods = [];
  const dispatch = makeDispatch((_url, { method }) => {
    methods.push(method);
    return accepted();
  });
  const result = await dispatch(acceptedTurn, { onAccepted() { throw new Error("audit fixture unavailable"); } });
  assert.deepEqual(result, { status: "audit_unavailable", operationId, idempotencyKey: result.idempotencyKey });
  assert.deepEqual(methods, ["POST"]);
});
