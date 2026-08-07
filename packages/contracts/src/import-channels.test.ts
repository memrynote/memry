import { describe, it, expect } from 'vitest'
import {
  ImportChannels,
  OneNoteImportChannels,
  ImportStartSchema,
  ImportCancelSchema,
  ImportPickFilesSchema,
  ImportPreviewSchema
} from './import-channels'

describe('ImportChannels', () => {
  it('defines prefixed channels', () => {
    expect(ImportChannels.invoke.PICK_FILES).toBe('import:pick-files')
    expect(ImportChannels.invoke.START).toBe('import:start')
    expect(ImportChannels.invoke.CANCEL).toBe('import:cancel')
    expect(ImportChannels.invoke.PREVIEW).toBe('import:preview')
    expect(ImportChannels.invoke.LIST).toBe('import:list')
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

  it('validates a preview payload', () => {
    expect(
      ImportPreviewSchema.safeParse({
        importId: 'i1',
        importerId: 'todoist',
        sourcePaths: ['/a.csv']
      }).success
    ).toBe(true)
  })

  it('rejects a preview payload with an empty importerId', () => {
    expect(
      ImportPreviewSchema.safeParse({ importId: 'i1', importerId: '', sourcePaths: ['/a.csv'] })
        .success
    ).toBe(false)
  })
})

describe('OneNoteImportChannels', () => {
  it('defines prefixed channels', () => {
    expect(OneNoteImportChannels.invoke.STATUS).toBe('import:onenote:status')
    expect(OneNoteImportChannels.invoke.CONNECT).toBe('import:onenote:connect')
    expect(OneNoteImportChannels.invoke.DISCONNECT).toBe('import:onenote:disconnect')
    expect(OneNoteImportChannels.invoke.NOTEBOOKS).toBe('import:onenote:notebooks')
  })

  it('does not collide with the generic import channels', () => {
    const generic = Object.values(ImportChannels.invoke)
    for (const channel of Object.values(OneNoteImportChannels.invoke)) {
      expect(generic).not.toContain(channel)
    }
  })
})
