import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as barrel from '@hugeicons/core-free-icons'
import * as subset from './hugeicons-subset'

const appRoot = resolve(__dirname, '../../../../..')

describe('hugeicons-subset', () => {
  it('resolves every eager icon to the same glyph the package barrel exports', () => {
    const names = Object.keys(subset)
    expect(names.length).toBeGreaterThan(200)

    for (const name of names) {
      const fromBarrel = (barrel as Record<string, unknown>)[name]
      expect(fromBarrel, `${name} is missing from @hugeicons/core-free-icons`).toBeDefined()
      expect((subset as Record<string, unknown>)[name], `${name} glyph changed`).toEqual(fromBarrel)
    }
  })

  it('is up to date with the icons the renderer imports', () => {
    execFileSync('node', ['scripts/generate-hugeicon-subset.mjs', '--check'], {
      cwd: appRoot,
      stdio: 'pipe'
    })
  })
})
