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
            '../../packages/shared/src/**/*.{test,spec}.{ts,tsx}',
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
          include: ['src/main/**/*.{test,spec}.{ts,tsx}'],
          setupFiles: ['tests/setup.ts'],
          testTimeout: 15000,
          hookTimeout: 15000,
          pool: 'forks',
          isolate: true
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
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
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
        '../../packages/shared/src/**/*.ts'
      ],
      thresholds: {
        statements: 30,
        branches: 20,
        functions: 25,
        lines: 30
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
      '@memry/db-schema': resolve(workspaceRoot, 'packages/db-schema/src'),
      '@memry/storage-data': resolve(workspaceRoot, 'packages/storage-data/src'),
      '@memry/sync-core': resolve(workspaceRoot, 'packages/sync-core/src'),
      '@memry/shared': resolve(workspaceRoot, 'packages/shared/src'),
      '@main': resolve(appRoot, 'src/main'),
      '@': resolve(appRoot, 'src/renderer/src'),
      '@renderer': resolve(appRoot, 'src/renderer/src'),
      '@tests': resolve(appRoot, 'tests')
    }
  }
})
