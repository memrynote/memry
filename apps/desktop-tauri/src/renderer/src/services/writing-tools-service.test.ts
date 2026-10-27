import { beforeEach, describe, expect, it, vi } from 'vitest'
import { spellingFor, writingToolsService } from './writing-tools-service'

const commands = vi.hoisted(() => ({
  spellCheckWord: vi.fn(),
  spellAddWord: vi.fn()
}))

vi.mock('../../../generated/bindings', () => ({ commands }))
vi.mock('../lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

beforeEach(() => {
  commands.spellCheckWord.mockReset()
  commands.spellAddWord.mockReset()
})

describe('spellingFor', () => {
  it('turns a misspelled word into menu data with the suggestions', async () => {
    commands.spellCheckWord.mockResolvedValue({
      available: true,
      misspelled: true,
      suggestions: ['the', 'tea']
    })

    expect(await spellingFor('teh')).toEqual({
      misspelledWord: 'teh',
      dictionarySuggestions: ['the', 'tea']
    })
  })

  it('gives no menu data for a correct word or a platform with no dictionary', async () => {
    commands.spellCheckWord.mockResolvedValueOnce({
      available: true,
      misspelled: false,
      suggestions: []
    })
    expect(await spellingFor('the')).toBeNull()

    commands.spellCheckWord.mockResolvedValueOnce({
      available: false,
      misspelled: false,
      suggestions: []
    })
    expect(await spellingFor('teh')).toBeNull()
  })

  it('treats a failed lookup as no spelling data instead of blocking the menu', async () => {
    commands.spellCheckWord.mockRejectedValue(new Error('backend gone'))
    expect(await spellingFor('teh')).toBeNull()
  })
})

describe('writingToolsService.addWordToDictionary', () => {
  it('asks the platform dictionary to learn the word', async () => {
    commands.spellAddWord.mockResolvedValue(true)
    expect(await writingToolsService.addWordToDictionary('memry')).toBe(true)
    expect(commands.spellAddWord).toHaveBeenCalledWith('memry')
  })
})
