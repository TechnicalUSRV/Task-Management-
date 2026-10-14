import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  root,
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(root, "..") } },
  publicDir: false,
  // Fonts stay as separate, cacheable files (the server serves /assets with long-lived caching).
  // Two pages: the ERP (index.html) and the Telegram Mini App (tg.html), which shares the task rules.
  build: { outDir: "public", emptyOutDir: true, assetsInlineLimit: 0, rollupOptions: { input: { main: path.resolve(root, "index.html"), tg: path.resolve(root, "tg.html") } } },
});
