import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), react()],
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
    /**
     * 刻意不配 proxy。
     *
     * 流式接口一轮能跑 191s，dev proxy 会引入缓冲与超时的整类风险
     * （要同时配 timeout:0 与 proxyTimeout:0 才不出事），而前端本来就要用
     * fetch + ReadableStream 手解 NDJSON（EventSource 不支持 POST body），
     * 直连没有任何额外成本，而且 dev 与生产形态一致。
     */
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
