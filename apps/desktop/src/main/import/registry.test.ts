import { describe, it, expect, beforeEach } from 'vitest'
import { registerImporter, getImporter, listImporters, __resetRegistry } from './registry'
import type { Importer } from './types'

const fake: Importer = {
  id: 'fake',
  name: 'Fake',
  fileSpec: { label: 'Fake', extensions: ['zip'], allowMultiple: false },
  run: async () => ({ imported: 0, attachments: 0, skipped: 0, failed: [] })
}

describe('importer registry', () => {
  beforeEach(() => __resetRegistry())

  it('registers and looks up by id', () => {
    registerImporter(fake)
    expect(getImporter('fake')).toBe(fake)
  })

  it('lists registered importers', () => {
    registerImporter(fake)
    expect(listImporters().map((i) => i.id)).toEqual(['fake'])
  })

  it('throws on duplicate id', () => {
    registerImporter(fake)
    expect(() => registerImporter(fake)).toThrow(/already registered/)
  })

  it('returns undefined for unknown id', () => {
    expect(getImporter('nope')).toBeUndefined()
  })
})
