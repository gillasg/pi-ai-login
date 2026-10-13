import { randomUUID } from "node:crypto";
import { readJsonObject, withFileLock, writeJsonObject } from "./files.js";

export interface ModelChoice {
  provider: string;
  model: string;
}

/**
 * The parts of Pi's global `settings.json` this package uses: the default
 * model (`defaultProvider` / `defaultModel`, the same keys the Pi CLI reads)
 * and the installation's device id. Every other key is preserved.
 */
export class PiSettings {
  constructor(readonly path: string) {}

  async defaultModel(): Promise<ModelChoice | undefined> {
    const settings = await readJsonObject(this.path);
    const provider = settings.defaultProvider;
    const model = settings.defaultModel;
    return typeof provider === "string" && typeof model === "string"
      ? { provider, model }
      : undefined;
  }

  async setDefaultModel(choice: ModelChoice | undefined): Promise<void> {
    await this.update((settings) => {
      if (choice) {
        settings.defaultProvider = choice.provider;
        settings.defaultModel = choice.model;
      } else {
        delete settings.defaultProvider;
        delete settings.defaultModel;
      }
    });
  }

  /** Some sign-in flows identify the installation; Pi keeps the id in settings, so reuse it. */
  async deviceId(): Promise<string> {
    let id = "";
    await this.update((settings) => {
      if (typeof settings.deviceId !== "string" || !settings.deviceId)
        settings.deviceId = randomUUID();
      id = settings.deviceId as string;
    });
    return id;
  }

  private update(change: (settings: Record<string, unknown>) => void): Promise<void> {
    return withFileLock(this.path, async () => {
      const settings = await readJsonObject(this.path);
      const before = JSON.stringify(settings);
      change(settings);
      if (JSON.stringify(settings) !== before) await writeJsonObject(this.path, settings);
    });
  }
}
