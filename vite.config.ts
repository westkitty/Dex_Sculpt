import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      input: { studio: resolve(root, 'index.html'), gallery: resolve(root, 'gallery.html') }
    },
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1200
  }
});
