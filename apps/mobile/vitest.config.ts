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
  define: {
    __DEV__: false
  }
})
