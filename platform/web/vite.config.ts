import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^@tabler\/icons-react$/,
        replacement: fileURLToPath(
          new URL("./src/client/tabler-icons.mjs", import.meta.url),
        ),
      },
    ],
  },
  build: {
    target: "es2022",
    cssCodeSplit: true,
    sourcemap: false,
  },
});
