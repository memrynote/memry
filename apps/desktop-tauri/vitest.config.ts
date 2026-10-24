import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const appRoot = import.meta.dirname
const workspaceRoot = resolve(appRoot, '../..')
const pkg = (name: string) => resolve(workspaceRoot, 'packages', name, 'src')

// Port of the `renderer` project of apps/desktop/config/vitest.config.ts. The shared packages'
// tests stay in apps/desktop's `shared` project.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@memry/contracts': pkg('contracts'),
      '@memry/db-schema': pkg('db-schema'),
      '@memry/domain-inbox': pkg('domain-inbox'),
      '@memry/domain-notes': pkg('domain-notes'),
      '@memry/domain-tasks': pkg('domain-tasks'),
      '@memry/rpc': pkg('rpc'),
      '@memry/shared': pkg('shared'),
      '@memry/storage-data': pkg('storage-data'),
      '@memry/storage-vault': pkg('storage-vault'),
      '@memry/sync-core': pkg('sync-core'),
      '@renderer': resolve(appRoot, 'src/renderer/src'),
      '@': resolve(appRoot, 'src/renderer/src'),
      '@tests': resolve(appRoot, 'tests')
    }
  },
  test: {
    globals: true,
    passWithNoTests: true,
    name: 'renderer',
    root: appRoot,
    environment: 'jsdom',
    include: ['src/renderer/**/*.{test,spec}.{ts,tsx}', 'scripts/*.test.ts'],
    setupFiles: ['tests/setup.ts', 'tests/setup-dom.ts'],
    css: true,
    // `@react-sigma/core` is the one dependency a test drives for real rather than stubbing
    // (local-graph-panel-sigma-lifecycle.test.tsx needs its genuine recreate rule); inlined,
    // `vi.mock('sigma')` applies to it.
    server: { deps: { inline: ['@react-sigma/core'] } },
    testTimeout: 30000,
    hookTimeout: 30000,
    environmentOptions: { jsdom: { resources: 'usable' } }
  }
})
