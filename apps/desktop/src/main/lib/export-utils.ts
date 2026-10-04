/**
 * Export Utilities
 *
 * Provides utilities for exporting notes to PDF and HTML formats.
 *
 * @module lib/export-utils
 */

import { marked } from 'marked'
import { stripTaskBlockSuffixes } from '@memry/shared/task-block'
import { replaceWikiLinks } from '@memry/shared/wiki-target'
import type { CustomIconRow } from '@memry/db-schema/schema/custom-icons'
import { sanitizeSvgBytes } from '../icons/sanitize-svg'

// ============================================================================
// Types
// ============================================================================

export interface NoteExportData {
  id: string
  title: string
  content: string
  /** The stored note icon: a bare emoji, `icon:<Name>` or `custom:<id>`. */
  emoji?: string | null
  tags: string[]
  created: Date
  modified: Date
}

export interface RenderOptions {
  /** Include metadata section (emoji, tags, dates) */
  includeMetadata?: boolean
  /** Page size for PDF export */
  pageSize?: 'A4' | 'Letter' | 'Legal'
  /**
   * Looks up an uploaded icon by id, for a note whose icon is `custom:<id>`.
   * Without it, or when the icon is gone, the header shows no icon.
   */
  findCustomIcon?: (id: string) => ExportCustomIcon | undefined
  /** Keep each task's `{task:<id>}` suffix. Off by default: a reader has no use for it. */
  includeTaskMarkers?: boolean
}

/** The parts of a stored custom icon an export needs. */
export type ExportCustomIcon = Pick<CustomIconRow, 'ext' | 'data'>

// ============================================================================
// Markdown to HTML Conversion
// ============================================================================

/**
 * Configure marked for safe rendering
 */
marked.setOptions({
  gfm: true, // GitHub Flavored Markdown
  breaks: true // Convert \n to <br>
})

/**
 * Convert markdown content to HTML.
 * Handles wiki-links by converting them to plain text spans.
 */
export function markdownToHtml(markdown: string): string {
  // Pre-process: wiki-links become plain spans labelled the way a chip would be
  const processedMarkdown = replaceWikiLinks(
    markdown,
    (label) => `<span class="wiki-link">${label}</span>`
  )
    // Strip file block comments <!-- file:{...} -->
    .replace(/<!--\s*file:\{[^}]+\}\s*-->/g, '')

  return marked.parse(processedMarkdown) as string
}

/**
 * Escape HTML special characters
 */
export function escapeHtml(text: string): string {
  const htmlEscapes: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }
  return text.replace(/[&<>"']/g, (char) => htmlEscapes[char] || char)
}

// The note `emoji` column holds a bare emoji, a library icon (`icon:<Name>`) or
// an uploaded image (`custom:<id>`). Restated from the renderer's
// `emoji-icon-utils.ts`, which is not importable here.
const LIBRARY_ICON_PREFIX = 'icon:'
const CUSTOM_ICON_PREFIX = 'custom:'

function customIconDataUri({ ext, data }: ExportCustomIcon): string | null {
  if (ext === 'png') return `data:image/png;base64,${data}`
  if (ext === 'svg') {
    // The row is synced input and can predate the sanitizer, and the export is
    // a file the user hands on, so it gets the same inert bytes as the disk copy.
    const svg = sanitizeSvgBytes(Buffer.from(data, 'base64'))
    return svg ? `data:image/svg+xml;base64,${svg.toString('base64')}` : null
  }
  return null
}

/**
 * The header markup for a note's stored icon.
 *
 * An uploaded image travels inside the document as a `data:` URI, the way
 * `inlineExportImages` carries the body's images. A library icon is left out:
 * its glyphs ship in the renderer bundle, not here, and its reference is not
 * text to print. So is a custom icon whose row is gone.
 */
function renderNoteIcon(
  value: string | null | undefined,
  findCustomIcon: RenderOptions['findCustomIcon']
): string {
  if (!value || value.startsWith(LIBRARY_ICON_PREFIX)) return ''
  if (value.startsWith(CUSTOM_ICON_PREFIX)) {
    const icon = findCustomIcon?.(value.slice(CUSTOM_ICON_PREFIX.length))
    const src = icon ? customIconDataUri(icon) : null
    return src ? `<img class="note-emoji" src="${escapeHtml(src)}" alt="">` : ''
  }
  return `<span class="note-emoji">${escapeHtml(value)}</span>`
}

/**
 * Format date for display
 */
function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
}

// ============================================================================
// Embedded Styles
// ============================================================================

/**
 * Get embedded CSS styles for exported HTML/PDF.
 * Uses a clean, print-friendly light theme.
 */
