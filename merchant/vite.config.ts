import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the API runs on its own port; /v1 is proxied so the browser sees one origin,
// exactly as the production server does.
const api = process.env.API_URL ?? "http://localhost:4000";

export default defineConfig({
  plugins: [react()],
  server: { port: Number(process.env.PORT ?? 5310), strictPort: true, proxy: { "/v1": { target: api, changeOrigin: false } } },
  build: {
    outDir: "dist",
    sourcemap: false,
    target: "es2020",
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        manualChunks: (id) => (/node_modules\/(react|react-dom|react-router|scheduler)\//.test(id) ? "react" : undefined),
      },
    },
  },
});
