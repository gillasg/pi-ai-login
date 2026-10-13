import { existsSync, mkdirSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";

/**
 * Pi's agent directory, shared with the Pi CLI and every app built on Pi:
 * `PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`.
 */
export function defaultAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (configured) return resolve(configured.replace(/^~(?=$|[\\/])/, homedir()));
  return join(homedir(), ".pi", "agent");
}

const STALE_MS = 30_000;
// Wait as long as the Pi CLI does before treating a lock as stuck.
const RETRY_UNTIL_MS = 30_000;

/**
 * Runs `fn` while holding the same lock the Pi CLI takes on this file
 * (proper-lockfile, `<file>.lock`), so Pi and every app using this package can
 * read and write the file at the same time without losing updates.
 */
export async function withFileLock<T>(
  path: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const directory = dirname(path);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!existsSync(path))
    await writeFile(path, "{}", { encoding: "utf-8", mode: 0o600, flag: "wx" }).catch(ignoreExists);
  const release = await acquire(path, signal);
  try {
    return await fn();
  } finally {
    await release().catch(() => undefined);
  }
}

async function acquire(path: string, signal?: AbortSignal): Promise<() => Promise<void>> {
  const deadline = Date.now() + RETRY_UNTIL_MS;
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await lockfile.lock(path, { realpath: false, retries: 0, stale: STALE_MS });
    } catch (error) {
      if (errorCode(error) !== "ELOCKED" || Date.now() > deadline) throw error;
      // Jittered so many waiting writers do not retry in lockstep.
      const delay = Math.min(10 * 2 ** attempt, 250) * (0.5 + Math.random());
      await new Promise((done) => setTimeout(done, delay));
    }
  }
}

/** Reads a JSON object file. A missing file is empty; a corrupt one throws rather than being overwritten. */
export async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return {};
    throw error;
  }
  if (!text.trim()) return {};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${path} does not contain a JSON object`);
  return parsed as Record<string, unknown>;
}

export async function writeJsonObject(path: string, value: Record<string, unknown>): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 });
  // `mode` only applies when the file is created; credentials stay owner-only either way.
  if (process.platform !== "win32") await chmod(path, 0o600);
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function ignoreExists(error: unknown): void {
  if (errorCode(error) !== "EEXIST") throw error;
}
