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

// =============================================================================
// CONTENT AREA PROPS
// =============================================================================

/**
 * Props for the ContentArea component (BlockNote-based)
 */
export interface ContentAreaProps {
  /** Initial content as BlockNote blocks or HTML string */
  initialContent?: Block[] | string
  /** Placeholder text when editor is empty */
  placeholder?: string
  /** Whether the editor is read-only */
  editable?: boolean
  /** Whether to auto-focus the editor on mount */
  autoFocus?: boolean
  /** Callback when content changes (returns blocks) */
  onContentChange?: (blocks: Block[]) => void
  /** Callback when headings change (for outline) */
  onHeadingsChange?: (headings: HeadingInfo[]) => void
  /** Callback when selection changes */
  onSelectionChange?: (selection: SelectionInfo) => void
  /** Callback when external link is clicked */
  onLinkClick?: (href: string) => void
  /** Callback when internal [[wiki-link]] is clicked */
  onInternalLinkClick?: (noteId: string) => void
  /** Additional CSS classes */
  className?: string
}

// =============================================================================
// BLOCK TYPES (Re-export from BlockNote for convenience)
// =============================================================================

export type { Block } from '@blocknote/core'
