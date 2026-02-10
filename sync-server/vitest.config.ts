import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    name: 'sync-server',
    environment: 'node',
    globals: true,
    include: ['src/**/*.{test,spec}.ts', 'schema/**/*.{test,spec}.ts', 'wrangler.test.ts']
  },
  resolve: {
    alias: {
      'cloudflare:workers': resolve(__dirname, 'src/__mocks__/cloudflare-workers.ts')
    }
  }
})
