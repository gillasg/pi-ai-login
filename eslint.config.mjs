import js from "@eslint/js";
import tseslint from "typescript-eslint";

const browserGlobals = {
  document: "readonly",
  window: "readonly",
  location: "readonly",
  fetch: "readonly",
  EventSource: "readonly",
  navigator: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  sessionStorage: "readonly",
  history: "readonly",
  MessageEvent: "readonly",
  CustomEvent: "readonly",
  HTMLElement: "readonly",
  customElements: "readonly",
  ResizeObserver: "readonly",
  console: "readonly",
};

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,mjs,js}"],
    languageOptions: {
      globals: {
        process: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        AbortController: "readonly",
        fetch: "readonly",
        TextDecoder: "readonly",
      },
    },
    rules: {
      complexity: ["error", 12],
      "max-lines": ["error", { max: 800 }],
      "max-lines-per-function": ["error", { max: 100, skipBlankLines: true, skipComments: true }],
      "no-warning-comments": ["error", { terms: ["TODO", "FIXME", "HACK"], location: "start" }],
    },
  },
  { files: ["ui/**/*.js"], languageOptions: { globals: browserGlobals, sourceType: "module" } },
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
    },
  },
);
