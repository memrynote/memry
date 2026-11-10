import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contentHash } from './content-hash'

// The core's vectors, pinned to Electron's output: the renderer must hash as the core does.
const fixture = resolve(
  process.cwd(),
  '../../crates/memry-desktop/tests/fixtures/content-hash.json'
)
const { cases } = JSON.parse(readFileSync(fixture, 'utf8')) as {
  cases: { name: string; units: number[]; hash: string }[]
}

describe('contentHash', () => {
  it.each(cases)('hashes $name as the core does', ({ units, hash }) => {
    expect(contentHash(String.fromCharCode(...units))).toBe(hash)
  })
})
