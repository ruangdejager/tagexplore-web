import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// fileURLToPath rather than URL.pathname: on Windows the latter yields
// "/C:/Code/..." with a leading slash, which resolves to nothing.
const coreSrc = fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url));

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@tagexplore/core': coreSrc,
    },
  },
});
