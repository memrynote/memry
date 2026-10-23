import type { ReactNode } from 'react'
import { parseInline, type InlineNode } from './fold-inline'

function renderNodes(nodes: readonly InlineNode[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case 'text':
        return node.text
      case 'code':
        return (
          <code key={index} className="rounded-sm bg-surface px-1 font-mono text-[0.9em]">
            {node.text}
          </code>
        )
      case 'strong':
        return (
          <strong key={index} className="font-semibold">
            {renderNodes(node.children)}
          </strong>
        )
      case 'em':
        return <em key={index}>{renderNodes(node.children)}</em>
      case 'del':
        return <del key={index}>{renderNodes(node.children)}</del>
      // A folded line is one button that opens its paragraph, so a link or a
      // wiki-link is styled text: it cannot hold an anchor and must not navigate.
      case 'link':
        return (
          <span key={index} className="underline decoration-text-tertiary underline-offset-2">
            {renderNodes(node.children)}
          </span>
        )
      case 'wiki':
        return (
          <span
            key={index}
            className="underline decoration-dotted decoration-text-tertiary underline-offset-2"
          >
            {node.label}
          </span>
        )
    }
  })
}

/** One line of inline Markdown as React elements: no raw HTML, no navigation. */
export function InlineMarkdown({ markdown }: { markdown: string }) {
  return <>{renderNodes(parseInline(markdown))}</>
}
