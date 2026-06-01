import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
import react from '@vitejs/plugin-react'

const appRoot = resolve(__dirname, '..')
const workspaceRoot = resolve(appRoot, '../..')

export default defineConfig({
  test: {
    globals: true,
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'shared',
          root: appRoot,
          environment: 'node',
          include: [
            '../../packages/contracts/src/**/*.{test,spec}.{ts,tsx}',
            '../../packages/db-schema/src/**/*.{test,spec}.{ts,tsx}',
            '../../packages/domain-inbox/src/**/*.{test,spec}.{ts,tsx}',
            '../../packages/domain-notes/src/**/*.{test,spec}.{ts,tsx}',
            '../../packages/domain-tasks/src/**/*.{test,spec}.{ts,tsx}',
            '../../packages/rpc/src/**/*.{test,spec}.{ts,tsx}',
            '../../packages/shared/src/**/*.{test,spec}.{ts,tsx}',
            '../../packages/storage-data/src/**/*.{test,spec}.{ts,tsx}',
            '../../packages/storage-vault/src/**/*.{test,spec}.{ts,tsx}',
            '../../packages/sync-core/src/**/*.{test,spec}.{ts,tsx}'
          ],
          setupFiles: ['tests/setup.ts']
        }
      },
      {
        extends: true,
        test: {
          name: 'main',
          root: appRoot,
          environment: 'node',
          include: [
            'src/main/**/*.{test,spec}.{ts,tsx}',
            'scripts/seed-data/**/*.{test,spec}.{ts,tsx}'
          ],
          setupFiles: ['tests/setup.ts'],
          testTimeout: 30000,
          hookTimeout: 30000,
          pool: 'forks',
          isolate: true
        }
      },
      {
        extends: true,
        test: {
          name: 'preload',
          root: appRoot,
          environment: 'node',
          include: ['src/preload/**/*.{test,spec}.{ts,tsx}'],
          setupFiles: ['tests/setup.ts']
        }
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: 'renderer',
          root: appRoot,
          environment: 'jsdom',
          include: ['src/renderer/**/*.{test,spec}.{ts,tsx}'],
          setupFiles: ['tests/setup.ts', 'tests/setup-dom.ts'],
          css: true,
          testTimeout: 30000,
          hookTimeout: 30000,
          environmentOptions: {
            jsdom: {
              resources: 'usable'
            }
          }
        }
      }
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html', 'lcov'],
      reportsDirectory: './coverage',
      reportOnFailure: true,
      exclude: [
        'node_modules/**',
        'dist/**',
        'out/**',
        'tests/**',
        '**/*.d.ts',
        '**/*.config.*',
        '**/types/**'
      ],
      include: [
        'src/**/*.ts',
        'src/**/*.tsx',
        '../../packages/contracts/src/**/*.ts',
        '../../packages/db-schema/src/**/*.ts',
        '../../packages/domain-inbox/src/**/*.ts',
        '../../packages/domain-notes/src/**/*.ts',
        '../../packages/domain-tasks/src/**/*.ts',
        '../../packages/rpc/src/**/*.ts',
        '../../packages/shared/src/**/*.ts',
        '../../packages/storage-data/src/**/*.ts',
        '../../packages/storage-vault/src/**/*.ts',
        '../../packages/sync-core/src/**/*.ts'
      ],
      // Coverage ratchet baseline (2026-06-01, Vitest 4.1/V8 coverage engine):
      //   statements 87.73  branches 75.27  functions 87.84  lines 89.70
      // Thresholds stay close to the measured baseline so the suite passes today
      // but coverage regressions still trip the ratchet.
      thresholds: {
        statements: 87.7,
        branches: 75,
        functions: 87.8,
        lines: 89.7
      }
    },
    reporters: ['verbose'],
    pool: 'threads',
    isolate: true,
    testTimeout: 10000,
    hookTimeout: 10000
  },
  resolve: {
    alias: {
      '@memry/contracts': resolve(workspaceRoot, 'packages/contracts/src'),
      '@memry/domain-tasks': resolve(workspaceRoot, 'packages/domain-tasks/src'),
      '@memry/domain-inbox': resolve(workspaceRoot, 'packages/domain-inbox/src'),
      '@memry/db-schema': resolve(workspaceRoot, 'packages/db-schema/src'),
      '@memry/domain-notes': resolve(workspaceRoot, 'packages/domain-notes/src'),
      '@memry/rpc': resolve(workspaceRoot, 'packages/rpc/src'),
      '@memry/storage-data': resolve(workspaceRoot, 'packages/storage-data/src'),
      '@memry/sync-core': resolve(workspaceRoot, 'packages/sync-core/src'),
      '@memry/shared': resolve(workspaceRoot, 'packages/shared/src'),
      '@memry/storage-vault': resolve(workspaceRoot, 'packages/storage-vault/src'),
      '@main': resolve(appRoot, 'src/main'),
      '@': resolve(appRoot, 'src/renderer/src'),
      '@renderer': resolve(appRoot, 'src/renderer/src'),
      '@tests': resolve(appRoot, 'tests')
    }
  }
})
