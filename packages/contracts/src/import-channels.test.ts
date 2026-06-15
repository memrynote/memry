import { describe, it, expect } from 'vitest'
import {
  ImportChannels,
  ImportStartSchema,
  ImportCancelSchema,
  ImportPickFilesSchema
} from './import-channels'

describe('ImportChannels', () => {
  it('defines prefixed channels', () => {
    expect(ImportChannels.invoke.PICK_FILES).toBe('import:pick-files')
    expect(ImportChannels.invoke.START).toBe('import:start')
    expect(ImportChannels.invoke.CANCEL).toBe('import:cancel')
    expect(ImportChannels.events.PROGRESS).toBe('import:progress')
  })

  it('validates a pick-files payload', () => {
    expect(ImportPickFilesSchema.safeParse({ label: 'Notion', extensions: ['zip'] }).success).toBe(
      true
    )
    expect(ImportPickFilesSchema.safeParse({ label: 'Notion', extensions: [] }).success).toBe(true)
    expect(ImportPickFilesSchema.safeParse({ extensions: ['zip'] }).success).toBe(false)
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
