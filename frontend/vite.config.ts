import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Bind on all interfaces so sandbox/preview proxies (and LAN devices) can
    // reach the dev server. Vite 8's host allowlist must include the generated
    // preview hostnames or the browser receives HTTP 403.
    host: "0.0.0.0",
    allowedHosts: ["localhost", "127.0.0.1", ".e2b.app", ".vercel.app"],
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8000" },
  },
});
