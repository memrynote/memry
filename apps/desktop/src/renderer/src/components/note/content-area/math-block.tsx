import 'katex/dist/katex.min.css'

import { useState } from 'react'
import katex from 'katex'
import { createReactBlockSpec } from '@blocknote/react'
import { mathBlockConfig } from '@memry/editor-schema/blocks'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { Sigma } from '@/lib/icons'
import { extractErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

/**
 * KaTeX is imported, not lazily loaded, because it is already in this bundle:
 * `@streamdown/math` (AI chat markdown) and `mermaid` both depend on the same
 * `katex@0.16` copy, and `apps/desktop` now declares it directly so the block
 * and those two resolve to one module rather than two. What this block adds to
 * the renderer is the stylesheet and its fonts, which the other two never
 * import — the JS was already paid for. The mobile WebView pays neither: its
 * touch spec renders the source (#2032 is why that bundle counts bytes).
 */
interface MathBlockNode {
  props: { latex: string }
}

interface MathBlockEditor {
  getTextCursorPosition: () => { block: MathBlockNode }
  updateBlock: (
    block: MathBlockNode,
    update: { type: 'mathBlock'; props: { latex: string } }
  ) => void
}

/**
 * One formula as KaTeX markup, or the message it refused to render with.
 *
 * `throwOnError` is on so the failure is OURS to present: KaTeX's own fallback
 * prints the source in red inside the flow, which reads as a rendered formula
 * that is merely coloured. `trust` is left at its default `false`, so `\href`,
 * `\url` and `\includegraphics` are refused and the returned markup carries no
 * URL the user did not see — that is what makes it safe to insert as HTML.
 */
function renderFormula(latex: string): { markup: string } | { error: string } {
  try {
    return { markup: katex.renderToString(latex, { displayMode: true, throwOnError: true }) }
  } catch (err) {
    return { error: extractErrorMessage(err, latex) }
  }
}

export function MathBlockRenderer({ block, editor }: { block: MathBlockNode; editor: unknown }) {
  const { t } = useT('notes')
  const mathEditor = editor as MathBlockEditor
  const latex = block.props.latex
  // The popup's working copy. The block is updated when the popup closes
  // rather than on every keystroke: a prop write re-renders this node view,
  // and a node view that re-renders under an open popover takes the caret out
  // of the textarea with it.
  const [draft, setDraft] = useState(latex)
  const [isEditing, setIsEditing] = useState(false)

  const preview = renderFormula(isEditing ? draft : latex)
  const source = isEditing ? draft : latex

  const openEditor = (open: boolean): void => {
    if (open) {
      setDraft(latex)
      setIsEditing(true)
      return
    }
    setIsEditing(false)
    if (draft !== latex) {
      mathEditor.updateBlock(block, { type: 'mathBlock', props: { latex: draft } })
    }
  }

  return (
    <div className="math-block my-2" contentEditable={false}>
      <Popover open={isEditing} onOpenChange={openEditor}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex w-full cursor-pointer items-center justify-center rounded-md px-3 py-3 text-center',
              'transition-colors duration-(--duration-instant) hover:bg-surface-active',
              !source && 'justify-start gap-2 text-sm text-muted-foreground'
            )}
            aria-label={t('editor.math.edit')}
            data-math-empty={source ? undefined : 'true'}
          >
            {!source ? (
              <>
                <Sigma className="size-4" />
                {t('editor.math.empty')}
              </>
            ) : 'markup' in preview ? (
              // KaTeX escapes every character of the source it echoes and
              // refuses link commands under the default `trust: false`, so the
              // markup below holds no author-supplied URL or attribute.
              <span dangerouslySetInnerHTML={{ __html: preview.markup }} />
            ) : (
              <span className="text-start font-mono text-xs text-destructive">{preview.error}</span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent align="center" className="w-[360px] p-2">
          <Textarea
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter breaks the line, as it does in any multi-line source.
              // Mod+Enter is the commit, which is also what Escape does
              // through Radix's own dismiss.
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                openEditor(false)
              }
            }}
            spellCheck={false}
            rows={3}
            className="min-h-[72px] resize-y font-mono text-xs"
            placeholder={t('editor.math.placeholder')}
            aria-label={t('editor.math.sourceLabel')}
          />
          <p className="mt-2 px-1 text-[11px] text-muted-foreground">{t('editor.math.hint')}</p>
        </PopoverContent>
      </Popover>
    </div>
  )
}

// Type/props/content and the `$$…$$` on-disk form come from the shared package
// so the main process registers the same node and writes the same bytes. No
// `contentRef`: BlockNote 0.54 hands none to a block declared `content: "none"`.
export const createMathBlock = createReactBlockSpec(mathBlockConfig, {
  render: (props) => (
    <MathBlockRenderer block={props.block as MathBlockNode} editor={props.editor} />
  )
})

export function getMathSlashMenuItem(
  editor: unknown,
  labels: { title: string; group: string; subtext: string }
) {
  return {
    title: labels.title,
    onItemClick: () => {
      const mathEditor = editor as MathBlockEditor
      const currentBlock = mathEditor.getTextCursorPosition().block
      mathEditor.updateBlock(currentBlock, { type: 'mathBlock', props: { latex: '' } })
    },
    aliases: ['math', 'equation', 'formula', 'latex', 'katex', 'tex'],
    group: labels.group,
    subtext: labels.subtext
  }
}
