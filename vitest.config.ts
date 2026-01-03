import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    // Global settings applied to all workspaces
    globals: true,
    passWithNoTests: true,

    // Coverage configuration
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
      // Initial thresholds - increase to 80% as tests are added
      thresholds: {
        statements: 50,
        branches: 50,
        functions: 50,
        lines: 50
      }
    },

    // Reporter configuration
    reporters: ['verbose'],

    // Pool configuration for parallelization
    pool: 'threads',
    isolate: true,

    // Timeout settings
    testTimeout: 10000,
    hookTimeout: 10000
  },

  // Path aliases matching electron.vite.config.ts
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src'),
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@tests': resolve(__dirname, 'tests')
    }
  }
})
