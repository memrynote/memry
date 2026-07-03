import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageJson = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
}

// package.json `dependencies` is a contract, not a convenience: electron-vite
// externalizes exactly these modules and pnpm deploy ships them loose next to
// app.asar. macOS Squirrel code-sign-verifies every loose file on auto-update,
// so each package added here slows Restart for every user. Everything bundleable
// belongs in devDependencies (electron-vite bundles it into out/).
// See docs/auto-update-slow-restart-investigation.md.
const externalRuntimeDependencies = [
  '@huggingface/transformers',
  '@mixmark-io/domino',
  'better-sqlite3',
  'jsdom',
  'keytar',
  // UMD + inlined-wasm module; rollup's CJS interop breaks it when bundled
  'libsodium-wrappers-sumo',
  'sharp',
  'sqlite-vec',
  'y-leveldb',
  // must be a single instance: external y-leveldb resolves its yjs peer from
  // the loose tree, so the main bundle has to use that same copy
  'yjs'
]

describe('runtime dependencies', () => {
  it('ships exactly the native/unbundleable modules as production dependencies', () => {
    const dependencies = Object.keys(packageJson.dependencies ?? {}).sort()

    expect(dependencies).toEqual(externalRuntimeDependencies)
  })
})
