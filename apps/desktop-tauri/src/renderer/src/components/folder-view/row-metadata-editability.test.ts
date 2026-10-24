import { describe, expect, it } from 'vitest'
import { isMetadataEditableRow } from './row-metadata-editability'

describe('isMetadataEditableRow', () => {
  it.each([
    [{}, true],
    [{ kind: 'note' as const }, true],
    [{ kind: 'note' as const, fileType: 'markdown' as const }, true],
    [{ fileType: 'pdf' as const }, false],
    [{ fileType: 'image' as const }, false],
    [{ fileType: 'audio' as const }, false],
    [{ fileType: 'video' as const }, false],
    [{ kind: 'task' as const }, false],
    [{ kind: 'inbox' as const }, false],
    [{ kind: 'note' as const, fileType: 'pdf' as const }, false]
  ])('%o → %s', (row, expected) => {
    expect(isMetadataEditableRow(row)).toBe(expected)
  })
})
