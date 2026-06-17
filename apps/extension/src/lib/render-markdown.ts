import DOMPurify from 'dompurify'
import { marked } from 'marked'

// Renders capture-body markdown to sanitized HTML. The body is arbitrary
// web-page content, so DOMPurify sanitization is a security boundary, not optional.
export function renderMarkdown(markdown: string): string {
  return DOMPurify.sanitize(marked.parse(markdown, { async: false }) as string)
}
