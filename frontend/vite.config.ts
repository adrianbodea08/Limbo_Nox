import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// One origin during dev, so the browser never learns that /api is somewhere
// else and CORS never enters the picture.
//
// The target is nginx, not the API: the API container is `expose`d rather than
// published, precisely so that nothing can reach it except through nginx — see
// docker-compose.yml. Pointing dev at the API's own port worked back when it
// was published, and has been a connection-refused error since it stopped
// being. NOX_PORT moves the whole stack, so it moves this too.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5177,
    strictPort: true,
    proxy: {
      "/api": `http://localhost:${process.env.NOX_PORT ?? 8090}`,
    },
  },
});
