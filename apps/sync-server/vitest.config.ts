import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    name: 'sync-server',
    environment: 'node',
    globals: true,
    setupFiles: ['src/__mocks__/globals-setup.ts'],
    include: ['src/**/*.{test,spec}.ts', 'schema/**/*.{test,spec}.ts', 'wrangler.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/__mocks__/**', '**/durable-objects/**'],
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
      '@memry/contracts': resolve(__dirname, '../../packages/contracts/src'),
      'cloudflare:workers': resolve(__dirname, 'src/__mocks__/cloudflare-workers.ts')
    }
  }
})
