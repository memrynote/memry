import type { ReactNode } from 'react'
import { parseInline, type InlineNode } from './fold-inline'

function renderNodes(nodes: readonly InlineNode[]): ReactNode[] {
  // oxlint-disable-next-line typescript/consistent-return -- exhaustive switch over a closed union with no default, so the compiler flags new variants
  return nodes.map((node, index) => {
    switch (node.type) {
      case 'text':
        return node.text
      case 'code':
        return (
          // oxlint-disable-next-line react/no-array-index-key -- static positional list; items have no id and never reorder
          <code key={index} className="rounded-sm bg-surface px-1 font-mono text-[0.9em]">
            {node.text}
          </code>
        )
      case 'strong':
        return (
          // oxlint-disable-next-line react/no-array-index-key -- static positional list; items have no id and never reorder
          <strong key={index} className="font-semibold">
            {renderNodes(node.children)}
          </strong>
        )
      case 'em':
        // oxlint-disable-next-line react/no-array-index-key -- static positional list; items have no id and never reorder
        return <em key={index}>{renderNodes(node.children)}</em>
      case 'del':
        // oxlint-disable-next-line react/no-array-index-key -- static positional list; items have no id and never reorder
        return <del key={index}>{renderNodes(node.children)}</del>
      // A folded line is one button that opens its paragraph, so a link or a
      // wiki-link is styled text: it cannot hold an anchor and must not navigate.
      case 'link':
        return (
          // oxlint-disable-next-line react/no-array-index-key -- static positional list; items have no id and never reorder
          <span key={index} className="underline decoration-text-tertiary underline-offset-2">
            {renderNodes(node.children)}
          </span>
        )
      case 'wiki':
        return (
          <span
            // oxlint-disable-next-line react/no-array-index-key -- static positional list; items have no id and never reorder
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
