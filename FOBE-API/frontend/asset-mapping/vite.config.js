import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const apiTarget = process.env.FOBE_API_TARGET || 'http://127.0.0.1:8000';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        mapping: resolve(import.meta.dirname, 'index.html'),
        modelView: resolve(import.meta.dirname, 'model-view.html')
      }
    }
  },
  server: {
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true, rewrite: path => path.replace(/^\/api/, '') }
    }
  }
});
