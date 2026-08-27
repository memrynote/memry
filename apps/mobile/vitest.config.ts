import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Node-side tests for the RN logic that has no native dependency.
 *
 * `__DEV__` is a React Native global that Metro defines; modules under test
 * read it (the logger's `debug` sink, the dev-only counter surfaces), so it is
 * defined here too. `false` matches a release build, which is the behaviour a
 * test should be asserting against.
 */
export default defineConfig({
  resolve: {
    alias: {
      // The same `@/*` -> `src/*` mapping `tsconfig.json` gives the app.
      // Without it a test can only reach modules whose whole import graph
      // happens to use relative paths, which is an accident, not a rule.
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  define: {
    __DEV__: false
  }
})
