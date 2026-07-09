/**
 * TaskDescriptionPreview
 * Read-only, formatted render of a task's markdown description for preview
 * surfaces (e.g. the calendar task popover). Safe by construction: it walks
 * marked's token stream and builds React elements — no HTML injection.
 * Supports inline bold/italic/code/strikethrough and clickable links; block
 * markers (headings, list bullets, quotes) are flattened to clean text lines.
 */

import type { ReactNode } from 'react'
import { marked, type Token, type Tokens } from 'marked'

import { cn } from '@/lib/utils'
import { createLogger } from '@/lib/logger'

const log = createLogger('Component:TaskDescriptionPreview')

function openLink(e: React.MouseEvent, href: string): void {
  e.preventDefault()
  e.stopPropagation()
  window.open(href, '_blank', 'noopener,noreferrer')
}

function renderInline(tokens: Token[] | undefined, keyPrefix: string): ReactNode[] {
  if (!tokens) return []
  return tokens.map((token, i) => {
    const key = `${keyPrefix}-${i}`
    switch (token.type) {
      case 'strong':
        return <strong key={key}>{renderInline((token as Tokens.Strong).tokens, key)}</strong>
      case 'em':
        return <em key={key}>{renderInline((token as Tokens.Em).tokens, key)}</em>
      case 'del':
        return <del key={key}>{renderInline((token as Tokens.Del).tokens, key)}</del>
      case 'codespan':
        return (
          <code key={key} className="rounded bg-muted px-1 py-0.5 text-[0.9em]">
            {(token as Tokens.Codespan).text}
          </code>
        )
      case 'br':
        return <br key={key} />
      case 'link': {
        const link = token as Tokens.Link
        return (
          <a
            key={key}
            href={link.href}
            onClick={(e) => openLink(e, link.href)}
            className="text-primary underline underline-offset-2 hover:opacity-80"
          >
            {renderInline(link.tokens, key)}
          </a>
        )
      }
      case 'text': {
        const t = token as Tokens.Text
        return t.tokens && t.tokens.length > 0 ? (
          <span key={key}>{renderInline(t.tokens, key)}</span>
        ) : (
          t.text
        )
      }
      case 'escape':
        return (token as Tokens.Escape).text
      default:
        return 'raw' in token ? token.raw : ''
    }
  })
}

function renderBlocks(tokens: Token[], keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = []
  tokens.forEach((token, i) => {
    const key = `${keyPrefix}-${i}`
    switch (token.type) {
      case 'heading':
      case 'paragraph':
        out.push(<span key={key}>{renderInline((token as Tokens.Paragraph).tokens, key)}</span>)
        break
      case 'text': {
        const t = token as Tokens.Text
        out.push(
          <span key={key}>
            {t.tokens && t.tokens.length > 0 ? renderInline(t.tokens, key) : t.text}
          </span>
        )
        break
      }
      case 'blockquote':
        out.push(...renderBlocks((token as Tokens.Blockquote).tokens, key))
        break
      case 'list':
        ;(token as Tokens.List).items.forEach((item, j) => {
          const itemKey = `${key}-${j}`
          out.push(
            <span key={itemKey}>
              {'• '}
              {renderInline(item.tokens, itemKey)}
            </span>
          )
        })
        break
      case 'code':
        out.push(
          <code key={key} className="rounded bg-muted px-1 py-0.5 text-[0.9em]">
            {(token as Tokens.Code).text}
          </code>
        )
        break
      case 'space':
      case 'hr':
        break
      default:
        if ('raw' in token && token.raw.trim()) {
          out.push(<span key={key}>{token.raw}</span>)
        }
    }
  })
  return out
}

/** Render a markdown string as safe, formatted, inline-flow React nodes. */
export function renderTaskDescriptionMarkdown(markdown: string): ReactNode[] {
  try {
    const tokens = marked.lexer(markdown)
    const nodes = renderBlocks(tokens, 'md')
    // Interleave a space between blocks so flattened lines don't run together.
    return nodes.flatMap((node, i) => (i === 0 ? [node] : [' ', node]))
  } catch (error) {
    log.error('Failed to render task description markdown', error)
    return [markdown]
  }
}

interface TaskDescriptionPreviewProps {
  markdown: string
  className?: string
  'data-testid'?: string
}

export function TaskDescriptionPreview({
  markdown,
  className,
  'data-testid': testId
}: TaskDescriptionPreviewProps): React.JSX.Element {
  return (
    <p data-testid={testId} className={cn('text-muted-foreground', className)}>
      {renderTaskDescriptionMarkdown(markdown)}
    </p>
  )
}

export default TaskDescriptionPreview
