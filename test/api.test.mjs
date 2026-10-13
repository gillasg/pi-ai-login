import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getModel, NoModelError, setDefaultModel, status } from "../dist/index.js";
import { fakeModels, tempAgentDir } from "./helpers.mjs";

test("getModel explains how to sign in when nothing is connected", async (t) => {
  const agentDir = tempAgentDir(t);
  await assert.rejects(getModel({ agentDir, models: fakeModels(agentDir) }), NoModelError);
});

test("getModel returns a working model and prefers the user's default", async (t) => {
  const agentDir = tempAgentDir(t);
  const options = () => ({ agentDir, models: fakeModels(agentDir) });
  writeFileSync(
    join(agentDir, "auth.json"),
    JSON.stringify({ keyed: { type: "api_key", key: "k" } }),
  );
  assert.equal((await getModel(options())).model.id, "keyed-large");
  await setDefaultModel({ provider: "keyed", model: "keyed-small" }, options());
  const { models, model } = await getModel(options());
  assert.equal(model.id, "keyed-small");
  const reply = await models.completeSimple(model, {
    messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
  });
  assert.equal(reply.content[0].text, "hello from keyed");
  await assert.rejects(getModel({ ...options(), provider: "subscribed" }), /not available/);
});

test("status covers the providers Pi ships, most popular first", async (t) => {
  const state = await status({ agentDir: tempAgentDir(t) });
  const ids = state.providers.map((provider) => provider.id);
  for (const id of ["anthropic", "openai", "github-copilot", "openrouter"])
    assert.ok(ids.includes(id), id);
  assert.equal(ids[0], "anthropic");
  assert.deepEqual(
    state.providers[0].methods.map((method) => method.type),
    ["oauth", "api_key"],
  );
});

test("the command line prints status and manages the default model", (t) => {
  const agentDir = tempAgentDir(t);
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const run = (...args) =>
    execFileSync(process.execPath, [cli, ...args, "--agent-dir", agentDir], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  assert.match(run("--help"), /Sign in to AI models/);
  assert.match(run("default"), /not set/);
  assert.ok(JSON.parse(run("status", "--json")).providers.length > 10);
  assert.throws(() => run("default", "bad"), /provider\/model/);
});
