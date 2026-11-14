
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// The browser calls /api; locally Node-RED owns that gateway path and forwards
// to FastAPI as required.
const gatewayTarget = process.env.FOBE_NODE_RED_TARGET || 'http://127.0.0.1:1880';
const repositoryRoot = import.meta.dirname;

export default defineConfig({
  base: '/FOBE-Asset/',
  root: resolve(repositoryRoot, 'frontend'),
  // Shared static inputs stay at repository root so FastAPI can keep reading
  // public/ifc-index. The controlled build script copies them to the site root.
  publicDir: resolve(repositoryRoot, 'public'),

  build: {
    outDir: resolve(repositoryRoot, '.frontend-build'),
    emptyOutDir: true,
    copyPublicDir: false,
    rollupOptions: {
      input: {
        mapping: resolve(repositoryRoot, 'frontend', 'index.html'),
        modelView: resolve(repositoryRoot, 'frontend', 'model-view.html')
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  },

  server: {
    proxy: {
      '/api': {
        target: gatewayTarget,
        changeOrigin: true
      }
    }
  }
});
