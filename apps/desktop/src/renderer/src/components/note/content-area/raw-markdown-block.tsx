import { createReactBlockSpec } from '@blocknote/react'

// Opaque container for Obsidian syntax BlockNote cannot represent
// (docs/obs/06): %%block comments%%, $$math$$, non-Memry callouts, custom
// checkbox states, footnote definitions. `props.markdown` is re-emitted
// verbatim on save; the block renders read-only (double-click-to-edit is a
// later enhancement).
export const createRawMarkdownBlock = createReactBlockSpec(
  {
    type: 'rawMarkdown' as const,
    propSchema: {
      markdown: { default: '' }
    },
    content: 'none'
  },
  {
    render: (props) => (
      <pre
        className="my-1 overflow-x-auto rounded-md bg-muted/50 px-3 py-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground"
        contentEditable={false}
      >
        {props.block.props.markdown}
      </pre>
    )
  }
)
