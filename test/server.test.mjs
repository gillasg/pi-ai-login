import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { startLoginServer } from "../dist/index.js";
import { fakeModels, readEvents, tempAgentDir } from "./helpers.mjs";

async function start(t, options = {}) {
  const agentDir = tempAgentDir(t);
  const server = await startLoginServer({
    agentDir,
    models: fakeModels(agentDir),
    openSignInPages: false,
    ...options,
  });
  t.after(() => server.close());
  const call = async (path, body, headers = {}) => {
    const response = await fetch(`${server.origin}/api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        "x-pi-ai-login-token": server.token,
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const events = (id) => `${server.origin}/api/logins/${id}/events?token=${server.token}`;
  return { server, agentDir, call, events };
}

const find = (state, id) => state.providers.find((provider) => provider.id === id);

test("serves the sign-in page with a strict content policy", async (t) => {
  const { server } = await start(t);
  const page = await fetch(`${server.origin}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(await page.text(), /Connect an AI model/);
  assert.equal((await fetch(`${server.origin}/app.js`)).status, 200);
  assert.equal((await fetch(`${server.origin}/package.json`)).status, 404);
  assert.match(server.url, /#token=/);
});

test("lists providers with their sign-in methods", async (t) => {
  const { call } = await start(t);
  const { status, body } = await call("state");
  assert.equal(status, 200);
  assert.deepEqual(find(body, "keyed").methods, [
    { type: "api_key", label: "Keyed AI API key", subscription: false },
  ]);
  assert.deepEqual(find(body, "subscribed").methods, [
    { type: "oauth", label: "Sign in with Subscribed AI", subscription: true },
  ]);
  assert.equal(find(body, "keyed").connected, false);
  assert.deepEqual(body.models, []);
});

test("an API key sign-in runs through the page and lands in auth.json", async (t) => {
  const { agentDir, call, events } = await start(t);
  const { body } = await call("logins", { provider: "keyed", method: "api_key" });
  const [prompt] = await readEvents(events(body.id), (event) => event.type === "prompt");
  assert.equal(prompt.kind, "secret");
  assert.equal(prompt.message, "Paste your Keyed AI key");
  const answered = await call(`logins/${body.id}/answer`, {
    promptId: prompt.promptId,
    value: "sk-123",
  });
  assert.equal(answered.status, 200);
  const all = await readEvents(events(body.id), (event) => event.type === "done");
  assert.equal(all.at(-1).credentialType, "api_key");
  const saved = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8"));
  assert.deepEqual(saved.keyed, { type: "api_key", key: "sk-123" });
  const state = (await call("state")).body;
  assert.equal(find(state, "keyed").connected, true);
  assert.deepEqual(
    state.models.map((model) => model.id),
    ["keyed-large", "keyed-small"],
  );
});

test("a browser sign-in shows the provider page, takes the pasted code, and signs out", async (t) => {
  const { call, events } = await start(t);
  const { body } = await call("logins", { provider: "subscribed", method: "oauth" });
  const seen = await readEvents(events(body.id), (event) => event.type === "prompt");
  assert.equal(seen[0].type, "auth_url");
  assert.equal(seen[0].url, "https://example.com/authorize?x=1");
  await call(`logins/${body.id}/answer`, { promptId: seen[1].promptId, value: "abc" });
  await readEvents(events(body.id), (event) => event.type === "done");
  const connected = find((await call("state")).body, "subscribed");
  assert.equal(connected.connection.type, "oauth");
  assert.equal(connected.connection.stored, true);
  assert.ok(connected.connection.expires > Date.now());
  assert.equal((await call("logout", { provider: "subscribed" })).status, 200);
  assert.equal(find((await call("state")).body, "subscribed").connected, false);
});

test("a cancelled sign-in reports it and saves nothing", async (t) => {
  const { agentDir, call, events } = await start(t);
  const { body } = await call("logins", { provider: "keyed", method: "api_key" });
  await readEvents(events(body.id), (event) => event.type === "prompt");
  await call(`logins/${body.id}/cancel`, {});
  const all = await readEvents(events(body.id), (event) => event.type === "cancelled");
  assert.equal(all.at(-1).type, "cancelled");
  const path = join(agentDir, "auth.json");
  const saved = existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : {};
  assert.equal(saved.keyed, undefined);
});

test("the default model is validated and saved to Pi's settings", async (t) => {
  const { agentDir, call } = await start(t);
  assert.equal((await call("default-model", { provider: "keyed", model: "nope" })).status, 400);
  const saved = await call("default-model", { provider: "keyed", model: "keyed-small" });
  assert.equal(saved.status, 200);
  const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
  assert.equal(settings.defaultProvider, "keyed");
  assert.equal(settings.defaultModel, "keyed-small");
  assert.deepEqual((await call("state")).body.defaultModel, {
    provider: "keyed",
    model: "keyed-small",
  });
});

test("refuses calls without the token, from other websites and through other host names", async (t) => {
  const { server, call } = await start(t);
  assert.equal((await call("state", undefined, { "x-pi-ai-login-token": "wrong" })).status, 401);
  assert.equal((await call("state", undefined, { origin: "https://evil.example" })).status, 403);
  const extension = await fetch(`${server.origin}/api/state`, {
    headers: { origin: "chrome-extension://abcdef", "x-pi-ai-login-token": server.token },
  });
  assert.equal(extension.status, 200);
  assert.equal(extension.headers.get("access-control-allow-origin"), "chrome-extension://abcdef");
  const rebound = await new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: server.port,
        path: "/api/state",
        headers: { host: "evil.example" },
      },
      (res) => resolve(res.statusCode),
    );
    req.on("error", reject).end();
  });
  assert.equal(rebound, 403);
});

test("pressing Done tells the waiting app", async (t) => {
  const { server, call } = await start(t);
  const done = new Promise((resolve) => server.events.once("done", resolve));
  await call("done", {});
  await done;
});
