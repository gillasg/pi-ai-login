import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { handleApi } from "./api.js";
import { HttpError, sameToken, sendJson } from "./http.js";
import { openBrowser } from "./open-browser.js";
import { LoginError, LoginService, type PiAiLoginOptions } from "./service.js";

export interface LoginServerOptions extends PiAiLoginOptions {
  /** Port on 127.0.0.1. Default: a free port. */
  port?: number;
  /** Open providers' sign-in pages in the user's browser automatically. Default: true. */
  openSignInPages?: boolean;
  /**
   * Extra origins allowed to call the API from another page, e.g. an extension
   * embedding the sign-in screen. `chrome-extension://` origins are always allowed;
   * the token is still required.
   */
  allowedOrigins?: string[];
}

export interface LoginServer {
  /** The sign-in page, including its access token. Open it in a browser or embed it in an iframe. */
  readonly url: string;
  readonly origin: string;
  readonly port: number;
  /** Required by every API call, as the `x-pi-ai-login-token` header. */
  readonly token: string;
  readonly service: LoginService;
  /** "done" when the user presses Done, "closed" when the last open page goes away. */
  readonly events: EventEmitter;
  close(): Promise<void>;
}

const STATIC_FILES: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/style.css": "style.css",
  "/embed.js": "embed.js",
  "/icon.svg": "icon.svg",
};
const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
};
const PAGE_SECURITY = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'self' chrome-extension:; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
const CLOSE_GRACE_MS = 4_000;

/** Serves the sign-in page and its API on 127.0.0.1. */
export async function startLoginServer(options: LoginServerOptions = {}): Promise<LoginServer> {
  const service = new LoginService(options);
  const token = randomBytes(24).toString("base64url");
  const events = new EventEmitter();
  const presence = presenceTracker(() => events.emit("closed"));
  const context = {
    service,
    presence: presence.change,
    done: () => events.emit("done"),
    ...(options.openSignInPages === false ? {} : { openUrl: openBrowser }),
  };
  let origin = "";
  const allowed = new Set(options.allowedOrigins ?? []);
  const server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => fail(response, error));
  });
  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", origin);
    checkHost(request, origin);
    if (!url.pathname.startsWith("/api/")) return serveStatic(request, response, url.pathname);
    const crossOrigin = checkOrigin(request, response, origin, allowed);
    if (request.method === "OPTIONS" && crossOrigin) return void response.writeHead(204).end();
    const given = request.headers["x-pi-ai-login-token"] ?? url.searchParams.get("token");
    if (!sameToken(typeof given === "string" ? given : undefined, token))
      throw new HttpError(401, "Missing or wrong token");
    await handleApi(context, request, response, url.pathname);
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  return {
    url: `${origin}/#token=${token}`,
    origin,
    port,
    token,
    service,
    events,
    close: async () => {
      service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Only this machine, by name: blocks other sites reaching the server through DNS rebinding. */
function checkHost(request: IncomingMessage, origin: string): void {
  const port = new URL(origin).port;
  const host = request.headers.host ?? "";
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
    throw new HttpError(403, "Unexpected host");
}

/** Same-origin calls pass; extensions and listed origins get CORS headers; other sites are refused. */
function checkOrigin(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string,
  allowed: Set<string>,
): boolean {
  const from = request.headers.origin;
  if (!from || from === origin || from === origin.replace("127.0.0.1", "localhost")) return false;
  if (!from.startsWith("chrome-extension://") && !allowed.has(from))
    throw new HttpError(403, "Origin not allowed");
  response.setHeader("access-control-allow-origin", from);
  response.setHeader("access-control-allow-headers", "content-type, x-pi-ai-login-token");
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader("vary", "origin");
  return true;
}

async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
): Promise<void> {
  const file = STATIC_FILES[path];
  if (!file || (request.method !== "GET" && request.method !== "HEAD"))
    throw new HttpError(404, "Not found");
  const body = await readFile(new URL(`./ui/${file}`, import.meta.url));
  const type = CONTENT_TYPES[file.split(".").pop() ?? ""] ?? "application/octet-stream";
  response.writeHead(200, { "content-type": type, "cache-control": "no-store", ...PAGE_SECURITY });
  response.end(request.method === "HEAD" ? undefined : body);
}

function fail(response: ServerResponse, error: unknown): void {
  if (response.headersSent) return void response.end();
  if (error instanceof HttpError) return sendJson(response, error.status, { error: error.message });
  if (error instanceof LoginError) return sendJson(response, 400, { error: error.message });
  sendJson(response, 500, { error: error instanceof Error ? error.message : "Unexpected error" });
}

/** Fires `onClosed` once every open page has gone and none came back within a few seconds. */
function presenceTracker(onClosed: () => void): { change: (delta: 1 | -1) => void } {
  let open = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    change(delta) {
      open += delta;
      if (timer) clearTimeout(timer);
      timer = open > 0 ? undefined : setTimeout(onClosed, CLOSE_GRACE_MS);
    },
  };
}
