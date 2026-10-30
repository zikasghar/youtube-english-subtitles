import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import { ONNX_RUNTIME_FILES } from "./runtime-config.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);
// Resolve through Transformers so the factory and binary always match its ORT
// dependency, rather than a separately installed or CDN-hosted runtime version.
const ortRequire = createRequire(require.resolve("@huggingface/transformers"));
const ortDist = dirname(ortRequire.resolve("onnxruntime-web"));

export default defineConfig({
  root,
  publicDir: false,
  plugins: [
    {
      name: "package-local-onnx-runtime",
      generateBundle() {
        for (const filename of Object.values(ONNX_RUNTIME_FILES)) {
          this.emitFile({
            type: "asset",
            fileName: `onnx/${filename}`,
            source: readFileSync(join(ortDist, filename)),
          });
        }
      },
    },
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        offscreen: `${root}/offscreen.html`,
        popup: `${root}/popup.html`,
        "audio-worklet": `${root}/audio-worklet.js`,
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
