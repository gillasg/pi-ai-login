import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

const MAX_BODY_BYTES = 64 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

export async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    // Reported below.
  }
  throw new HttpError(400, "Expected a JSON object");
}

export function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || !value) throw new HttpError(400, `Missing "${name}"`);
  return value;
}

export function sameToken(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Starts a server-sent events stream. Returns a writer; the stream closes with the request. */
export function openEventStream(
  request: IncomingMessage,
  response: ServerResponse,
  onClose: () => void,
): (event: string, data: unknown, id?: number) => void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  response.write(": connected\n\n");
  const heartbeat = setInterval(() => response.write(": ping\n\n"), 15_000);
  request.on("close", () => {
    clearInterval(heartbeat);
    onClose();
  });
  return (event, data, id) => {
    const idLine = id === undefined ? "" : `id: ${id}\n`;
    response.write(`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}
