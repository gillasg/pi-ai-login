import { spawn } from "node:child_process";

/** Opens a URL in the user's default browser. Failures are silent: every page also shows the link. */
export function openBrowser(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  const [command, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // The page shows the link as a fallback.
  }
}
