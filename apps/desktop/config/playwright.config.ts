import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '../tests/e2e',

  timeout: 60000,

  expect: {
    timeout: 10000
  },

  fullyParallel: false,

  forbidOnly: !!process.env.CI,

  retries: process.env.CI ? 2 : 0,

  workers: 1,

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
