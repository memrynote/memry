import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const embeddings = vi.hoisted(() => ({ generate: vi.fn() }))

vi.mock('../../database', () => ({
  getDatabase: () => ({}),
  getIndexDatabase: () => ({}),
  getRawIndexDatabase: () => ({ prepare: () => ({ run: vi.fn() }) })
}))
vi.mock('@main/database/queries/settings', () => ({
  getSetting: () => 'true',
  setSetting: vi.fn()
}))
vi.mock('@main/database/queries/extracted-text', () => ({ readExtractedOpening: () => '' }))
vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: (_db: unknown, id: string) => ({
    id,
    path: 'notes/linked.md',
    title: 'Linked',
    fileType: 'markdown'
  })
}))
vi.mock('../../lib/embeddings', () => ({
  generateEmbedding: embeddings.generate,
  initEmbeddingModel: async () => true,
  isModelLoaded: () => true
}))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

import { createEmbeddingProjector } from './embedding-projector'

describe('embedding projector and a note file linked outside the vault (#2969)', () => {
  let vault: string
  let outside: string

  beforeEach(() => {
    embeddings.generate.mockResolvedValue(new Float32Array([0.1, 0.2]))
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-embedding-vault-'))
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-embedding-outside-'))
    const secret = path.join(outside, 'private.md')
    fs.writeFileSync(secret, 'Outside secret body that is long enough to embed\n')
    fs.mkdirSync(path.join(vault, 'notes'))
    fs.symlinkSync(secret, path.join(vault, 'notes', 'linked.md'))
  })

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  it('embeds nothing from the outside file when its attachment text changes', async () => {
    await createEmbeddingProjector(() => vault).project({
      type: 'note.text-extracted',
      noteId: 'note-linked'
    })

    expect(embeddings.generate).not.toHaveBeenCalled()
  })
})
