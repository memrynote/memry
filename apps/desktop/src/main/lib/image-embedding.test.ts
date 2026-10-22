import { beforeEach, describe, expect, it, vi } from 'vitest'

const settings = vi.hoisted(() => new Map<string, string>())
const generateImageEmbedding = vi.hoisted(() => vi.fn())

vi.mock('../database', () => ({ getDatabase: () => ({}) }))
vi.mock('@main/database/queries/settings', () => ({
  getSetting: (_db: unknown, key: string) => settings.get(key) ?? null
}))
vi.mock('./embeddings', () => ({ generateImageEmbedding }))

import { embedImage } from './image-embedding'

describe('embedImage', () => {
  const image = new Uint8Array([1])

  beforeEach(() => {
    settings.clear()
    generateImageEmbedding.mockReset().mockResolvedValue(new Float32Array(1))
  })

  it('embeds by default, so the encoder downloads on first image use', async () => {
    await expect(embedImage(image)).resolves.toBeInstanceOf(Float32Array)
    expect(generateImageEmbedding).toHaveBeenCalledWith(image, undefined)
  })

  it('never reaches the worker when the user turned image embeddings off', async () => {
    settings.set('ai.imageEmbeddings', 'false')
    await expect(embedImage(image)).resolves.toBeNull()
    expect(generateImageEmbedding).not.toHaveBeenCalled()
  })

  it('never reaches the worker when AI is off', async () => {
    settings.set('ai.enabled', 'false')
    await expect(embedImage(image)).resolves.toBeNull()
    expect(generateImageEmbedding).not.toHaveBeenCalled()
  })
})
