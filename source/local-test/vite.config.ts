import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig(({ mode }) => {
 // Settings come from source/.env (see .env.example); nothing here is a production address.
 const env = loadEnv(mode, path.resolve(root, ".."), "");
 // `npm run dev`: the Vite dev server forwards API calls to the Django backend, so the browser sees one origin.
 const backend = env.DEV_BACKEND_URL || "http://127.0.0.1:8000";
 return {
  root,
  envDir: path.resolve(root, ".."),
  server: { host: "127.0.0.1", port: 5173, strictPort: true, proxy: { "^/c/[^/]+/(api|tg/api)/": { target: backend, changeOrigin: true }, "/api/": { target: backend, changeOrigin: true } } },
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(root, "..") } },
  publicDir: false,
  // Fonts stay as separate, cacheable files (the server serves /assets with long-lived caching).
  // Two pages: the ERP (index.html) and the Telegram Mini App (tg.html), which shares the task rules.
  build: { outDir: "public", emptyOutDir: true, assetsInlineLimit: 0, rollupOptions: { input: { main: path.resolve(root, "index.html"), tg: path.resolve(root, "tg.html") } } },
 };
});
