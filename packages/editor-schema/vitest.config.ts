import { defineConfig } from 'vitest/config'

/**
 * The schema-parity gate needs a DOM: every spec in this package builds real
 * elements, and the whole point of the gate is to compare what they build.
 * jsdom is the same environment the renderer suite uses and the same one
 * `@blocknote/server-util` installs around the main process, so a spec that
 * passes here behaves the same on both sides of the IPC boundary.
 */
export default defineConfig({
  test: {
    name: 'editor-schema',
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    reporters: ['verbose']
  }
})
