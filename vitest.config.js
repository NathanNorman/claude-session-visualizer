import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/frontend/__tests__/**/*.test.js'],
    globals: true,
    setupFiles: ['src/frontend/__tests__/setup.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/frontend/**/*.js'],
      exclude: ['src/frontend/__tests__/**'],
    },
  },
});
