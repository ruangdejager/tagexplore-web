import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Alias straight to core's source rather than its build output, so editing the
// parser or a threshold hot-reloads the app instead of needing a rebuild first.
const coreSrc = fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@tagexplore/core': coreSrc },
  },
  server: {
    port: 5173,
    allowedHosts: ['.ngrok-free.app', '.ngrok.app'],
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
