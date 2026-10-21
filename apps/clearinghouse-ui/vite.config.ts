import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
  },
  // @ts-expect-error vitest config extension
  test: {
    environment: "jsdom",
    globals: true,
  },
});
