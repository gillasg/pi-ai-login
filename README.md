# pi-ai-login

**Sign in to any AI model from the browser, no terminal needed.**

`pi-ai-login` gives any app a polished sign-in page for AI models. Users click
"Sign in with Claude", "Sign in with ChatGPT", "Sign in with GitHub Copilot" or
paste an API key, and the login is saved where [Pi](https://www.npmjs.com/package/@earendil-works/pi-ai)
keeps it. One sign-in then works for the Pi CLI and for every app built on Pi on
that computer.

- **Every provider Pi supports.** Subscriptions (Claude Pro/Max, ChatGPT Plus/Pro,
  GitHub Copilot, OpenRouter, xAI, Kimi, Meta…) and API keys for 40+ providers.
- **Browser only.** Sign-in pages, device codes, pasted codes and key entry all
  happen in one clean page, in light or dark mode.
- **Shared with Pi.** Reads and writes Pi's own `auth.json` and `settings.json`,
  with the same file locking, so the Pi CLI and every app stay in sync.
- **Stays signed in.** Subscription tokens refresh automatically before they expire.
- **A default model.** Users pick it once; apps use it unless they ask for another.
- **Embeddable.** Drop the same screen into an app's settings or a browser extension.
- **Windows, macOS and Linux.**

## For users

```bash
npx pi-ai-login
```

The sign-in page opens in your browser. Pick a provider, finish signing in, and
press **Done**.

```bash
npx pi-ai-login status                          # what is connected
npx pi-ai-login default anthropic/claude-sonnet-4-5   # set the default model
npx pi-ai-login logout openai                   # sign out of a provider
```

## For apps

```ts
import { getModel, login } from "pi-ai-login";

// A ready-to-use model: the user's default, or the first connected provider.
// With `login: true`, the sign-in page opens first when nothing is connected.
const { models, model } = await getModel({ login: true });

const reply = await models.completeSimple(model, {
  messages: [{ role: "user", content: "Hello!", timestamp: Date.now() }],
});
```

`models` is Pi's model collection with authentication already wired up, so every
streaming, tool-calling and multimodal feature of
[`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) is available.

| Function | What it does |
|---|---|
| `login(options?)` | Opens the sign-in page and resolves when the user presses Done or closes it (`until: "connected"` resolves on the first sign-in). |
| `getModel(options?)` | Returns `{ models, model }`. Ask for a `provider` and/or `model`, or get the default. Throws `NoModelError` with a helpful message when nothing is connected. |
| `status()` | Every provider, its sign-in methods and whether it is connected, the available models and the default model. |
| `setDefaultModel({ provider, model })` | Sets the default model (`undefined` clears it). |
| `logout(provider)` | Signs out of a provider. |
| `startLoginServer(options?)` | Runs the sign-in page without opening it, for embedding. |

Every function takes `agentDir` (default: `PI_CODING_AGENT_DIR` or `~/.pi/agent`)
and `models` (a custom Pi model collection, for apps with their own providers).

## Embedding the sign-in screen

```ts
import { startLoginServer } from "pi-ai-login";

const server = await startLoginServer();
// Show server.url in an iframe, a webview or a new tab.
```

In a web page or an extension page, the `<pi-ai-login>` element sizes itself and
reports changes:

```html
<script type="module" src="http://127.0.0.1:PORT/embed.js"></script>
<pi-ai-login src="SERVER_URL"></pi-ai-login>
<script>
  document.querySelector("pi-ai-login").addEventListener("change", (event) => {
    console.log(event.detail.connected, event.detail.defaultModel);
  });
</script>
```

An extension that cannot load remote scripts can copy `embed.js` into its own
files, or use a plain `<iframe src="SERVER_URL&embed=1">`.

## How it works

`pi-ai-login` runs a small web server on `127.0.0.1` for as long as the sign-in
page is needed. Each provider's sign-in is Pi's own flow: when Pi needs the user
to visit a page, enter a code or paste a key, the page shows exactly that step and
sends the answer back.

- The server only answers this computer, by name, and every API call needs a
  random token that lives in the page address's `#fragment`.
- Other websites cannot call it. Browser extensions can, with the token.
- Logins are written to `auth.json` with owner-only permissions, using the same
  lock the Pi CLI uses.

## Develop

```bash
pnpm install
pnpm check   # format, types, lint, build and tests
```

## License

MIT. Provider support and sign-in flows come from
[`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) (MIT).
