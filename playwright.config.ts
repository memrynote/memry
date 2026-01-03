/**
 * Playwright configuration for Electron E2E testing.
 */

import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',

  // Timeout for each test
  timeout: 60000,

  // Timeout for expect assertions
  expect: {
    timeout: 10000
  },

  // Run tests in parallel
  fullyParallel: false, // Electron tests often need sequential execution

  // Fail fast on CI
  forbidOnly: !!process.env.CI,

  // Retry failed tests
  retries: process.env.CI ? 2 : 0,

  // Limit workers for Electron tests
  workers: 1,

  // Reporter configuration
  reporter: [['html', { outputFolder: 'test-results/e2e' }], ['list']],

  // Output directory
  outputDir: 'test-results/e2e-artifacts',

  // Global setup and teardown
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',

  // Use custom Electron fixtures
  use: {
    // Capture trace on failure
    trace: 'on-first-retry',

    // Capture screenshot on failure
    screenshot: 'only-on-failure',

    // Capture video on failure
    video: 'on-first-retry'
  },

  projects: [
    {
      name: 'electron',
      testMatch: '**/*.e2e.{ts,tsx}'
    }
  ]
})
