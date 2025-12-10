/**
 * Editor Styles
 * Tailwind CSS classes for TipTap editor typography
 * Based on design spec in note/05.content-area.md
 */

import { cn } from '@/lib/utils'

/**
 * Main editor prose classes matching design specification
 *
 * Typography hierarchy:
 * - Body: 16px, line-height 1.7, color #1c1917
 * - H1: 24px, font-weight 600, margin-top 32px, margin-bottom 16px
 * - H2: 20px, font-weight 600, margin-top 24px, margin-bottom 12px
 * - H3: 17px, font-weight 600, margin-top 20px, margin-bottom 8px
 */
export const editorClasses = cn(
  // Base typography
  'prose prose-stone max-w-none',
  'text-base leading-[1.7] text-stone-900',

  // Focus state - clean, no outline
  'focus:outline-none',

  // Headings
  'prose-headings:font-semibold prose-headings:text-stone-900',
  'prose-h1:text-2xl prose-h1:leading-tight prose-h1:mt-8 prose-h1:mb-4',
  'prose-h2:text-xl prose-h2:leading-tight prose-h2:mt-6 prose-h2:mb-3',
  'prose-h3:text-[17px] prose-h3:leading-snug prose-h3:mt-5 prose-h3:mb-2',

  // Paragraphs
  'prose-p:mb-4 prose-p:text-stone-900',

  // Blockquote - 3px left border, italic, muted color
  'prose-blockquote:border-l-[3px] prose-blockquote:border-stone-300',
  'prose-blockquote:pl-4 prose-blockquote:italic prose-blockquote:text-stone-600',
  'prose-blockquote:not-italic prose-blockquote:font-normal',
  '[&_blockquote_p]:italic [&_blockquote_p]:text-stone-600',

  // Inline code - rose accent on light background
  'prose-code:bg-stone-100 prose-code:text-rose-600',
  'prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded',
  'prose-code:font-mono prose-code:text-sm',
  'prose-code:before:content-none prose-code:after:content-none',

  // Code blocks - dark theme
  'prose-pre:bg-stone-900 prose-pre:text-stone-100',
  'prose-pre:rounded-lg prose-pre:p-4 prose-pre:my-4',
  'prose-pre:overflow-x-auto',
  '[&_pre_code]:bg-transparent [&_pre_code]:text-stone-100 [&_pre_code]:p-0',

  // Links - blue, underline on hover
  'prose-a:text-blue-600 prose-a:no-underline hover:prose-a:underline',
  'prose-a:cursor-pointer',

  // Lists
  'prose-ul:my-3 prose-ol:my-3',
  'prose-li:my-1 prose-li:text-stone-900',
  '[&_ul]:list-disc [&_ul]:pl-6',
  '[&_ol]:list-decimal [&_ol]:pl-6',

  // Horizontal rule
  'prose-hr:border-stone-200 prose-hr:my-8',

  // Strong and emphasis
  'prose-strong:font-semibold prose-strong:text-stone-900',
  'prose-em:italic',

  // Strikethrough
  '[&_s]:line-through [&_s]:text-stone-500',
  '[&_del]:line-through [&_del]:text-stone-500'
)

/**
 * Placeholder styles for empty editor state
 * Shows "Start writing, or press '/' for commands..."
 */
export const placeholderClasses = cn(
  '[&_.is-editor-empty:first-child::before]:text-stone-400',
  '[&_.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]',
  '[&_.is-editor-empty:first-child::before]:float-left',
  '[&_.is-editor-empty:first-child::before]:h-0',
  '[&_.is-editor-empty:first-child::before]:pointer-events-none'
)

/**
 * Task list specific styles
 */
export const taskListClasses = cn(
  // Task list container
  '[&_ul[data-type="taskList"]]:list-none [&_ul[data-type="taskList"]]:pl-0',

  // Task list items
  '[&_li[data-type="taskItem"]]:flex [&_li[data-type="taskItem"]]:items-start [&_li[data-type="taskItem"]]:gap-2',

  // Checkbox styling
  '[&_li[data-type="taskItem"]_label]:flex [&_li[data-type="taskItem"]_label]:items-center',
  '[&_li[data-type="taskItem"]_input]:w-4 [&_li[data-type="taskItem"]_input]:h-4',
  '[&_li[data-type="taskItem"]_input]:rounded [&_li[data-type="taskItem"]_input]:border-stone-300',

  // Checked state
  '[&_li[data-checked="true"]_div]:line-through [&_li[data-checked="true"]_div]:text-stone-500'
)

/**
 * Table styles
 */
export const tableClasses = cn(
  // Table container
  '[&_table]:border-collapse [&_table]:w-full [&_table]:my-4',

  // Table cells
  '[&_th]:border [&_th]:border-stone-200 [&_th]:bg-stone-50 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold',
  '[&_td]:border [&_td]:border-stone-200 [&_td]:px-3 [&_td]:py-2',

  // Selected cell
  '[&_.selectedCell]:bg-blue-50'
)

/**
 * Callout/admonition styles
 */
export const calloutClasses = cn(
  // Base callout
  '[&_[data-callout]]:rounded-lg [&_[data-callout]]:p-3 [&_[data-callout]]:my-4 [&_[data-callout]]:border',

  // Info variant (blue)
  '[&_[data-callout][data-variant="info"]]:bg-blue-50 [&_[data-callout][data-variant="info"]]:border-blue-200',

  // Warning variant (amber)
  '[&_[data-callout][data-variant="warning"]]:bg-amber-50 [&_[data-callout][data-variant="warning"]]:border-amber-200',

  // Error variant (red)
  '[&_[data-callout][data-variant="error"]]:bg-red-50 [&_[data-callout][data-variant="error"]]:border-red-200',

  // Success variant (green)
  '[&_[data-callout][data-variant="success"]]:bg-green-50 [&_[data-callout][data-variant="success"]]:border-green-200'
)

/**
 * Wiki-link styles (internal links)
 */
export const wikiLinkClasses = cn(
  '[&_.wiki-link]:bg-blue-50 [&_.wiki-link]:text-blue-600',
  '[&_.wiki-link]:px-1.5 [&_.wiki-link]:py-0.5 [&_.wiki-link]:rounded',
  '[&_.wiki-link]:cursor-pointer [&_.wiki-link]:transition-colors',
  '[&_.wiki-link:hover]:bg-blue-100'
)

/**
 * Combined editor styles
 */
export const allEditorClasses = cn(
  editorClasses,
  placeholderClasses,
  taskListClasses,
  tableClasses,
  calloutClasses,
  wikiLinkClasses
)
