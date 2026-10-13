import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { FileCredentialStore } from "../dist/index.js";

/** A fresh Pi agent directory, removed after the test. */
export function tempAgentDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-ai-login-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeProvider(id, auth) {
  const core = createFauxCore({
    provider: id,
    models: [{ id: `${id}-large` }, { id: `${id}-small` }],
  });
  core.setResponses([fauxAssistantMessage("hello from " + id)]);
  return createProvider({
    id,
    name: id === "keyed" ? "Keyed AI" : "Subscribed AI",
    auth,
    models: core.models,
    api: { stream: core.stream, streamSimple: core.streamSimple },
  });
}

/** Two fake providers: one signs in with a pasted key, one with a browser sign-in and a pasted code. */
export function fakeModels(agentDir) {
  const store = new FileCredentialStore(join(agentDir, "auth.json"));
  const models = createModels({ credentials: store });
  models.setProvider(
    fakeProvider("keyed", {
      apiKey: {
        name: "Keyed AI API key",
        login: async (interaction) => ({
          type: "api_key",
          key: await interaction.prompt({ type: "secret", message: "Paste your Keyed AI key" }),
        }),
        resolve: async ({ credential }) =>
          credential?.key ? { auth: { apiKey: credential.key }, source: "auth.json" } : undefined,
      },
    }),
  );
  models.setProvider(
    fakeProvider("subscribed", {
      oauth: {
        name: "Subscribed AI",
        loginLabel: "Sign in with Subscribed AI",
        isSubscription: true,
        login: async (interaction) => {
          interaction.notify({ type: "auth_url", url: "https://example.com/authorize?x=1" });
          const code = await interaction.prompt({ type: "manual_code", message: "Paste the code" });
          return {
            type: "oauth",
            access: `access-${code}`,
            refresh: "refresh",
            expires: Date.now() + 3_600_000,
          };
        },
        refresh: async (credential) => credential,
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    }),
  );
  return models;
}

/** Reads server-sent events until `until(event)` is true. */
export async function readEvents(url, until, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(url, { signal: controller.signal });
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  try {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        if (!data) continue;
        const event = JSON.parse(data.slice(6));
        events.push(event);
        if (until(event, events)) return events;
      }
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return events;
}
