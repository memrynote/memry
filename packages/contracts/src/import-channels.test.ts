import { describe, it, expect } from 'vitest'
import { ImportChannels, ImportStartSchema, ImportCancelSchema } from './import-channels'

describe('ImportChannels', () => {
  it('defines prefixed channels', () => {
    expect(ImportChannels.invoke.START).toBe('import:start')
    expect(ImportChannels.invoke.CANCEL).toBe('import:cancel')
    expect(ImportChannels.events.PROGRESS).toBe('import:progress')
  })

  it('validates a start payload', () => {
    expect(
      ImportStartSchema.safeParse({
        importId: 'x',
        importerId: 'notion',
        sourcePaths: ['a.zip']
      }).success
    ).toBe(true)
  })

  it('rejects a start payload with empty sourcePaths entries', () => {
    expect(
      ImportStartSchema.safeParse({ importId: 'x', importerId: 'notion', sourcePaths: [''] })
        .success
    ).toBe(false)
  })

  it('rejects an empty cancel payload', () => {
    expect(ImportCancelSchema.safeParse({}).success).toBe(false)
  })
})
