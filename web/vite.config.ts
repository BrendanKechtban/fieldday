import { defineConfig } from "vitest/config";
import { loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// Performance change (D8): the board's largest element is the event list, which waits on the first API response.
// Opening the API connection (DNS + TCP + TLS) while the script downloads takes that setup off the critical path.
// The origin comes from the same VITE_API_BASE the app uses, so staging and production each preconnect to their own API.
const preconnectApi = (apiBase: string): Plugin => ({
  name: "preconnect-api",
  transformIndexHtml: () =>
    apiBase
      ? [{ tag: "link", attrs: { rel: "preconnect", href: new URL(apiBase).origin, crossorigin: "" }, injectTo: "head-prepend" as const }]
      : [],
});

// `MCP_APP=1 vite build` produces the self-contained dist/mcp-app.html (served by server/src/mcp.ts).
const mcp = process.env.MCP_APP === "1";
export default defineConfig(({ mode }) => ({
  plugins: mcp
    ? [react(), viteSingleFile()]
    : [react(), preconnectApi(loadEnv(mode, process.cwd(), "VITE_").VITE_API_BASE ?? "")],
  build: {
    emptyOutDir: !mcp,
    target: "es2022",
    rollupOptions: { input: mcp ? "mcp-app.html" : "index.html" },
  },
  server: { port: 5173 },
  test: { environment: "jsdom", globals: true, setupFiles: ["test/setup.ts"], include: ["test/**/*.test.{ts,tsx}"] },
}));
