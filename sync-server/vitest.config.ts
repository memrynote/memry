import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.{test,spec}.ts', 'schema/**/*.{test,spec}.ts', 'wrangler.test.ts']
  }
})
