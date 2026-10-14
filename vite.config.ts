import { resolve } from "node:path";
import { defineConfig } from "vite";

// Real static pages (no client-side routes), so a refresh on GitHub Pages never 404s.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        order: resolve(__dirname, "order/index.html"),
        admin: resolve(__dirname, "admin/index.html"),
      },
    },
  },
});
