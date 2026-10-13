// Copies the sign-in page into dist/ui, next to the server that serves it.
import { cpSync, mkdirSync } from "node:fs";

mkdirSync(new URL("../dist/ui/", import.meta.url), { recursive: true });
cpSync(new URL("../ui/", import.meta.url), new URL("../dist/ui/", import.meta.url), {
  recursive: true,
});
