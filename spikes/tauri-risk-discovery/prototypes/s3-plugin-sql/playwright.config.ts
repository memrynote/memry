import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/bench',
  timeout: 30000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'playwright-report/results.json' }]
  ],

  use: {
    baseURL: 'http://localhost:1420',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure'
  },

  projects: [
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] }
    }
  ],

  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:1420',
    reuseExistingServer: !process.env.CI,
    timeout: 30000
  }
})
