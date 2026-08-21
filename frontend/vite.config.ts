import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The frontend talks to the FastAPI backend on :8187. We proxy /api during dev
// so the browser sees a single origin (no CORS headaches).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5177,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:8187",
    },
  },
});
