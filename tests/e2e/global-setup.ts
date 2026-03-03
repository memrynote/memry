/**
 * Global setup for Playwright E2E tests.
 */

async function globalSetup() {
  console.log('Setting up E2E test environment...')

  // Build the application if needed
  // You might want to skip this in CI if already built
  if (process.env.BUILD_BEFORE_TEST) {
    const { execSync } = await import('child_process')
    execSync('pnpm build', { stdio: 'inherit' })
  }

  console.log('E2E test environment ready')
}

export default globalSetup
