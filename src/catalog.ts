import type { AuthType, CredentialStore, Models, Provider } from "@earendil-works/pi-ai";

export interface SignInMethod {
  type: AuthType;
  /** What the button says, e.g. "Sign in with ChatGPT" or "Anthropic API key". */
  label: string;
  /** True when the method is backed by a paid subscription (Claude Pro/Max, ChatGPT Plus…). */
  subscription: boolean;
}

export interface ProviderStatus {
  id: string;
  name: string;
  methods: SignInMethod[];
  connected: boolean;
  /** How the provider is connected: a stored login, or something in the environment. */
  connection?: {
    type: AuthType;
    /** "OAuth", "ANTHROPIC_API_KEY", "~/.aws/credentials"… */
    source?: string;
    /** True when the login lives in auth.json and can be signed out here. */
    stored: boolean;
    /** OAuth access-token expiry (ms since epoch); refreshed automatically before use. */
    expires?: number;
  };
}

export interface ModelSummary {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow?: number;
}

/** Every provider with its sign-in methods and whether it is connected. */
export async function providerStatuses(
  models: Models,
  store: CredentialStore,
): Promise<ProviderStatus[]> {
  const providers = models.getProviders();
  const statuses = await Promise.all(providers.map((provider) => status(models, store, provider)));
  return statuses.sort(byPriority);
}

async function status(
  models: Models,
  store: CredentialStore,
  provider: Provider,
): Promise<ProviderStatus> {
  const result: ProviderStatus = {
    id: provider.id,
    name: provider.name,
    methods: methods(provider),
    connected: false,
  };
  const [check, credential] = await Promise.all([
    models.checkAuth(provider.id).catch(() => undefined),
    store.read(provider.id).catch(() => undefined),
  ]);
  if (!check) return result;
  result.connected = true;
  result.connection = { type: check.type, stored: credential !== undefined };
  if (check.source) result.connection.source = check.source;
  if (credential?.type === "oauth") result.connection.expires = credential.expires;
  return result;
}

function methods(provider: Provider): SignInMethod[] {
  const list: SignInMethod[] = [];
  const { oauth, apiKey } = provider.auth;
  if (oauth)
    list.push({
      type: "oauth",
      label: oauth.loginLabel ?? `Sign in with ${oauth.name}`,
      subscription: oauth.isSubscription === true,
    });
  if (apiKey?.login) list.push({ type: "api_key", label: apiKey.name, subscription: false });
  return list;
}

/** The providers most people sign in with come first; the rest stay alphabetical. */
export const PREFERRED_PROVIDERS = [
  "anthropic",
  "openai",
  "openai-codex",
  "github-copilot",
  "google",
  "openrouter",
  "xai",
];

function byPriority(a: ProviderStatus, b: ProviderStatus): number {
  const rank = (id: string) => {
    const index = PREFERRED_PROVIDERS.indexOf(id);
    return index === -1 ? PREFERRED_PROVIDERS.length : index;
  };
  return rank(a.id) - rank(b.id) || a.name.localeCompare(b.name);
}

/** Chat models from every connected provider. */
export async function availableModels(models: Models): Promise<ModelSummary[]> {
  const available = await models.getAvailable().catch(() => []);
  return available.map((model) => {
    const summary: ModelSummary = {
      provider: model.provider,
      id: model.id,
      name: model.name,
      reasoning: model.reasoning === true,
    };
    if (model.contextWindow) summary.contextWindow = model.contextWindow;
    return summary;
  });
}
