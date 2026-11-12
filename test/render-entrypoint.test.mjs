import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Duplex } from "node:stream";
import test, { mock } from "node:test";
import express from "express";

const baseUrl = "https://qalvy-fixture.invalid";
const eventsPath = "/qalvy/api/agents/v1/events";
const chatPath = "/qalvy/api/agents/v1/chat/completions";
const operationId = "trigger_" + "a".repeat(64);
const foreignOperationId = "trigger_" + "b".repeat(64);
const statusMetadata = Object.freeze({ attempts: 1, updatedAt: 1_784_000_000_456 });
const statusPath = `${eventsPath}/${operationId}`;
const routePath = "/hospitality/requests";
const fixtureBearer = "fixture-only-bearer";
const guestText = "Could you bring us two towels?";
const mirrorReply = "Two towels are on their way.";
const turn = {
  text: guestText,
  language: "en",
  service: { action: "bring_towels", quantity: 2 },
  turnId: "a".repeat(64),
};

let fetchFixture;
let importSequence = 0;
mock.module("dotenv", { defaultExport: { config: () => ({ parsed: {} }) } });
mock.module("node-fetch", {
  defaultExport: (url, options) => {
    assert.ok(fetchFixture, "Outbound transport must be a test fixture");
    return fetchFixture(url, options);
  },
});

// Run HTTP parsing and the full Express middleware chain over an in-memory
// stream. The entrypoint's listen is captured before it can open a socket.
async function post(app, path, body, token) {
  const output = [];
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, done) {
      output.push(Buffer.from(chunk));
      done();
    },
  });
  try {
    const req = new http.IncomingMessage(stream);
    const payload = Buffer.from(JSON.stringify(body));
    const headers = {
      "content-type": "application/json",
      "content-length": String(payload.length),
    };
    if (token) headers.authorization = `Bearer ${token}`;
    Object.assign(req, {
      method: "POST", url: path, httpVersion: "1.1", httpVersionMajor: 1, httpVersionMinor: 1, headers,
      complete: true,
    });
    req.push(payload);
    req.push(null);
    const res = new http.ServerResponse(req);
    res.assignSocket(stream);
    const finished = once(res, "finish");
    app(req, res);
    await finished;
    const wire = Buffer.concat(output).toString("utf8");
    const headerEnd = wire.indexOf("\r\n\r\n");
    assert.ok(headerEnd >= 0, "Missing in-memory HTTP response");
    return { status: res.statusCode, body: JSON.parse(wire.slice(headerEnd + 4)) };
  } finally {
    stream.destroy();
  }
}

