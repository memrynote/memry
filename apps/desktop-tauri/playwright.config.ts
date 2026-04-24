import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright config for Tauri WebKit e2e tests.
 *
 * At M1 the Rust backend is mock-only. These tests run against the Vite dev
 * server directly because the renderer does not depend on Tauri-backed
 * commands yet (every invoke routes through src/lib/ipc/invoke.ts's mock
 * router). Real Tauri runtime tests belong in M5+.
 */
export default defineConfig({
  testDir: './e2e/specs',
  timeout: 30_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:1420',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  projects: [
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] }
    }
  ],
  webServer: {
    command: 'pnpm vite',
    url: 'http://localhost:1420',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe'
  }
})
