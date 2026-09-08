import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import { parseNote } from './frontmatter'
import { migrateNestedPropertiesToRoot } from './root-properties-migration'

const tempVaults: string[] = []

afterEach(() => {
  for (const vaultPath of tempVaults.splice(0)) {
    rmSync(vaultPath, { recursive: true, force: true })
  }
})

describe('migrateNestedPropertiesToRoot', () => {
  it('moves nested properties to root, keeps root conflicts, and converges on rerun', async () => {
    const vaultPath = mkdtempSync(path.join('/tmp', 'memry-root-properties-'))
    tempVaults.push(vaultPath)
    mkdirSync(path.join(vaultPath, 'notes'), { recursive: true })

    const notePath = path.join(vaultPath, 'notes', 'Mobile.md')
    writeFileSync(
      notePath,
      [
        '---',
        'tags:',
        '  - mobile',
        'status: active',
        'properties:',
        '  status: idea',
        '  owner: Kaan',
        '---',
        '',
        'Body stays byte-for-byte.',
        ''
      ].join('\n')
    )

    const originalMtime = statSync(notePath).mtimeMs
    await expect(migrateNestedPropertiesToRoot(vaultPath)).resolves.toEqual({
      scanned: 1,
      migrated: 1,
      migratedPaths: ['notes/Mobile.md'],
      skipped: 0,
      deferred: 0,
      failed: 0,
      conflicts: ['status']
    })

    const firstPass = readFileSync(notePath, 'utf8')
    const parsed = parseNote(firstPass, notePath)
    expect(parsed.frontmatter).toEqual({
      tags: ['mobile'],
      status: 'active',
      owner: 'Kaan'
    })
    expect(parsed.content).toBe('\nBody stays byte-for-byte.\n')
    expect(firstPass).not.toMatch(/^properties:/m)
    expect(statSync(notePath).mtimeMs).toBeCloseTo(originalMtime, 0)

    await expect(migrateNestedPropertiesToRoot(vaultPath)).resolves.toEqual({
      scanned: 1,
      migrated: 0,
      migratedPaths: [],
      skipped: 1,
      deferred: 0,
      failed: 0,
      conflicts: []
    })
    expect(readFileSync(notePath, 'utf8')).toBe(firstPass)
  })

  it('defers malformed frontmatter without touching the file', async () => {
    const vaultPath = mkdtempSync(path.join('/tmp', 'memry-root-properties-'))
    tempVaults.push(vaultPath)
    mkdirSync(path.join(vaultPath, 'notes'), { recursive: true })

    const notePath = path.join(vaultPath, 'notes', 'Broken.md')
    const original = '---\nproperties:\n  status: [idea\n---\n\nBody\n'
    writeFileSync(notePath, original)

    await expect(migrateNestedPropertiesToRoot(vaultPath)).resolves.toMatchObject({
      scanned: 1,
      migrated: 0,
      deferred: 1,
      failed: 0
    })
    expect(readFileSync(notePath, 'utf8')).toBe(original)
  })
})
