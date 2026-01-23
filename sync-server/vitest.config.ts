import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    globals: true,
    passWithNoTests: true,
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 10000,
    pool: 'threads',
    isolate: true
  },
  resolve: {
    alias: {
      '@sync-server': resolve(__dirname, 'src')
    }
  }
})
