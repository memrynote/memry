import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    name: 'sync-server',
    environment: 'node',
    globals: true,
    include: ['src/**/*.{test,spec}.ts', 'schema/**/*.{test,spec}.ts', 'wrangler.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/__mocks__/**', '**/contracts/**', '**/durable-objects/**'],
      reporter: ['text', 'text-summary'],
      thresholds: {
        statements: 0,
        branches: 0,
        functions: 0,
        lines: 0
      }
    }
  },
  resolve: {
    alias: {
      'cloudflare:workers': resolve(__dirname, 'src/__mocks__/cloudflare-workers.ts')
    }
  }
})
