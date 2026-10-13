import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { PREFERRED_PROVIDERS } from "./catalog.js";
import { openBrowser } from "./open-browser.js";
import { startLoginServer, type LoginServerOptions } from "./server.js";
import { LoginService, type LoginState, type PiAiLoginOptions } from "./service.js";
import type { ModelChoice } from "./settings.js";

export { FileCredentialStore } from "./credential-store.js";
export { defaultAgentDir } from "./files.js";
export { LoginSession, type SessionEvent, type SessionState } from "./login-session.js";
export { PiSettings, type ModelChoice } from "./settings.js";
export { startLoginServer, type LoginServer, type LoginServerOptions } from "./server.js";
export { LoginError, LoginService, type LoginState, type PiAiLoginOptions } from "./service.js";
export type { ModelSummary, ProviderStatus, SignInMethod } from "./catalog.js";
export { openBrowser };

export interface LoginOptions extends LoginServerOptions {
  /** Open the sign-in page in the default browser. Default: true. */
  open?: boolean;
  /** Called with the page URL, e.g. to print it when no browser can be opened. */
  onUrl?: (url: string) => void;
  /**
   * When to finish. "done" (default): the user presses Done or closes the page.
   * "connected": as soon as any provider signs in.
   */
  until?: "done" | "connected";
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Shows the sign-in page in the browser and resolves when the user is finished.
 * Every login is saved to Pi's auth.json, so it works for Pi and every app built on it.
 */
export async function login(options: LoginOptions = {}): Promise<LoginState> {
  const server = await startLoginServer(options);
  try {
    options.onUrl?.(server.url);
    if (options.open !== false) openBrowser(server.url);
    await new Promise<void>((resolve, reject) => {
      server.events.once("done", resolve).once("closed", resolve);
      if (options.until === "connected") server.service.once("connected", () => resolve());
      if (options.timeoutMs)
        setTimeout(() => reject(new Error("Sign-in timed out")), options.timeoutMs).unref();
      options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
        once: true,
      });
    });
    return await server.service.state();
  } finally {
    await server.close();
  }
}

/** Every provider and whether it is connected, the available models and the default model. */
export function status(options: PiAiLoginOptions = {}): Promise<LoginState> {
  return new LoginService(options).state();
}

export function logout(provider: string, options: PiAiLoginOptions = {}): Promise<void> {
  return new LoginService(options).logout(provider);
}

export function setDefaultModel(
  choice: ModelChoice | undefined,
  options: PiAiLoginOptions = {},
): Promise<void> {
  return new LoginService(options).setDefaultModel(choice);
}

export interface GetModelOptions extends PiAiLoginOptions {
  /** Use this provider (its default model, unless `model` is given too). */
  provider?: string;
  /** Use this model id. */
  model?: string;
  /** When no model is connected, show the sign-in page first. Default: false. */
  login?: boolean | LoginOptions;
}

export interface ModelHandle {
  /** Pi's model collection, with auth already wired to auth.json (tokens refresh automatically). */
  models: Models;
  model: Model<Api>;
}

/**
 * A ready-to-use model: the one asked for, else the user's default, else the
 * first connected provider's model. Call it with `models.completeSimple(model, context)`.
 */
export async function getModel(options: GetModelOptions = {}): Promise<ModelHandle> {
  const service = new LoginService(options);
  let model = await pickModel(service, options);
  if (!model && options.login) {
    const loginOptions = options.login === true ? {} : options.login;
    await login({ ...loginOptions, ...agentDirOf(options), until: "connected" });
    model = await pickModel(service, options);
  }
  if (!model) throw new NoModelError(options);
  return { models: service.models, model };
}

/** No connected provider offers the requested model. Run `pi-ai-login` to sign in. */
export class NoModelError extends Error {
  constructor(options: Pick<GetModelOptions, "provider" | "model">) {
    const wanted = [options.provider, options.model].filter(Boolean).join("/");
    super(
      wanted
        ? `${wanted} is not available. Sign in to it with: npx pi-ai-login`
        : "No AI model is connected. Sign in with: npx pi-ai-login",
    );
  }
}

async function pickModel(
  service: LoginService,
  options: GetModelOptions,
): Promise<Model<Api> | undefined> {
  const available = await service.models.getAvailable();
  if (options.provider || options.model)
    return available.find(
      (model) =>
        (!options.provider || model.provider === options.provider) &&
        (!options.model || model.id === options.model),
    );
  const preferred = await service.settings.defaultModel();
  const match = preferred
    ? available.find(
        (model) => model.provider === preferred.provider && model.id === preferred.model,
      )
    : undefined;
  if (match) return match;
  for (const provider of PREFERRED_PROVIDERS) {
    const first = available.find((model) => model.provider === provider);
    if (first) return first;
  }
  return available[0];
}

function agentDirOf(options: PiAiLoginOptions): PiAiLoginOptions {
  return options.agentDir ? { agentDir: options.agentDir } : {};
}
