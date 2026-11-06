import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Same alias as the web app: core's source rather than its build output.
const coreSrc = fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url));

/**
 * The phone app is its own build, served by the API under /m. Everything it
 * references is relative to that base, and the service worker in public/
 * lands at /m/sw.js, which is what limits its scope to /m and keeps it well
 * away from the desktop app at /.
 */
export default defineConfig({
  base: '/m/',
  plugins: [react()],
  resolve: {
    alias: { '@tagexplore/core': coreSrc },
  },
  server: {
    port: 5174,
    // Push notifications only work over HTTPS, so testing them on a real
    // phone in development goes through an ngrok tunnel to this server.
    allowedHosts: ['.ngrok-free.app', '.ngrok.app', '.ngrok-free.dev', '.ngrok.dev'],
    proxy: {
      '/api': {
        target: process.env.API_URL ?? 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
