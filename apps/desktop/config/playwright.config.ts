import { defineConfig } from '@playwright/test'

const isCi = process.env.CI === 'true'
const testTimeoutMs = isCi ? 180_000 : 60_000
const expectTimeoutMs = isCi ? 60_000 : 20_000

export default defineConfig({
  testDir: '../tests/e2e',

  timeout: testTimeoutMs,

  expect: {
    // Sync, agent, and CRDT polls can exceed local budgets on GitHub's Linux runners
    // even when the app eventually converges.
    timeout: expectTimeoutMs
  },

  fullyParallel: false,

  forbidOnly: !!process.env.CI,

  retries: process.env.CI ? 2 : 0,

  // Two workers on CI: every launch gets its own mkdtemp userData dir, its own
  // `e2e-<uuid>` MEMRY_DEVICE (so keychain accounts never overlap), and every
  // in-test server binds port 0 — so the isolation is per-launch, not per-process.
  // Paired with 8 shards instead of 16 this keeps the same 16 lanes while paying
  // the ~6 min job setup half as many times.
  workers: 2,

  reporter: [['html', { outputFolder: '../test-results/e2e' }], ['list']],

  outputDir: '../test-results/e2e-artifacts',

  globalSetup: '../tests/e2e/global-setup.ts',
  globalTeardown: '../tests/e2e/global-teardown.ts',

  use: {
    trace: 'on-first-retry',

    screenshot: 'only-on-failure',

    video: 'on-first-retry'
  },

  projects: [
    {
      name: 'electron',
      testMatch: '**/*.e2e.{ts,tsx}'
    }
  ]
})
