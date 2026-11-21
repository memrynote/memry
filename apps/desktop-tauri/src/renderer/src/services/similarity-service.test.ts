import { beforeEach, describe, expect, it, vi } from 'vitest'

const commands = vi.hoisted(() => ({
  notesGetSimilar: vi.fn(),
  notesGetTagSuggestions: vi.fn(),
  notesCluster: vi.fn()
}))

vi.mock('../../../generated/bindings', () => ({ commands }))

import { similarityService } from './similarity-service'

describe('similarityService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('asks for the default number of similar notes when no limit is given', async () => {
    const answer = { status: 'ready', notes: [] }
    commands.notesGetSimilar.mockResolvedValue(answer)
    await expect(similarityService.getSimilar('a')).resolves.toBe(answer)
    expect(commands.notesGetSimilar).toHaveBeenCalledWith('a', null)
    await similarityService.getSimilar('a', 3)
    expect(commands.notesGetSimilar).toHaveBeenLastCalledWith('a', 3)
  })

  it('answers the tag suggestions of one note', async () => {
    const answer = { status: 'no-embedding', tags: [] }
    commands.notesGetTagSuggestions.mockResolvedValue(answer)
    await expect(similarityService.getTagSuggestions('a')).resolves.toBe(answer)
    expect(commands.notesGetTagSuggestions).toHaveBeenCalledWith('a')
  })

  it('groups the given notes', async () => {
    const answer = { status: 'ready', groups: [], ungrouped: ['a'], missing: [] }
    commands.notesCluster.mockResolvedValueOnce(answer)
    await expect(similarityService.cluster(['a'])).resolves.toBe(answer)
    expect(commands.notesCluster).toHaveBeenCalledWith(['a'])
  })
})
