import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { AuthType, MutableModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  availableModels,
  providerStatuses,
  type ModelSummary,
  type ProviderStatus,
} from "./catalog.js";
import { FileCredentialStore } from "./credential-store.js";
import { defaultAgentDir } from "./files.js";
import { LoginSession } from "./login-session.js";
import { PiSettings, type ModelChoice } from "./settings.js";

export interface PiAiLoginOptions {
  /** Pi's agent directory. Default: `PI_CODING_AGENT_DIR` or `~/.pi/agent`. */
  agentDir?: string;
  /** A custom provider collection. Default: every provider Pi ships, backed by auth.json. */
  models?: MutableModels;
}

export interface LoginState {
  providers: ProviderStatus[];
  /** Chat models from every connected provider. */
  models: ModelSummary[];
  defaultModel?: ModelChoice;
}

const FINISHED_SESSION_TTL_MS = 10 * 60_000;

/** Sign-in, sign-out and the default model, for one Pi agent directory. Emits "change". */
export class LoginService extends EventEmitter {
  readonly agentDir: string;
  readonly store: FileCredentialStore;
  readonly settings: PiSettings;
  readonly models: MutableModels;
  private readonly sessions = new Map<string, LoginSession>();

  constructor(options: PiAiLoginOptions = {}) {
    super();
    this.agentDir = options.agentDir ?? defaultAgentDir();
    this.store = new FileCredentialStore(join(this.agentDir, "auth.json"));
    this.settings = new PiSettings(join(this.agentDir, "settings.json"));
    this.models = options.models ?? builtinModels({ credentials: this.store });
  }

  async state(): Promise<LoginState> {
    const [providers, models, defaultModel] = await Promise.all([
      providerStatuses(this.models, this.store),
      availableModels(this.models),
      this.settings.defaultModel(),
    ]);
    return defaultModel ? { providers, models, defaultModel } : { providers, models };
  }

  /** Starts a provider's sign-in. A sign-in already running for that provider is cancelled. */
  async startLogin(
    providerId: string,
    method: AuthType,
    onAuthUrl?: (url: string) => void,
  ): Promise<LoginSession> {
    const provider = this.models.getProvider(providerId);
    const supported = method === "oauth" ? provider?.auth.oauth : provider?.auth.apiKey?.login;
    if (!provider || !supported) throw new LoginError(`${providerId} has no ${method} sign-in`);
    for (const existing of this.sessions.values())
      if (existing.providerId === providerId) existing.cancel();
    const hooks: ConstructorParameters<typeof LoginSession>[2] = {
      onFinish: () => this.finished(session),
    };
    if (onAuthUrl) hooks.onAuthUrl = onAuthUrl;
    const session = new LoginSession(providerId, method, hooks);
    this.sessions.set(session.id, session);
    void session.run(this.models, await this.settings.deviceId());
    return session;
  }

  session(id: string): LoginSession | undefined {
    return this.sessions.get(id);
  }

  async logout(providerId: string): Promise<void> {
    if (!this.models.getProvider(providerId))
      throw new LoginError(`Unknown provider ${providerId}`);
    await this.models.logout(providerId);
    this.emit("change");
  }

  async setDefaultModel(choice: ModelChoice | undefined): Promise<void> {
    if (choice && !this.models.getModel(choice.provider, choice.model))
      throw new LoginError(`Unknown model ${choice.provider}/${choice.model}`);
    await this.settings.setDefaultModel(choice);
    this.emit("change");
  }

  /** Cancels every running sign-in. */
  close(): void {
    for (const session of this.sessions.values()) session.cancel();
  }

  private finished(session: LoginSession): void {
    this.emit("change");
    if (session.state === "done") this.emit("connected", session.providerId);
    setTimeout(() => this.sessions.delete(session.id), FINISHED_SESSION_TTL_MS).unref();
  }
}

/** A request the caller can fix (unknown provider, unsupported method, unknown model). */
export class LoginError extends Error {}
