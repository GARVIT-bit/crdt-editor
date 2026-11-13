import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, the page is served by Vite (5173) and /ws is proxied to the Node
// server (3000), so the browser only ever talks to one origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: "ws://localhost:3000", ws: true },
      "/healthz": "http://localhost:3000",
      "/api": "http://localhost:3000",
    },
  },
  test: {
    environment: "node",
  },
});
