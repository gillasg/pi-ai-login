import { randomUUID } from "node:crypto";
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  AuthType,
  Models,
} from "@earendil-works/pi-ai";

/** What the sign-in page needs to show, in order. `seq` lets a reconnecting page resume. */
export type SessionEvent = { seq: number } & (
  | AuthEvent
  | {
      type: "prompt";
      promptId: string;
      kind: AuthPrompt["type"];
      message: string;
      placeholder?: string;
      options?: readonly { id: string; label: string; description?: string }[];
    }
  | { type: "prompt_closed"; promptId: string }
  | { type: "done"; credentialType: AuthType }
  | { type: "error"; message: string }
  | { type: "cancelled" }
);

type Unsequenced<T> = T extends unknown ? Omit<T, "seq"> : never;
export type SessionState = "running" | "done" | "error" | "cancelled";

interface PendingPrompt {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

/**
 * One provider sign-in, driven by Pi's own login flow. Pi asks questions
 * through `prompt()` and reports progress through `notify()`; both become
 * events the browser page renders, and the page's answers resolve the prompts.
 */
export class LoginSession {
  readonly id = randomUUID();
  readonly events: SessionEvent[] = [];
  state: SessionState = "running";
  private readonly controller = new AbortController();
  private readonly prompts = new Map<string, PendingPrompt>();
  private readonly listeners = new Set<(event: SessionEvent) => void>();

  constructor(
    readonly providerId: string,
    readonly method: AuthType,
    private readonly hooks: { onAuthUrl?: (url: string) => void; onFinish?: () => void } = {},
  ) {}

  /** `deviceId` is Pi's installation id, which some providers' sign-in flows send. */
  run(models: Models, deviceId: string): Promise<void> {
    const interaction: AuthInteraction = {
      signal: this.controller.signal,
      prompt: (prompt) => this.ask(prompt),
      notify: (event) => this.notify(event),
    };
    return models
      .login(this.providerId, this.method, interaction, { getDeviceId: () => deviceId })
      .then(
        (credential) => this.finish("done", { type: "done", credentialType: credential.type }),
        (error: unknown) =>
          this.controller.signal.aborted
            ? this.finish("cancelled", { type: "cancelled" })
            : this.finish("error", { type: "error", message: errorMessage(error) }),
      );
  }

  /** Answers an open prompt. False when it is unknown or already closed. */
  answer(promptId: string, value: string): boolean {
    const pending = this.prompts.get(promptId);
    if (!pending) return false;
    this.prompts.delete(promptId);
    pending.resolve(value);
    return true;
  }

  cancel(): void {
    if (this.state !== "running") return;
    this.controller.abort();
    for (const [id, pending] of this.prompts) {
      this.prompts.delete(id);
      pending.reject(new Error("Sign-in cancelled"));
    }
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private ask(prompt: AuthPrompt): Promise<string> {
    if (prompt.signal?.aborted || this.controller.signal.aborted)
      return Promise.reject(new Error("Sign-in cancelled"));
    const promptId = randomUUID();
    const { signal, ...shown } = prompt;
    const event: Unsequenced<SessionEvent> = {
      ...shown,
      type: "prompt",
      kind: prompt.type,
      promptId,
    } as Unsequenced<SessionEvent>;
    return new Promise<string>((resolve, reject) => {
      this.prompts.set(promptId, { resolve, reject });
      this.push(event);
      signal?.addEventListener(
        "abort",
        () => {
          if (!this.prompts.delete(promptId)) return;
          this.push({ type: "prompt_closed", promptId });
          reject(new Error("Prompt closed"));
        },
        { once: true },
      );
    });
  }

  private notify(event: AuthEvent): void {
    this.push(event);
    if (event.type === "auth_url") this.hooks.onAuthUrl?.(event.url);
  }

  private finish(state: SessionState, event: Unsequenced<SessionEvent>): void {
    if (this.state !== "running") return;
    this.state = state;
    for (const id of this.prompts.keys()) this.push({ type: "prompt_closed", promptId: id });
    this.prompts.clear();
    this.push(event);
    this.hooks.onFinish?.();
  }

  private push(event: Unsequenced<SessionEvent>): void {
    const sequenced = { ...event, seq: this.events.length + 1 } as SessionEvent;
    this.events.push(sequenced);
    for (const listener of this.listeners) listener(sequenced);
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0]?.slice(0, 500) || "Sign-in failed";
}
