import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { readJsonObject, withFileLock, writeJsonObject } from "./files.js";

/**
 * Pi's `auth.json`: one credential per provider id, in the exact format and
 * with the exact locking the Pi CLI uses. A login saved here works in Pi and in
 * every other app that reads the same file.
 */
export class FileCredentialStore implements CredentialStore {
  constructor(readonly path: string) {}

  async read(providerId: string): Promise<Credential | undefined> {
    return credentials(await readJsonObject(this.path))[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(credentials(await readJsonObject(this.path))).map(
      ([providerId, credential]) => ({ providerId, type: credential.type }),
    );
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return withFileLock(
      this.path,
      async () => {
        const all = await readJsonObject(this.path);
        const current = credentials(all)[providerId];
        const next = await fn(current);
        if (next === undefined) return current;
        await writeJsonObject(this.path, { ...all, [providerId]: next });
        return next;
      },
      options?.signal,
    );
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return withFileLock(
      this.path,
      async () => {
        const all = await readJsonObject(this.path);
        if (!(providerId in all)) return;
        delete all[providerId];
        await writeJsonObject(this.path, all);
      },
      options?.signal,
    );
  }
}

/** Keeps only well-formed entries, so one odd entry never hides the others. */
function credentials(all: Record<string, unknown>): Record<string, Credential> {
  const result: Record<string, Credential> = {};
  for (const [id, value] of Object.entries(all)) {
    const type = (value as { type?: unknown } | null)?.type;
    if (type === "api_key" || type === "oauth") result[id] = value as Credential;
  }
  return result;
}
