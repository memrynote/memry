/**
 * Global setup for Playwright E2E tests.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

const NATIVE_STAMP = path.resolve(__dirname, '../../node_modules/.native-build-target')

function verifyElectronAbi(): void {
  let stamp = ''
  try {
    stamp = fs.readFileSync(NATIVE_STAMP, 'utf8').trim()
  } catch {
    // no stamp file — ensure-native.sh hasn't run yet for this workspace
  }

  if (stamp === 'electron') return

  const actual = stamp || '<unbuilt>'
  const message = [
    '',
    '✗ E2E precondition failed: better-sqlite3 is built for ABI "' + actual + '", not "electron".',
    '  The app would boot to the "Welcome to Memry" onboarding screen instead of the test vault,',
    '  because autoOpenLastVault fails silently with ERR_DLOPEN_FAILED.',
    '',
    '  Fix (pick one):',
    '    pnpm --filter @memry/desktop rebuild:electron',
    '    bash apps/desktop/scripts/ensure-native.sh electron',
    '    pnpm --filter @memry/desktop test:e2e   # pretest:e2e will run ensure-native automatically',
    ''
  ].join('\n')

  throw new Error(message)
}

async function globalSetup() {
  console.log('Setting up E2E test environment...')

  verifyElectronAbi()

  if (process.env.BUILD_BEFORE_TEST) {
    const { execSync } = await import('child_process')
    execSync('pnpm build', { stdio: 'inherit' })
  }

  console.log('E2E test environment ready')
}

export default globalSetup
