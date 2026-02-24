import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

const projectRoot = resolve(__dirname, '..')

export default defineConfig({
  test: {
    globals: true,
    passWithNoTests: true,
    projects: [
      resolve(projectRoot, 'sync-server'),
      {
        extends: true,
        test: {
          name: 'shared',
          root: projectRoot,
          environment: 'node',
          include: ['src/shared/**/*.{test,spec}.{ts,tsx}'],
          setupFiles: ['tests/setup.ts']
        }
      },
      {
        extends: true,
        test: {
          name: 'main',
          root: projectRoot,
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
        test: {
          name: 'renderer',
          root: projectRoot,
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
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      thresholds: {
        statements: 50,
        branches: 50,
        functions: 50,
        lines: 50
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
      '@': resolve(projectRoot, 'src/renderer/src'),
      '@renderer': resolve(projectRoot, 'src/renderer/src'),
      '@shared': resolve(projectRoot, 'src/shared'),
      '@tests': resolve(projectRoot, 'tests')
    }
  }
})
