import { defineConfig } from 'vitest/config'

/**
 * No DOM: the suite covers the markdown conversion pair, which is four editor
 * calls and a string split. The guest's DOM behaviour is gated by the mobile
 * and desktop suites that drive a real editor; what is worth pinning here is
 * the rules — frontmatter split, empty-document guard, and a parse failure
 * reported rather than swallowed as an empty document.
 */
export default defineConfig({
  test: {
    name: 'editor-web',
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    reporters: ['verbose']
  }
})
