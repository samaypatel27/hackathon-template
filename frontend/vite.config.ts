import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Fail loudly instead of silently moving to 5174, which would break CORS + OAuth redirects.
    strictPort: true,
  },
});
