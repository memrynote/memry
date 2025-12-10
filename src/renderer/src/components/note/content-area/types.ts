/**
 * ContentArea Type Definitions
 * TypeScript interfaces for the rich text editor component
 */

import type { Editor } from '@tiptap/react'
import type { LucideIcon } from 'lucide-react'

// =============================================================================
// HEADING TYPES
// =============================================================================

/**
 * Heading information extracted from editor content
 * Used by OutlineEdge component for document navigation
 */
export interface HeadingInfo {
  /** Unique ID for scrolling (e.g., 'heading-0', 'heading-1') */
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
 * Props for the ContentArea component
 */
export interface ContentAreaProps {
  /** Content as HTML string */
  content: string
  /** Placeholder text when editor is empty */
  placeholder?: string
  /** Whether the editor is read-only */
  readOnly?: boolean
  /** Whether to auto-focus the editor on mount */
  autoFocus?: boolean
  /** Callback when content changes */
  onContentChange: (content: string) => void
  /** Callback when headings change (for outline) */
  onHeadingsChange: (headings: HeadingInfo[]) => void
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
// SLASH COMMAND TYPES
// =============================================================================

/** Groups for organizing slash command items */
export type SlashCommandGroup = 'basic' | 'lists' | 'media' | 'advanced'

/**
 * Configuration for a single slash command item
 */
export interface SlashCommandItem {
  /** Unique identifier */
  id: string
  /** Display title */
  title: string
  /** Short description */
  description: string
  /** Lucide icon component */
  icon: LucideIcon
  /** Command to execute when selected */
  command: (editor: Editor) => void
  /** Group this item belongs to */
  group: SlashCommandGroup
  /** Search aliases for filtering */
  aliases?: string[]
}

/**
 * A group of slash command items with label
 */
export interface SlashCommandGroupConfig {
  /** Group identifier */
  id: SlashCommandGroup
  /** Display label for the group */
  label: string
  /** Items in this group */
  items: SlashCommandItem[]
}

// =============================================================================
// CALLOUT TYPES
// =============================================================================

/** Callout/admonition variants */
export type CalloutVariant = 'info' | 'warning' | 'error' | 'success'

/**
 * Callout node attributes
 */
export interface CalloutAttributes {
  variant: CalloutVariant
}
