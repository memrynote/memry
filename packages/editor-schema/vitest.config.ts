import { defineConfig } from 'vitest/config'

/**
 * The schema-parity gate needs a DOM: every spec in this package builds real
 * elements, and the whole point of the gate is to compare what they build.
 * jsdom is the same environment the renderer suite runs under. It is NOT the
 * exact one the main process gets — `@blocknote/server-util` bundles its own,
 * currently a major behind — so this suite gates the specs' shape, and the
 * desktop main suite gates their behaviour through the real converter.
 */
export default defineConfig({
  test: {
    name: 'editor-schema',
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    reporters: ['verbose']
  }
})