export function getEmbeddedStyles(): string {
  return `
    /* Reset and Base */
    *, *::before, *::after {
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 16px;
      line-height: 1.6;
      color: #1a1a1a;
      background: #ffffff;
      margin: 0;
      padding: 40px;
      max-width: 800px;
      margin: 0 auto;
    }

    /* Note Header */
    .note-header {
      margin-bottom: 32px;
      padding-bottom: 24px;
      border-bottom: 1px solid #e5e5e5;
    }

    .note-emoji {
      font-size: 48px;
      line-height: 1;
      margin-bottom: 16px;
      display: block;
    }

    img.note-emoji {
      width: 48px;
      height: 48px;
      object-fit: contain;
      margin: 0 0 16px 0;
      border-radius: 0;
    }

    .note-title {
      font-size: 32px;
      font-weight: 700;
      margin: 0 0 16px 0;
      color: #0a0a0a;
      line-height: 1.2;
    }

    .note-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      font-size: 14px;
      color: #666;
    }

    .note-meta-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .note-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }

    .tag {
      display: inline-block;
      padding: 4px 10px;
      background: #f0f0f0;
      border-radius: 4px;
      font-size: 13px;
      color: #555;
    }

    /* Content */
    .note-content {
      line-height: 1.7;
    }

    /* Headings */
    h1, h2, h3, h4, h5, h6 {
      margin-top: 32px;
      margin-bottom: 16px;
      font-weight: 600;
      line-height: 1.3;
      color: #0a0a0a;
    }

    h1 { font-size: 28px; }
    h2 { font-size: 24px; border-bottom: 1px solid #eee; padding-bottom: 8px; }
    h3 { font-size: 20px; }
    h4 { font-size: 18px; }
    h5 { font-size: 16px; }
    h6 { font-size: 14px; color: #666; }

    /* Paragraphs */
    p {
      margin: 0 0 16px 0;
    }

    /* Links */
    a {
      color: #0066cc;
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
    }

    /* Wiki links (internal links shown as plain text) */
    .wiki-link {
      color: #0066cc;
      background: #f0f7ff;
      padding: 1px 4px;
      border-radius: 3px;
    }

    /* Lists */
    ul, ol {
      margin: 0 0 16px 0;
      padding-left: 24px;
    }

    li {
      margin-bottom: 4px;
    }

    li > ul, li > ol {
      margin-top: 4px;
      margin-bottom: 4px;
    }

    /* Checkbox lists (task lists) */
    ul.contains-task-list {
      list-style: none;
      padding-left: 0;
    }

    li.task-list-item {
      display: flex;
      align-items: flex-start;
      gap: 8px;
    }

    li.task-list-item input[type="checkbox"] {
      margin-top: 5px;
    }

    /* Code */
    code {
      font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
      font-size: 14px;
      background: #f5f5f5;
      padding: 2px 6px;
      border-radius: 4px;
    }

    pre {
      background: #f5f5f5;
      padding: 16px;
      border-radius: 8px;
      overflow-x: auto;
      margin: 0 0 16px 0;
    }

    pre code {
      background: none;
      padding: 0;
      font-size: 14px;
      line-height: 1.5;
    }

    /* Blockquotes */
    blockquote {
      margin: 0 0 16px 0;
      padding: 12px 20px;
      border-left: 4px solid #ddd;
      background: #fafafa;
      color: #555;
    }

    blockquote p:last-child {
      margin-bottom: 0;
    }

    /* Tables */
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 0 0 16px 0;
      font-size: 15px;
    }

    th, td {
      border: 1px solid #ddd;
      padding: 10px 12px;
      text-align: left;
    }

    th {
      background: #f5f5f5;
      font-weight: 600;
    }

    tr:nth-child(even) {
      background: #fafafa;
    }

    /* Horizontal rule */
    hr {
      border: none;
      border-top: 1px solid #e5e5e5;
      margin: 32px 0;
    }

    /* Images */
    img {
      max-width: 100%;
      height: auto;
      border-radius: 8px;
      margin: 16px 0;
    }

    /* Print styles */
    @media print {
      body {
        padding: 0;
        font-size: 12pt;
      }

      .note-header {
        page-break-after: avoid;
      }

      h1, h2, h3, h4, h5, h6 {
        page-break-after: avoid;
      }

      pre, blockquote, table {
        page-break-inside: avoid;
      }

      a {
        color: #000;
        text-decoration: underline;
      }

      .wiki-link {
        background: none;
        color: #000;
      }
    }
  `
}

// ============================================================================
// HTML Document Rendering
// ============================================================================

/**
 * Render a note as a complete HTML document.
 * Used for both HTML export and PDF generation (via print-to-PDF).
 */
export function renderNoteAsHtml(note: NoteExportData, options: RenderOptions = {}): string {
  const { includeMetadata = true, includeTaskMarkers = false } = options

  const contentHtml = markdownToHtml(
    includeTaskMarkers ? note.content : stripTaskBlockSuffixes(note.content)
  )

  const metadataSection = includeMetadata
    ? `
      <div class="note-meta">
        <span class="note-meta-item">
          <strong>Created:</strong> ${formatDate(note.created)}
        </span>
        <span class="note-meta-item">
          <strong>Modified:</strong> ${formatDate(note.modified)}
        </span>
      </div>
      ${
        note.tags.length > 0
          ? `
        <div class="note-tags">
          ${note.tags.map((tag) => `<span class="tag">#${escapeHtml(tag)}</span>`).join('')}
        </div>
      `
          : ''
      }
    `
    : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="generator" content="memrynote">
  <title>${escapeHtml(note.title)}</title>
  <style>${getEmbeddedStyles()}</style>
</head>
<body>
  <article>
    <header class="note-header">
      ${renderNoteIcon(note.emoji, options.findCustomIcon)}
      <h1 class="note-title">${escapeHtml(note.title)}</h1>
      ${metadataSection}
    </header>
    <main class="note-content">
      ${contentHtml}
    </main>
  </article>
</body>
</html>`
}

/**
 * Sanitize a filename for safe filesystem usage.
 */
export function sanitizeFilename(filename: string): string {
  // Remove or replace characters that are invalid in filenames.
  // Only the platform-forbidden set: these outputs (PDF/HTML export defaults,
  // Evernote import folder names) are never Obsidian wikilink targets, so the
  // `[ ] # ^` widening does not belong here (it caused `..` traversal, notebook
  // collapse, and hidden-dotfile export names).
  return filename
    .replace(/[<>:"/\\|?*]/g, '') // Remove invalid chars
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim()
    .slice(0, 200) // Limit length
}
