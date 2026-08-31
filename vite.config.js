import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  base: "./", // relative asset URLs so the build works at any Pages path
  plugins: [preact()],
});
