import { describe, it, expect } from 'vitest'
import { createTreeFolderFilter } from './folder-visibility'

describe('createTreeFolderFilter', () => {
  it('hides attachments/ and lists the folder a non-default attachmentsFolder names', () => {
    const visible = createTreeFolderFilter({
      excludePatterns: [],
      defaultNoteFolder: '',
      journalFolder: 'journal',
      journalDateFormat: 'YYYY-MM-DD',
      attachmentsFolder: 'files'
    })

    expect(visible('attachments')).toBe(false)
    expect(visible('attachments/n1')).toBe(false)
    expect(visible('files')).toBe(true)
  })
})
