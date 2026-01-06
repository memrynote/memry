import { defineConfig, mergeConfig } from 'vitest/config'
import { resolve } from 'path'

const baseConfig = defineConfig({
  test: {
    globals: true,
    passWithNoTests: true,
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
      '@': resolve(__dirname, 'src/renderer/src'),
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@tests': resolve(__dirname, 'tests')
    }
  }
})

export default defineConfig({
  test: {
    globals: true,
    passWithNoTests: true,
    projects: [
      // Shared tests - Node environment
      {
        ...baseConfig,
        test: {
          ...baseConfig.test,
          name: 'shared',
          environment: 'node',
          include: ['src/shared/**/*.{test,spec}.{ts,tsx}'],
          setupFiles: ['./tests/setup.ts']
        }
      },
      // Main process tests - Node environment
      {
        ...baseConfig,
        test: {
          ...baseConfig.test,
          name: 'main',
          environment: 'node',
          include: ['src/main/**/*.{test,spec}.{ts,tsx}'],
          setupFiles: ['./tests/setup.ts'],
          testTimeout: 15000,
          hookTimeout: 15000,
          pool: 'forks',
          isolate: true
        }
      },
      // Renderer tests - JSDOM environment
      {
        ...baseConfig,
        test: {
          ...baseConfig.test,
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/renderer/**/*.{test,spec}.{ts,tsx}'],
          setupFiles: ['./tests/setup.ts', './tests/setup-dom.ts'],
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
      '@': resolve(__dirname, 'src/renderer/src'),
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@tests': resolve(__dirname, 'tests')
    }
  }
})
