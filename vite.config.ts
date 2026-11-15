import { defineConfig } from 'vite';

// DEX//SCULPT is a local-first application: relative base so a production build
// can be opened from any static host (or a file server) without a backend.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1400,
  },
  // Allowed hosts are DNS-rebinding guards only. DEX//SCULPT has no backend and
  // no credentials, and the sandbox preview proxies requests under a generated
  // hostname, so binding the allowlist to `true` keeps the preview usable from
  // any local port-forward without weakening anything that exists here.
  server: {
    host: '0.0.0.0',
    port: 5190,
    strictPort: true,
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 5191,
    strictPort: true,
    allowedHosts: true,
  },
});
