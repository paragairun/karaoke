import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  // GitHub Pages serves from /repo-name/ — set base to match.
  // VITE_BASE_PATH is injected by the GitHub Actions workflow.
  // Locally (dev) it defaults to '/' so nothing breaks.
  base: process.env.VITE_BASE_PATH ?? "/",
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  define: {
    // Polyfill for @gradio/client which uses Buffer (Node.js API)
    global: "globalThis",
  },
}));
