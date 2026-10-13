import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  build: {
    outDir: "build/page-tools", emptyOutDir: true,
    lib: { entry: fileURLToPath(new URL("./src/page-tools.tsx", import.meta.url)), formats: ["es"],
      fileName: () => "page-tools.js", cssFileName: "page-tools" },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  define: { "process.env.NODE_ENV": '"production"' },
});
