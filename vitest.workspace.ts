import { defineProject, defineWorkspace } from 'vitest/config'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

export default [
  // ============================================================================
  // Shared Workspace - Pure TypeScript (Zod schemas, Drizzle queries)
  // ============================================================================
  {
    extends: './vitest.config.ts',
    test: {
      name: 'shared',
      environment: 'node',
      include: ['src/shared/**/*.{test,spec}.{ts,tsx}'],
      setupFiles: ['./tests/setup.ts'],
      globals: true
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@tests': resolve(__dirname, 'tests')
      }
    }
  },

  // ============================================================================
  // Main Process Workspace - Node.js (IPC handlers, database, vault)
  // ============================================================================
  {
    extends: './vitest.config.ts',
    test: {
      name: 'main',
      environment: 'node',
      include: ['src/main/**/*.{test,spec}.{ts,tsx}'],
      setupFiles: ['./tests/setup.ts'],
      globals: true,
      // Longer timeout for database operations
      testTimeout: 15000,
      hookTimeout: 15000,
      // Thread isolation for database tests
      pool: 'forks',
      isolate: true
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@tests': resolve(__dirname, 'tests')
      }
    }
  },

  // ============================================================================
  // Renderer Workspace - JSDOM (React components, hooks)
  // ============================================================================
  {
    extends: './vitest.config.ts',
    test: {
      name: 'renderer',
      environment: 'jsdom',
      include: ['src/renderer/**/*.{test,spec}.{ts,tsx}'],
      setupFiles: ['./tests/setup.ts', './tests/setup-dom.ts'],
      globals: true,
      // CSS handling for component tests
      css: true,
      // Environment options
      environmentOptions: {
        jsdom: {
          resources: 'usable'
        }
      }
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared'),
        '@tests': resolve(__dirname, 'tests')
      }
    }
  }
]
