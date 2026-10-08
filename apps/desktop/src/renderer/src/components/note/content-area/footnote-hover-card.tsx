import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { createFootnotePlugin, type FootnoteHover } from './footnote-decorations'
import { registerEditorPlugin } from './register-editor-plugin'

/** Footnote markers in the editor, and the definition card a hovered marker shows (BBF-24). */
export function FootnoteHoverCard({ editor }: { editor: unknown }) {
  const [hover, setHover] = useState<FootnoteHover | null>(null)

  useEffect(() => registerEditorPlugin(editor, createFootnotePlugin(setHover)), [editor])

  if (!hover) return null
  return createPortal(
    <div
      role="tooltip"
      data-footnote-card=""
      className="pointer-events-none fixed z-50 flex max-w-[320px] gap-2 rounded-[8px] border border-border/40 bg-popover px-3 py-2 text-xs/[18px] shadow-[var(--shadow-dropdown)] animate-in fade-in-0 duration-150"
      style={{
        top: hover.anchor.bottom + 6,
        left: hover.anchor.left,
        color: 'var(--text-primary)'
      }}
    >
      <span className="shrink-0 font-semibold" style={{ color: 'var(--text-tertiary)' }}>
        {hover.number}
      </span>
      <span className="whitespace-pre-wrap break-words">{hover.text}</span>
    </div>,
    document.body
  )
}
