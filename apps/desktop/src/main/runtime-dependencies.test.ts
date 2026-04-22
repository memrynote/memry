import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('desktop package runtime dependencies', () => {
  it('keeps startup-critical runtime modules in production dependencies', () => {
    const packageJsonPath = resolve(process.cwd(), 'package.json')
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }

    expect(packageJson.dependencies?.['better-sqlite3']).toBeDefined()
    expect(packageJson.devDependencies?.['better-sqlite3']).toBeUndefined()
    expect(packageJson.dependencies?.['safe-buffer']).toBeDefined()
    expect(packageJson.dependencies?.['orderedmap']).toBeDefined()
    expect(packageJson.dependencies?.['fast-equals']).toBeDefined()
    expect(packageJson.dependencies?.['jsdom']).toBeDefined()
    expect(packageJson.dependencies?.['prosemirror-keymap']).toBeDefined()
    expect(packageJson.dependencies?.['safer-buffer']).toBeDefined()
    expect(packageJson.dependencies?.['w3c-keyname']).toBeDefined()
    expect(packageJson.dependencies?.['linkifyjs']).toBeDefined()
    expect(packageJson.dependencies?.['rope-sequence']).toBeDefined()
    expect(packageJson.devDependencies?.['jsdom']).toBeUndefined()
  })

  it('can resolve startup-critical transitive modules from the desktop workspace', () => {
    const requireFromDesktop = createRequire(resolve(process.cwd(), 'package.json'))

    expect(() => requireFromDesktop.resolve('safe-buffer')).not.toThrow()
    expect(() => requireFromDesktop.resolve('safer-buffer')).not.toThrow()
    expect(() => requireFromDesktop.resolve('orderedmap')).not.toThrow()
    expect(() => requireFromDesktop.resolve('fast-equals')).not.toThrow()
    expect(() => requireFromDesktop.resolve('jsdom')).not.toThrow()
    expect(() => requireFromDesktop.resolve('prosemirror-commands')).not.toThrow()
    expect(() => requireFromDesktop.resolve('prosemirror-keymap')).not.toThrow()
    expect(() => requireFromDesktop.resolve('w3c-keyname')).not.toThrow()
    expect(() => requireFromDesktop.resolve('linkifyjs')).not.toThrow()
    expect(() => requireFromDesktop.resolve('rope-sequence')).not.toThrow()
  })
})
