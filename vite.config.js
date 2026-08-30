import { defineConfig, defaultClientConditions } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  base: "./", // relative asset URLs so the build works at any Pages path
  plugins: [preact()],
  resolve: {
    // pick onnxruntime-web's extern-wasm build: its wasm loads from the CDN at
    // runtime (ort.env.wasm.wasmPaths) instead of being copied into dist/
    conditions: ["onnxruntime-web-use-extern-wasm", ...defaultClientConditions],
  },
});
