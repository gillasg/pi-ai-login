#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { login, logout, setDefaultModel, status, type LoginState } from "./index.js";
import { startLoginServer } from "./server.js";

const HELP = `Sign in to AI models for Pi and every app built on it.

Usage
  pi-ai-login                     Open the sign-in page in your browser
  pi-ai-login status              Show connected providers and the default model
  pi-ai-login logout <provider>   Sign out of a provider
  pi-ai-login default [provider/model]
                                  Show or set the default model ("none" clears it)
  pi-ai-login serve               Run the sign-in page until stopped, without opening a browser

Options
  --port <n>     Port for the sign-in page (default: any free port)
  --no-open      Print the page address instead of opening a browser
  --json         Machine-readable output for status
  --agent-dir    Pi's agent directory (default: PI_CODING_AGENT_DIR or ~/.pi/agent)
  -h, --help     Show this help
  -v, --version  Show the version`;

interface Flags {
  command: string;
  args: string[];
  port?: number;
  open: boolean;
  json: boolean;
  agentDir?: string;
}

const SWITCHES: Record<string, (flags: Flags) => void> = {
  "--no-open": (flags) => (flags.open = false),
  "--json": (flags) => (flags.json = true),
  "-h": (flags) => (flags.command = "help"),
  "--help": (flags) => (flags.command = "help"),
  "-v": (flags) => (flags.command = "version"),
  "--version": (flags) => (flags.command = "version"),
};

function parse(argv: string[]): Flags {
  const flags: Flags = { command: "", args: [], open: true, json: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    if (arg === "--port") flags.port = Number(argv[++index]);
    else if (arg === "--agent-dir") flags.agentDir = argv[++index] ?? "";
    else if (SWITCHES[arg]) SWITCHES[arg](flags);
    else if (!flags.command) flags.command = arg;
    else flags.args.push(arg);
  }
  return flags;
}

function common(flags: Flags): { agentDir?: string; port?: number } {
  return {
    ...(flags.agentDir ? { agentDir: flags.agentDir } : {}),
    ...(flags.port ? { port: flags.port } : {}),
  };
}

function printStatus(state: LoginState): void {
  const connected = state.providers.filter((provider) => provider.connected);
  if (!connected.length) console.log("No providers connected. Run: pi-ai-login");
  for (const provider of connected) {
    const how = provider.connection?.stored
      ? provider.connection.type === "oauth"
        ? "signed in"
        : "API key"
      : `from ${provider.connection?.source ?? "the environment"}`;
    console.log(`  ${provider.name.padEnd(28)} ${how}`);
  }
  const chosen = state.defaultModel;
  console.log(
    chosen ? `\nDefault model: ${chosen.provider}/${chosen.model}` : "\nDefault model: not set",
  );
}

async function run(flags: Flags): Promise<void> {
  const options = common(flags);
  switch (flags.command) {
    case "help":
      return console.log(HELP);
    case "version":
      return console.log(packageVersion());
    case "status": {
      const state = await status(options);
      return flags.json ? console.log(JSON.stringify(state, null, 2)) : printStatus(state);
    }
    case "logout":
      if (!flags.args[0]) throw new Error("Usage: pi-ai-login logout <provider>");
      await logout(flags.args[0], options);
      return console.log(`Signed out of ${flags.args[0]}.`);
    case "default":
      return chooseDefault(flags.args[0], options);
    case "serve":
      return serve(options);
    case "":
    case "login":
      return interactive(flags, options);
    default:
      throw new Error(`Unknown command "${flags.command}". Run pi-ai-login --help.`);
  }
}

async function chooseDefault(value: string | undefined, options: { agentDir?: string }) {
  if (!value) {
    const chosen = (await status(options)).defaultModel;
    return console.log(chosen ? `${chosen.provider}/${chosen.model}` : "not set");
  }
  if (value === "none") return setDefaultModel(undefined, options);
  const slash = value.indexOf("/");
  if (slash < 1) throw new Error("Use provider/model, e.g. anthropic/claude-sonnet-4-5");
  await setDefaultModel(
    { provider: value.slice(0, slash), model: value.slice(slash + 1) },
    options,
  );
  console.log(`Default model set to ${value}.`);
}

async function serve(options: { agentDir?: string; port?: number }): Promise<void> {
  const server = await startLoginServer(options);
  console.log(`Sign-in page: ${server.url}\nPress Ctrl+C to stop.`);
  await new Promise<void>((resolve) => process.once("SIGINT", resolve));
  await server.close();
}

async function interactive(flags: Flags, options: { agentDir?: string; port?: number }) {
  const state = await login({
    ...options,
    open: flags.open,
    onUrl: (url) =>
      console.log(
        flags.open
          ? `Opening the sign-in page… If nothing opens, visit:\n${url}`
          : `Open this page to sign in:\n${url}`,
      ),
  });
  console.log("");
  printStatus(state);
}

function packageVersion(): string {
  const path = new URL("../package.json", import.meta.url);
  return (JSON.parse(readFileSync(path, "utf-8")) as { version: string }).version;
}

run(parse(process.argv.slice(2))).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
