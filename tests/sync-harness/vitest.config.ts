import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    // server.start() in beforeAll builds the Worker and applies D1 migrations; slow under host load.
    hookTimeout: 90_000,
    fileParallelism: false
  }
})
