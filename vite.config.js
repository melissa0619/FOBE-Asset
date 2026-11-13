
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const apiTarget = process.env.FOBE_API_TARGET || 'http://127.0.0.1:8000';
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
        entryFileNames: 'js/[name]-[hash].js',
        chunkFileNames: 'js/[name]-[hash].js',
        assetFileNames: asset => asset.name?.endsWith('.css')
          ? 'css/[name]-[hash][extname]'
          : /\.m?js$/.test(asset.name || '')
            ? 'js/[name]-[hash][extname]'
            : 'images/[name]-[hash][extname]'
      }
    }
  },

  server: {
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api/, '')
      }
    }
  }
});
