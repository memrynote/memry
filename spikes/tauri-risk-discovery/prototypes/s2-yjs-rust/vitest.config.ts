import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/node/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'tests/bench/**', 'node_modules/**']
  }
})
