import { describe, expect, it } from 'vitest'
import { claimEditorContextMenu, takeEditorContextMenuClaim } from './editor-context-menu'

describe('editor context menu claim', () => {
  it('hands the next context menu of the claiming window to the editor, once', () => {
    claimEditorContextMenu(1, 1_000)

    expect(takeEditorContextMenuClaim(2, 1_010)).toBe(false)
    expect(takeEditorContextMenuClaim(1, 1_010)).toBe(true)
    // Spent: a later right-click elsewhere gets the native menu again.
    expect(takeEditorContextMenuClaim(1, 1_020)).toBe(false)
  })

  it('lets a claim whose menu never opened lapse instead of hijacking a later menu', () => {
    claimEditorContextMenu(3, 1_000)

    expect(takeEditorContextMenuClaim(3, 5_000)).toBe(false)
  })
})
