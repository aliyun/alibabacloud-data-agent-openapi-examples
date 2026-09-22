import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { lanApiProxy } from './lan-proxy';

export default defineConfig({
  plugins: [
    tailwindcss(), react(),
    ...(process.env.DAS_LAN === '1'
      ? [lanApiProxy(process.env.DAS_API_PROXY_TARGET ?? 'http://127.0.0.1:3000')]
      : []),
  ],
  /**
   * 前后端共用仓库根的那一份 .env（VITE_ 前缀的变量会被注入前端）。
   * 这样只需要维护一个文件，也不会出现"后端读根、前端读 web/"的割裂。
   */
  envDir: '..',
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    // 默认本机直连；--lan 由 lanApiProxy 配置同源、无额外超时的流式代理。
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
