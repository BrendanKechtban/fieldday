import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// `MCP_APP=1 vite build` produces the self-contained dist/mcp-app.html (served by server/src/mcp.ts).
const mcp = process.env.MCP_APP === "1";
export default defineConfig({
  plugins: mcp ? [react(), viteSingleFile()] : [react()],
  build: {
    emptyOutDir: !mcp,
    target: "es2022",
    rollupOptions: { input: mcp ? "mcp-app.html" : "index.html" },
  },
  server: { port: 5173 },
  test: { environment: "jsdom", globals: true, setupFiles: ["test/setup.ts"], include: ["test/**/*.test.{ts,tsx}"] },
});
