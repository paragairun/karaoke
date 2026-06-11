import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// NOTE: lovable-tagger is intentionally removed from here.
// It only works inside the Lovable platform and causes no-op calls outside it,
// but more importantly it adds unnecessary complexity. Removed for clean GH Pages builds.

// https://vitejs.dev/config/
export default defineConfig({
  // GitHub Pages serves from /karaoke/ — VITE_BASE_PATH is set by the
  // GitHub Actions workflow. Locally (npm run dev) it stays as '/'.
  base: process.env.VITE_BASE_PATH ?? "/",
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  define: {
    // Polyfill for @gradio/client which uses Node.js Buffer API in browser
    global: "globalThis",
  },
  build: {
    // Raise the chunk warning limit — this app has large deps (HuggingFace, Gradio)
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      output: {
        // Split large vendor chunks so the browser can cache them separately
        manualChunks: {
          react: ["react", "react-dom"],
          router: ["react-router-dom"],
          supabase: ["@supabase/supabase-js"],
          ui: ["@radix-ui/react-dialog", "@radix-ui/react-toast", "lucide-react"],
        },
      },
    },
  },
});
