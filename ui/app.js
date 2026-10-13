// The sign-in page. Plain DOM, no framework: it is served by a tiny local server.
// The access token arrives in the address's #fragment (never sent to servers or logs). Keep it
// for reloads of this tab, then drop it from the address bar.
const params = new URLSearchParams(location.hash.slice(1));
const token = params.get("token") ?? readSession("pi-ai-login:token") ?? "";
writeSession("pi-ai-login:token", token);
const embedded = params.get("embed") === "1" || window.self !== window.top;
if (embedded) document.documentElement.classList.add("embed");
history.replaceState(null, "", location.pathname + location.search);

function readSession(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key, value) {
  try {
    if (value) sessionStorage.setItem(key, value);
  } catch {
    // Private windows may refuse storage; the page still works until reloaded.
  }
}

const $ = (id) => document.getElementById(id);
let state = { providers: [], models: [] };
let flow = null;

/** Creates an element. Text is always set as text, never parsed as HTML. */
function h(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (name.startsWith("on")) element.addEventListener(name.slice(2), value);
    else if (name === "class") element.className = value;
    else element.setAttribute(name, value === true ? "" : value);
  }
  element.append(...children.flat().filter((child) => child !== null && child !== undefined));
  return element;
}

async function api(path, body) {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-pi-ai-login-token": token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}

function stream(path, event, onEvent) {
  const source = new EventSource(`/api/${path}${path.includes("?") ? "&" : "?"}token=${token}`);
  source.addEventListener(event, (message) => onEvent(JSON.parse(message.data)));
  return source;
}

function showNotice(message) {
  $("notice").textContent = message ?? "";
  $("notice").hidden = !message;
}

async function load() {
  try {
    state = await api("state");
    showNotice();
    render();
  } catch (error) {
    showNotice(error.message);
  }
}

function render() {
  renderConnected();
  renderDefaultModel();
  renderSubscriptions();
  renderKeys();
  const count = state.providers.filter((provider) => provider.connected).length;
  $("footer-status").textContent = count
    ? `${count} provider${count === 1 ? "" : "s"} connected.`
    : "Nothing connected yet.";
  if (embedded) notifyParent();
}

function connectionLabel(connection) {
  if (!connection.stored) return { badge: "From environment", detail: connection.source ?? "" };
  if (connection.type === "oauth")
    return { badge: "Signed in", detail: "Sign-in refreshes automatically" };
  return { badge: "API key", detail: "Saved on this computer" };
}

function renderConnected() {
  const connected = state.providers.filter((provider) => provider.connected);
  $("connected-section").hidden = !connected.length;
  $("connected").replaceChildren(
    ...connected.map((provider) => {
      const label = connectionLabel(provider.connection);
      const signOut = provider.connection.stored
        ? h("button", { class: "danger", onclick: () => signOutOf(provider) }, "Sign out")
        : null;
      return h(
        "li",
        { class: "row" },
        h(
          "div",
          { class: "name" },
          h("strong", {}, provider.name),
          h("div", { class: "hint" }, label.detail),
        ),
        h("span", { class: "badge good" }, label.badge),
        signOut,
      );
    }),
  );
}

async function signOutOf(provider) {
  if (!window.confirm(`Sign out of ${provider.name}? Apps on this computer will stop using it.`))
    return;
  try {
    await api("logout", { provider: provider.id });
  } catch (error) {
    showNotice(error.message);
  }
}

function renderDefaultModel() {
  const select = $("default-model");
  $("default-section").hidden = !state.models.length;
  const chosen = state.defaultModel
    ? `${state.defaultModel.provider}/${state.defaultModel.model}`
    : "";
  const groups = new Map();
  for (const model of state.models) {
    if (!groups.has(model.provider)) groups.set(model.provider, []);
    groups.get(model.provider).push(model);
  }
  const names = new Map(state.providers.map((provider) => [provider.id, provider.name]));
  select.replaceChildren(
    h("option", { value: "" }, "Let each app choose"),
    ...[...groups].map(([provider, models]) =>
      h(
        "optgroup",
        { label: names.get(provider) ?? provider },
        ...models.map((model) => h("option", { value: `${provider}/${model.id}` }, model.name)),
      ),
    ),
  );
  select.value = chosen;
}

$("default-model").addEventListener("change", async (event) => {
  const value = event.target.value;
  const slash = value.indexOf("/");
  const body = value ? { provider: value.slice(0, slash), model: value.slice(slash + 1) } : {};
  try {
    await api("default-model", body);
  } catch (error) {
    showNotice(error.message);
  }
});

function renderSubscriptions() {
  const cards = state.providers.flatMap((provider) =>
    provider.methods
      .filter((method) => method.type === "oauth")
      .map((method) =>
        h(
          "button",
          { class: "card", type: "button", onclick: () => startFlow(provider, "oauth") },
          h("strong", {}, provider.name),
          h(
            "span",
            { class: "hint" },
            h("span", {}, method.label),
            provider.connection?.type === "oauth" && provider.connection.stored
              ? h("span", { class: "badge good" }, "Connected")
              : null,
          ),
        ),
      ),
  );
  $("subscriptions").replaceChildren(...cards);
}

function renderKeys() {
  const query = $("search").value.trim().toLowerCase();
  const rows = state.providers
    .filter((provider) => provider.methods.some((method) => method.type === "api_key"))
    .filter((provider) => !query || `${provider.name} ${provider.id}`.toLowerCase().includes(query))
    .map((provider) => {
      const hasKey = provider.connection?.type === "api_key" && provider.connection.stored;
      return h(
        "li",
        { class: "row" },
        h("div", { class: "name" }, h("strong", {}, provider.name)),
        hasKey ? h("span", { class: "badge good" }, "Key saved") : null,
        h(
          "button",
          { type: "button", onclick: () => startFlow(provider, "api_key") },
          hasKey ? "Replace key" : "Add key",
        ),
      );
    });
  $("keys").replaceChildren(...rows);
}

$("search").addEventListener("input", renderKeys);

/* ---- The sign-in dialog ---- */

async function startFlow(provider, method) {
  closeFlow(false);
  flow = { provider, method, events: [], prompt: null, source: null, finished: false };
  $("flow-title").textContent =
    method === "oauth" ? `Sign in to ${provider.name}` : `${provider.name} API key`;
  renderFlow();
  $("flow").showModal();
  try {
    const { id } = await api("logins", { provider: provider.id, method });
    flow.id = id;
    flow.source = stream(`logins/${id}/events`, "login", onFlowEvent);
  } catch (error) {
    onFlowEvent({ type: "error", message: error.message });
  }
}

function onFlowEvent(event) {
  if (!flow) return;
  if (event.type === "prompt") flow.prompt = event;
  else if (event.type === "prompt_closed" && flow.prompt?.promptId === event.promptId)
    flow.prompt = null;
  else flow.events.push(event);
  if (["done", "error", "cancelled"].includes(event.type)) {
    flow.finished = true;
    flow.source?.close();
  }
  renderFlow();
  if (event.type === "done") setTimeout(() => closeFlow(false), 1200);
}

function renderFlow() {
  if (!flow) return;
  const latest = (type) => flow.events.findLast((event) => event.type === type);
  const result = flow.events.find((event) => ["done", "error", "cancelled"].includes(event.type));
  const progress = latest("progress");
  const steps = [
    ...flow.events.filter((event) => event.type === "info").map(infoStep),
    latest("auth_url") && authUrlStep(latest("auth_url")),
    latest("device_code") && deviceCodeStep(latest("device_code")),
    flow.prompt && promptStep(flow.prompt),
    result ? resultStep(result) : progressStep(progress),
  ];
  $("flow-body").replaceChildren(...steps.filter(Boolean));
}

function infoStep(event) {
  return h(
    "div",
    { class: "step" },
    h("p", {}, event.message),
    ...(event.links ?? []).map((link) =>
      h("a", { href: link.url, target: "_blank", rel: "noreferrer" }, link.label ?? link.url),
    ),
  );
}

function authUrlStep(event) {
  return h(
    "div",
    { class: "step" },
    h(
      "p",
      {},
      event.instructions ??
        `Finish signing in on ${flow.provider.name}'s page. It opened in a new tab.`,
    ),
    h(
      "div",
      { class: "actions" },
      h(
        "a",
        { class: "button primary", href: event.url, target: "_blank", rel: "noreferrer" },
        "Open sign-in page",
      ),
      h(
        "button",
        { type: "button", onclick: () => navigator.clipboard?.writeText(event.url) },
        "Copy link",
      ),
    ),
  );
}

function deviceCodeStep(event) {
  return h(
    "div",
    { class: "step" },
    h("p", {}, "Enter this code on the sign-in page:"),
    h("div", { class: "code" }, event.userCode),
    h(
      "div",
      { class: "actions" },
      h(
        "button",
        { type: "button", onclick: () => navigator.clipboard?.writeText(event.userCode) },
        "Copy code",
      ),
      h(
        "a",
        {
          class: "button primary",
          href: event.verificationUri,
          target: "_blank",
          rel: "noreferrer",
        },
        "Open the page",
      ),
    ),
  );
}

function promptStep(prompt) {
  if (prompt.kind === "select")
    return h(
      "div",
      { class: "step" },
      h("p", {}, prompt.message),
      h(
        "div",
        { class: "options" },
        ...prompt.options.map((option) =>
          h(
            "button",
            { type: "button", onclick: () => answer(prompt, option.id) },
            h("strong", {}, option.label),
            option.description ? h("div", { class: "hint" }, option.description) : null,
          ),
        ),
      ),
    );
  const input = h("input", {
    type: prompt.kind === "secret" ? "password" : "text",
    placeholder:
      prompt.placeholder ??
      (prompt.kind === "manual_code" ? "Paste the code or the full address" : ""),
    autocomplete: "off",
    spellcheck: "false",
    required: true,
  });
  setTimeout(() => input.focus());
  return h(
    "form",
    {
      class: "step",
      onsubmit: (event) => (event.preventDefault(), answer(prompt, input.value.trim())),
    },
    h("label", { class: "field" }, h("span", {}, prompt.message), input),
    h("div", { class: "actions" }, h("button", { class: "primary", type: "submit" }, "Continue")),
  );
}

async function answer(prompt, value) {
  if (!value || !flow?.id) return;
  flow.prompt = null;
  renderFlow();
  try {
    await api(`logins/${flow.id}/answer`, { promptId: prompt.promptId, value });
  } catch (error) {
    onFlowEvent({ type: "error", message: error.message });
  }
}

function progressStep(event) {
  if (flow.prompt) return null;
  return h(
    "div",
    { class: "progress" },
    h("div", { class: "spinner" }),
    h("span", {}, event?.message ?? "Waiting…"),
  );
}

function resultStep(event) {
  if (event.type === "done")
    return h("div", { class: "result good" }, `✓ Connected to ${flow.provider.name}`);
  if (event.type === "cancelled") return h("div", { class: "result" }, "Cancelled.");
  return h(
    "div",
    { class: "step" },
    h("div", { class: "result bad" }, event.message),
    h(
      "div",
      { class: "actions" },
      h(
        "button",
        { type: "button", onclick: () => startFlow(flow.provider, flow.method) },
        "Try again",
      ),
    ),
  );
}

function closeFlow(cancel) {
  if (!flow) return;
  if (cancel && flow.id && !flow.finished) api(`logins/${flow.id}/cancel`, {}).catch(() => {});
  flow.source?.close();
  flow = null;
  if ($("flow").open) $("flow").close();
}

$("flow-close").addEventListener("click", () => closeFlow(true));
$("flow").addEventListener("cancel", (event) => (event.preventDefault(), closeFlow(true)));

$("done").addEventListener("click", async () => {
  await api("done", {}).catch(() => {});
  document.body.replaceChildren($("finished").content.cloneNode(true));
});

/* ---- Embedding: tell the host page our height and what is connected ---- */

function notifyParent() {
  const connected = state.providers
    .filter((provider) => provider.connected)
    .map((provider) => provider.id);
  window.parent.postMessage(
    { type: "pi-ai-login:state", connected, defaultModel: state.defaultModel ?? null },
    "*",
  );
  window.parent.postMessage(
    { type: "pi-ai-login:height", height: document.documentElement.scrollHeight },
    "*",
  );
}

if (!token)
  showNotice("This page needs its access link. Start it again from the app that opened it.");
else {
  stream("events", "state", load);
  load();
}
