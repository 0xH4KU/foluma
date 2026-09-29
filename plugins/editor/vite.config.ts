import {defineConfig} from "vite";
import {fileURLToPath} from "node:url";
export default defineConfig({
  build: {
    outDir: "build/editor", emptyOutDir: true,
    lib: {entry: fileURLToPath(new URL("./src/editor.tsx", import.meta.url)), formats: ["es"], fileName: () => "editor.js", cssFileName: "editor"},
    rollupOptions: {output: {inlineDynamicImports: true}},
  },
  define: {"process.env.NODE_ENV": '"production"'},
});
