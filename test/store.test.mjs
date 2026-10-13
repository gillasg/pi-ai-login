import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { FileCredentialStore, PiSettings } from "../dist/index.js";
import { tempAgentDir } from "./helpers.mjs";

test("credentials use Pi's auth.json format and keep other providers", async (t) => {
  const dir = tempAgentDir(t);
  const path = join(dir, "auth.json");
  writeFileSync(path, JSON.stringify({ anthropic: { type: "api_key", key: "existing" } }));
  const store = new FileCredentialStore(path);
  await store.modify("openai", async () => ({ type: "api_key", key: "sk-test" }));
  assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")), {
    anthropic: { type: "api_key", key: "existing" },
    openai: { type: "api_key", key: "sk-test" },
  });
  assert.deepEqual(await store.list(), [
    { providerId: "anthropic", type: "api_key" },
    { providerId: "openai", type: "api_key" },
  ]);
  await store.delete("anthropic");
  assert.equal(await store.read("anthropic"), undefined);
  assert.equal(existsSync(`${path}.lock`), false, "the lock is released");
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("parallel writes from many callers are never lost", async (t) => {
  const store = new FileCredentialStore(join(tempAgentDir(t), "auth.json"));
  await Promise.all(
    Array.from({ length: 25 }, (_, index) =>
      store.modify(`provider-${index}`, async () => ({ type: "api_key", key: String(index) })),
    ),
  );
  assert.equal((await store.list()).length, 25);
});

test("a corrupt auth.json is reported, never overwritten", async (t) => {
  const path = join(tempAgentDir(t), "auth.json");
  writeFileSync(path, "{ not json");
  const store = new FileCredentialStore(path);
  await assert.rejects(store.modify("openai", async () => ({ type: "api_key", key: "x" })));
  assert.equal(readFileSync(path, "utf-8"), "{ not json");
});

test("settings keep Pi's other keys and a stable device id", async (t) => {
  const path = join(tempAgentDir(t), "settings.json");
  writeFileSync(path, JSON.stringify({ theme: "dark", defaultThinkingLevel: "high" }));
  const settings = new PiSettings(path);
  await settings.setDefaultModel({ provider: "anthropic", model: "claude-x" });
  const id = await settings.deviceId();
  assert.equal(await settings.deviceId(), id);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")), {
    theme: "dark",
    defaultThinkingLevel: "high",
    defaultProvider: "anthropic",
    defaultModel: "claude-x",
    deviceId: id,
  });
  await settings.setDefaultModel(undefined);
  assert.equal(await settings.defaultModel(), undefined);
});
