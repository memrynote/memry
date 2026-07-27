/**
 * ContentArea Type Definitions
 * TypeScript interfaces for the BlockNote-based rich text editor
 */

import type { Block } from '@blocknote/core'

// =============================================================================
// HEADING TYPES
// =============================================================================

/**
 * Heading information extracted from editor content
 * Used by OutlineEdge component for document navigation
 */
export interface HeadingInfo {
  /** Unique ID for scrolling (block id) */
  id: string
  /** Heading text content */
  text: string
  /** Heading level: 1 (H1), 2 (H2), or 3 (H3) */
  level: 1 | 2 | 3
  /** Vertical position in pixels (for outline visualization) */
  position: number
}

// =============================================================================
// SELECTION TYPES
// =============================================================================

/**
 * Information about the current text selection
 */
export interface SelectionInfo {
  /** Start position of selection */
  from: number
  /** End position of selection */
  to: number
  /** Selected text content */
  text: string
  /** Whether selection is empty (cursor only) */
  isEmpty: boolean
}

export interface ReviewSelection {
  /** Selected text visible in the editor */
  text: string
  /** Whether selection is empty/collapsed */
  isEmpty: boolean
  /** Top position of the selection relative to the shared marquee zone, when available */
  top?: number
  /** ProseMirror start position for the selected text, when available */
  from?: number
  /** ProseMirror end position for the selected text, when available */
  to?: number
}

// =============================================================================
// CONTENT AREA PROPS
// =============================================================================

/**
 * Props for the ContentArea component (BlockNote-based)
 */
/** Highlight info for scrolling to and highlighting text from reminders */
export interface HighlightInfo {
  /** Text to highlight */
  text: string
  /** Character start position (optional, for more precise matching) */
  start?: number
  /** Character end position (optional, for more precise matching) */
  end?: number
}

export interface CollaborationInfo {
  fragment: import('yjs').XmlFragment
  provider: { awareness?: unknown }
}

export interface ContentAreaProps {
  /** Note ID for attachment uploads (T069) */
  noteId?: string
  /**
   * The note's path relative to the vault root (`Folder/Note.md`). Used to
   * resolve relative image/file URLs written by other apps (Obsidian,
   * Capacities) against the note's own folder at render time.
   */
  notePath?: string
  /**
   * When false, this editor does NOT run note-level task auto-conversion side
   * effects (a sibling editor on the same note in this window owns them, R17).
   * Defaults to true; standalone callers own their effects.
   */
  runSideEffects?: boolean
  /** Initial content as BlockNote blocks, HTML string, or markdown string */
  initialContent?: Block[] | string
  /** Type of content being passed: 'html', 'markdown', or 'blocks' */
  contentType?: 'html' | 'markdown' | 'blocks'
  /** Placeholder text when editor is empty */
  placeholder?: string
  /** Whether the editor is read-only */
  editable?: boolean
  /** Whether to auto-focus the editor on mount */
  autoFocus?: boolean
  /** Whether to show sticky formatting toolbar (always visible above editor) */
  stickyToolbar?: boolean
  /** Whether to enable browser spell checking in the editor */
  spellCheck?: boolean
  /** Callback when content changes (returns blocks) */
  onContentChange?: (blocks: Block[]) => void
  /** Callback when content changes (returns markdown string) */
  onMarkdownChange?: (markdown: string) => void
  /** Callback when headings change (for outline) */
  onHeadingsChange?: (headings: HeadingInfo[]) => void
  /** Callback when selection changes */
  onSelectionChange?: (selection: SelectionInfo) => void
  /** Callback when external link is clicked */
  onLinkClick?: (href: string) => void
  /** Callback when internal [[wiki-link]] is clicked (note id or title) */
  onInternalLinkClick?: (noteIdOrTitle: string) => void
  /** Additional CSS classes */
  className?: string
  /** Initial highlight info to scroll to and highlight (from reminder navigation) */
  initialHighlight?: HighlightInfo
  /** Inline date pill anchor id to scroll to (from note_date reminder navigation) */
  initialAnchorId?: string
  /** Note tags for hash tag normalization on markdown load */
  noteTags?: string[]
  /** Map of tag name to color name for hash tag styling */
  tagColorMap?: Map<string, string>
  /** Map of tag name to icon (raw emoji or "icon:Name") for inline hash tag display */
  tagIconMap?: Map<string, string>
  /** Callback when inline #tags change in editor content */
  onInlineTagsChange?: (tags: string[]) => void
  /** Ref that receives a focusAtEnd function to focus the editor at the end of the document */
  focusAtEndRef?: React.RefObject<(() => void) | null>
  /**
   * The outer wrapper element that owns the marquee selection trigger area
   * (and the overlay's coordinate space). When omitted, falls back to the
   * inner `.bn-container` so callers that don't want the extended hit area
   * still get the original behavior.
   */
  marqueeZoneEl?: HTMLDivElement | null
  /** Optional CriticMarkup review behavior for comments */
  review?: {
    plainMarkdown: string
    marks: import('@memry/shared').CriticMarkupMark[]
    hoveredMarkId: string | null
    onEditorReady?: (editor: unknown) => void
    onAddComment?: (selection: ReviewSelection) => void
    getMarkdownSourceOffsetForEditorOffset?: (editorOffset: number) => number | null
    getEditorOffsetForMarkdownSourceOffset?: (sourceOffset: number) => number | null
    onPersistCurrentMarkdown?: () => void
    onPlainMarkdownChange?: (markdown: string) => string
    onHoveredMarkChange?: (id: string | null) => void
    onMarkPositionsChange?: (positions: Record<string, number>) => void
    onReplaceMarksFromYjs?: (marks: import('@memry/shared').CriticMarkupMark[]) => void
  }
}

// =============================================================================
// BLOCK TYPES (Re-export from BlockNote for convenience)
// =============================================================================

export type { Block } from '@blocknote/core'
