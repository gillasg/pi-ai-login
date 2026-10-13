import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthType } from "@earendil-works/pi-ai";
import { HttpError, openEventStream, readJsonBody, sendJson, stringField } from "./http.js";
import type { LoginService } from "./service.js";

export interface ApiContext {
  service: LoginService;
  /** Opens a provider's sign-in page in the user's browser, when the server is allowed to. */
  openUrl?: (url: string) => void;
  /** Called when a page connects to or leaves the live state stream. */
  presence: (delta: 1 | -1) => void;
  /** Called when the user presses "Done" on the page. */
  done: () => void;
}

type Handler = (
  context: ApiContext,
  request: IncomingMessage,
  response: ServerResponse,
  params: string[],
) => Promise<void> | void;

const routes: [method: string, pattern: RegExp, handler: Handler][] = [
  ["GET", /^\/api\/state$/, getState],
  ["GET", /^\/api\/events$/, streamState],
  ["POST", /^\/api\/logins$/, startLogin],
  ["GET", /^\/api\/logins\/([\w-]+)\/events$/, streamLogin],
  ["POST", /^\/api\/logins\/([\w-]+)\/answer$/, answerPrompt],
  ["POST", /^\/api\/logins\/([\w-]+)\/cancel$/, cancelLogin],
  ["POST", /^\/api\/logout$/, logout],
  ["POST", /^\/api\/default-model$/, setDefaultModel],
  ["POST", /^\/api\/done$/, finish],
];

export async function handleApi(
  context: ApiContext,
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
): Promise<void> {
  for (const [method, pattern, handler] of routes) {
    const match = pattern.exec(path);
    if (!match) continue;
    if (request.method !== method) throw new HttpError(405, "Method not allowed");
    await handler(context, request, response, match.slice(1));
    return;
  }
  throw new HttpError(404, "Not found");
}

async function getState(context: ApiContext, _request: IncomingMessage, response: ServerResponse) {
  sendJson(response, 200, await context.service.state());
}

function streamState(context: ApiContext, request: IncomingMessage, response: ServerResponse) {
  const onChange = () => send("state", {});
  const send = openEventStream(request, response, () => {
    context.service.off("change", onChange);
    context.presence(-1);
  });
  context.service.on("change", onChange);
  context.presence(1);
}

async function startLogin(context: ApiContext, request: IncomingMessage, response: ServerResponse) {
  const body = await readJsonBody(request);
  const provider = stringField(body, "provider");
  const method = stringField(body, "method");
  if (method !== "oauth" && method !== "api_key") throw new HttpError(400, "Unknown method");
  const session = await context.service.startLogin(provider, method as AuthType, context.openUrl);
  sendJson(response, 201, { id: session.id });
}

function streamLogin(
  context: ApiContext,
  request: IncomingMessage,
  response: ServerResponse,
  [id]: string[],
) {
  const session = context.service.session(id ?? "");
  if (!session) throw new HttpError(404, "Unknown sign-in");
  const url = new URL(request.url ?? "/", "http://localhost");
  const after = Number(request.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0);
  let unsubscribe = () => {};
  const send = openEventStream(request, response, () => unsubscribe());
  for (const event of session.events) if (event.seq > after) send("login", event, event.seq);
  unsubscribe = session.subscribe((event) => send("login", event, event.seq));
}

async function answerPrompt(
  context: ApiContext,
  request: IncomingMessage,
  response: ServerResponse,
  [id]: string[],
) {
  const body = await readJsonBody(request);
  const value = body.value;
  if (typeof value !== "string") throw new HttpError(400, 'Missing "value"');
  const session = context.service.session(id ?? "");
  if (!session?.answer(stringField(body, "promptId"), value))
    throw new HttpError(409, "That question is no longer open");
  sendJson(response, 200, { ok: true });
}

function cancelLogin(
  context: ApiContext,
  _request: IncomingMessage,
  response: ServerResponse,
  [id]: string[],
) {
  context.service.session(id ?? "")?.cancel();
  sendJson(response, 200, { ok: true });
}

async function logout(context: ApiContext, request: IncomingMessage, response: ServerResponse) {
  const body = await readJsonBody(request);
  await context.service.logout(stringField(body, "provider"));
  sendJson(response, 200, { ok: true });
}

async function setDefaultModel(
  context: ApiContext,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const body = await readJsonBody(request);
  const choice =
    body.provider === undefined && body.model === undefined
      ? undefined
      : { provider: stringField(body, "provider"), model: stringField(body, "model") };
  await context.service.setDefaultModel(choice);
  sendJson(response, 200, { ok: true });
}

function finish(context: ApiContext, _request: IncomingMessage, response: ServerResponse) {
  sendJson(response, 200, { ok: true });
  context.done();
}
