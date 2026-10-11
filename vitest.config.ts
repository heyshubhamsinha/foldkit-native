import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The demo is tested too: its Todo list is the framework's worked example,
    // and an example that does not run is worse than no example.
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
  },
})
