import { defineConfig } from "vite";
export default defineConfig({
  server: { proxy: { "/api": "http://localhost:8787", "/webhook": "http://localhost:8787", "/ws": { target: "ws://localhost:8787", ws: true } } },
});
