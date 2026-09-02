/**
 * The upgrade tripwire for the drawing library's part of the map's links.
 *
 * Three things the map now leans on are library internals with no stability
 * contract, and none of them fails loudly when it changes — the map would
 * simply stop being clickable, or grow back the wall of glyphs this replaced:
 *
 * 1. **`customData` survives the conversion into a scene.** It is the whole
 *    reason a drawn box can carry an address: the library regenerates every
 *    element id on the way in, so an id is no handle and `customData` is.
 * 2. **`viewportCoordsToSceneCoords` is exported at RUNTIME.** The package's
 *    type map resolves modules it does not ship — `isPointHittingLink` and
 *    `hitElementBoundingBox` type-check and then fail at bundle time — so a
 *    type-level check proves nothing about what actually loads.
 * 3. **The pointer cursor is declared important.** The library sets its cursor
 *    inline on its own canvas and re-sets it as the pointer moves, so only an
 *    important rule outranks it.
 *
 * What this file can honestly do about 1 and 2 is read the shipped artifact.
 * The library cannot be imported for real in this suite — the module touches a
 * canvas at import time and jsdom has none, which is why every other test here
 * stands it in — so these are string assertions over the bundle rather than a
 * live call. They will not catch a subtle behaviour change; they WILL catch the
 * field or the export disappearing, which is what an upgrade does. Failing here
 * is the signal to recheck the map's hit test by hand and then move the pin.
 *
 * `assets/excalidraw-context-menu-css.test.ts` is the same shape of guard, for
 * the same reason.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = join(TEST_DIR, '../../../../../..')
const PACKAGE_JSON = join(DESKTOP_ROOT, 'package.json')
const CURSOR_CSS = join(TEST_DIR, 'mind-map-canvas.css')
/** What electron-vite bundles: the package's `production` export condition. */
const RUNTIME_BUNDLE_DIR = join(DESKTOP_ROOT, '../../node_modules/@excalidraw/excalidraw/dist/prod')
const VERIFIED_VERSION = '0.18.1'

function installedVersion(): string | undefined {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  // Bundled into the renderer by electron-vite, so it lives in devDependencies.
  return (
    pkg.dependencies?.['@excalidraw/excalidraw'] ?? pkg.devDependencies?.['@excalidraw/excalidraw']
  )
}

function bundleText(file: string): string {
  return readFileSync(join(RUNTIME_BUNDLE_DIR, file), 'utf8')
}

describe('@excalidraw/excalidraw, where the mind map depends on its internals', () => {
  it('pins the version the map’s link handling was verified against', () => {
    expect(
      installedVersion(),
      '@excalidraw/excalidraw is no longer a desktop dependency'
    ).toBeDefined()
    expect(installedVersion()).toContain(VERIFIED_VERSION)
  })

  it('still exports the viewport-to-scene helper the hit test is built on', () => {
    // Without this there is no way to turn a pointer position into a place on
    // the drawing, and the map's boxes stop being clickable at all.
    expect(bundleText('index.js')).toContain('viewportCoordsToSceneCoords')
  })

  it('still copies `customData` onto the elements it constructs', () => {
    // `_newElementBase` ends with `customData: rest.customData`; minified that
    // reads as `customData:X.customData`. The constructors live in a chunk
    // rather than the entry and the chunk names change every release, so every
    // one of them is searched.
    const chunks = readdirSync(RUNTIME_BUNDLE_DIR).filter((name) => name.endsWith('.js'))
    expect(chunks.length).toBeGreaterThan(0)

    const forwards = chunks.some((name) =>
      /customData\s*:\s*[A-Za-z_$][\w$]*\.customData/.test(bundleText(name))
    )
    expect(forwards, 'the element constructor no longer forwards customData').toBe(true)
  })
})

describe('the pointer cursor the map draws for itself', () => {
  it('is declared, scoped to the map, and marked important', () => {
    // jsdom has no cascade and never renders the library, so a source-level
    // assertion is the only honest guard against the rule being deleted or
    // stripped of the one thing that makes it work.
    const css = readFileSync(CURSOR_CSS, 'utf8')
    const rule = css.match(/\.mind-map-surface\[data-node-hover='true'\][^{]*\{([^}]*)\}/)

    expect(rule, 'no hover-cursor rule in mind-map-canvas.css').not.toBeNull()
    expect(rule?.[1]).toMatch(/cursor:\s*pointer\s*!important/)
  })
})
