import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// 生产构建不需要这个地址：api-client 只发相对路径请求，由反向代理把
// /api、/uploads、/healthz 转到后端。这里只影响 npm run dev，本地后端
// 换端口时用 VESTUS_DEV_API_TARGET 覆盖，例如 http://127.0.0.1:18082。
const devApiTarget = process.env.VESTUS_DEV_API_TARGET || "http://127.0.0.1:8000";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5174,
    strictPort: true,
    host: true,
    proxy: {
      "/api": {
        target: devApiTarget,
        changeOrigin: false,
      },
      "/healthz": {
        target: devApiTarget,
        changeOrigin: false,
      },
      "/uploads": {
        target: devApiTarget,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1000,
  },
});