async function startEntry(t, { enabled, optionAEnabled = enabled, room = "101", transport }) {
  // Use an enabled record already present in the exact entrypoint. Never
  // display the device ID or the synthetic JWT issued by the access check.
  const source = await readFile(new URL("../server.js", import.meta.url), "utf8");
  const device = [...source.matchAll(
    /\{\s*deviceId:\s*"([A-Za-z0-9_-]+)",\s*partner:\s*"[^"]+",\s*enabled:\s*true,\s*expiresAt:\s*"([^"]+)"\s*\}/g,
  )].find((record) => Date.parse(record[2]) > Date.now());
  assert.ok(device, "No eligible device in the entrypoint authorization table");
  const deviceId = device[1];
  const fixtureEnv = {
    PORT: "3000",
    PROTOTYPE_JWT_SECRET: "fixture-only-signing-secret",
    QALVY_BASE_URL: baseUrl,
    QALVY_AGENT_ID: "fixture-agent",
    QALVY_BEARER_TOKEN: fixtureBearer,
    QALVY_OPTION_A_ENABLED: String(optionAEnabled),
    QALVY_OPTION_A_TEST_HOTEL_ID: "fixture-hotel",
    QALVY_OPTION_B_ENABLED: String(enabled),
    QALVY_OPTION_B_ROOM_101_PILOT: "true",
    QALVY_OPTION_B_TEST_DEVICE_ID: deviceId,
    QALVY_OPTION_B_TEST_ROOM: room,
    QALVY_OPTION_B_TEST_MIRROR_ID: "mirror-01",
  };
  const previous = Object.fromEntries(Object.keys(fixtureEnv).map((key) => [key, process.env[key]]));
  Object.assign(process.env, fixtureEnv);
  fetchFixture = transport;
  t.after(() => {
    fetchFixture = undefined;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  let app;
  let listenCalls = 0;
  t.mock.method(express.application, "listen", function () {
    listenCalls++;
    app = this;
  });
  const forbiddenNetwork = () => assert.fail("Unexpected real network access");
  t.mock.method(net.Server.prototype, "listen", forbiddenNetwork);
  t.mock.method(net.Socket.prototype, "connect", forbiddenNetwork);
  t.mock.method(http, "request", forbiddenNetwork);
  t.mock.method(https, "request", forbiddenNetwork);
  t.mock.method(globalThis, "fetch", forbiddenNetwork);
  t.mock.method(console, "log", () => {});
  const pilotEvents = [];
  t.mock.method(console, "info", (line) => {
    if (typeof line !== "string" || !line.startsWith("{")) return;
    const event = JSON.parse(line);
    if (event.event === "qalvy_room_101_pilot") pilotEvents.push(event);
  });
  await import(`../server.js?entrypoint-fixture=${++importSequence}`);
  assert.equal(listenCalls, 1, "The real server entrypoint must call the intercepted listener");
  assert.equal(typeof app, "function");

  const access = await post(app, "/prototype/access-check", {
    deviceId,
    appVersion: "Refleksa_Mirror_Edition_v1",
  });
  assert.equal(access.status, 200);
  assert.equal(access.body.allowed, true);
  assert.equal(access.body.killSwitch, false);
  const token = access.body.token;
  assert.equal(typeof token === "string" && token.split(".").length === 3, true);
  return { app, token, pilotEvents, deviceId };
}

function jsonResponse(status, body, headers) {
  return new Response(JSON.stringify(body), { status, headers });
}

function simulatedUpstream({ unexpectedGet } = {}) {
  const calls = [];
  let polls = 0;
  return {
    calls,
    transport(url, options) {
      const { origin, pathname } = new URL(url);
      assert.equal(origin, baseUrl);
      assert.equal(options.headers.Authorization, `Bearer ${fixtureBearer}`);
      const call = `${options.method} ${pathname}`;
      calls.push(call);
      if (call === `POST ${eventsPath}`) {
        const event = JSON.parse(options.body);
        assert.equal(event.event.payload.room, "101");
        assert.equal(event.event.payload.transcript, guestText);
        const location = statusPath.slice("/qalvy".length);
        return jsonResponse(202, { id: operationId }, { Location: location });
      }
      if (call === `GET ${statusPath}`) {
        if (unexpectedGet) return jsonResponse(200, unexpectedGet);
        return jsonResponse(200, {
          id: operationId, status: ["pending", "leased", "succeeded"][polls++], ...statusMetadata,
        });
      }
      if (call === `POST ${chatPath}`) {
        assert.equal(polls, 3);
        const chat = JSON.parse(options.body);
        assert.equal(chat.messages[0].content.includes(guestText), true);
        return jsonResponse(200, {
          choices: [{ message: { content: `Internal fixture\nSAY: ${mirrorReply}` } }],
        });
      }
      assert.fail("Unexpected simulated upstream request");
    },
  };
}

test("real Render entrypoint authenticates the APK route and stops locally with flags OFF", { timeout: 8_000 }, async (t) => {
  const upstream = simulatedUpstream();
  const { app, token } = await startEntry(t, { enabled: false, transport: upstream.transport });
  assert.equal((await post(app, routePath, turn)).status, 401);
  assert.equal((await post(app, routePath, turn, "invalid-jwt")).status, 401);
  const off = await post(app, routePath, turn, token);
  assert.equal(off.status, 503);
  assert.deepEqual(off.body, { status: "review_required", reason: "OPTION_B_DISABLED" });
  assert.deepEqual(upstream.calls, []);
});

test("real Render entrypoint refuses A OFF and a room binding outside the pilot", { timeout: 8_000 }, async (t) => {
  for (const [settings, status, reason] of [
    [{ optionAEnabled: false }, 503, "OPTION_A_DISABLED"],
    [{ room: "102" }, 422, "ROOM_101_PILOT_SCOPE_REQUIRED"],
  ]) {
    await t.test(reason, async (subtest) => {
      const upstream = simulatedUpstream();
      const { app, token } = await startEntry(subtest, {
        enabled: true, transport: upstream.transport, ...settings,
      });
      assert.deepEqual(await post(app, routePath, turn, token), {
        status,
        body: { status: "review_required", reason },
      });
      assert.deepEqual(upstream.calls, []);
    });
  }
});

test("real Render entrypoint runs one A event and terminal poll sequence before one B reply", { timeout: 8_000 }, async (t) => {
  const upstream = simulatedUpstream();
  const { app, token, pilotEvents } = await startEntry(t, { enabled: true, transport: upstream.transport });
  const accepted = await post(app, routePath, turn, token);
  assert.deepEqual(accepted, { status: 200, body: { status: "reply", mirrorReply } });
  assert.equal((await post(app, routePath, turn, token)).status, 409);
  assert.equal((await post(app, routePath, { ...turn, turnId: "b".repeat(64) }, token)).status, 409);
  assert.deepEqual(upstream.calls, [
    `POST ${eventsPath}`, `GET ${statusPath}`, `GET ${statusPath}`, `GET ${statusPath}`, `POST ${chatPath}`,
  ]);
  const statuses = pilotEvents.filter(({ phase }) => phase === "option_a_status");
  assert.deepEqual(statuses.map(({ observedStatus }) => observedStatus), ["pending", "leased", "succeeded"]);
  assert.equal(statuses.every((entry) => entry.operationId === operationId && entry.idMatches), true);
  assert.deepEqual(statuses.map(({ fieldCount }) => fieldCount), [4, 4, 4]);
});

test("real Render entrypoint retains the accepted A operation on an unexpected GET and skips B", { timeout: 8_000 }, async (t) => {
  for (const [name, unexpectedGet, statusType, observedStatus, idMatches] of [
    ["unknown status value", { id: operationId, status: "unrecognized" }, "string", "unexpected", true],
    ["missing status", { id: operationId, state: "unrecognized" }, "missing", "unexpected", true],
    ["wrong operation ID", { id: foreignOperationId, status: "succeeded" }, "string", "succeeded", false],
  ]) {
    await t.test(name, async (subtest) => {
      const upstream = simulatedUpstream({ unexpectedGet: { ...unexpectedGet, ...statusMetadata } });
      const { app, token, pilotEvents, deviceId } = await startEntry(subtest, {
        enabled: true, transport: upstream.transport,
      });
      const rejected = await post(app, routePath, turn, token);
      assert.deepEqual(rejected, {
        status: 502,
        body: { status: "review_required", reason: "OPTION_A_INVALID_STATUS" },
      });
      assert.equal((await post(app, routePath, turn, token)).status, 409);
      assert.deepEqual(upstream.calls, [`POST ${eventsPath}`, `GET ${statusPath}`]);
      assert.deepEqual(pilotEvents.map(({ phase }) => phase), [
        "turn_claimed", "option_a_accepted", "option_a_status", "option_a_result",
      ]);
      const [, accepted, observed, result] = pilotEvents;
      assert.equal(accepted.operationId, operationId);
      assert.equal(observed.operationId, operationId);
      assert.equal(result.operationId, operationId);
      assert.equal(observed.observedStatus, observedStatus);
      assert.equal(observed.statusType, statusType);
      assert.equal(observed.idMatches, idMatches);
      assert.equal(observed.fieldCount, 4);
      const records = JSON.stringify(pilotEvents);
      for (const value of [deviceId, token, fixtureBearer, guestText, "unrecognized", foreignOperationId,
        String(statusMetadata.updatedAt)]) {
        assert.equal(records.includes(value), false, "Pilot logs must exclude identity, credentials and transcript");
      }
    });
  }
});
