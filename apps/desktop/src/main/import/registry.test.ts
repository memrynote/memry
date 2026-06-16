import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerImporter,
  getImporter,
  listImporters,
  listImporterMeta,
  __resetRegistry
} from './registry'
import type { Importer } from './types'

const fake: Importer = {
  id: 'fake',
  name: 'Fake',
  descriptionKey: 'import.sources.fake',
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

  it('projects metadata with preview capability', () => {
    registerImporter(fake)
    registerImporter({
      ...fake,
      id: 'with-preview',
      name: 'WithPreview',
      preview: async () => ({ groups: [] })
    })

    const meta = listImporterMeta()
    expect(meta.map((m) => m.id)).toEqual(['fake', 'with-preview'])
    expect(meta.find((m) => m.id === 'fake')?.supportsPreview).toBe(false)
    expect(meta.find((m) => m.id === 'with-preview')?.supportsPreview).toBe(true)
    expect(meta[0].fileSpec).toEqual({ label: 'Fake', extensions: ['zip'], allowMultiple: false })
  })
})
