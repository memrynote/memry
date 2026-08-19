import { createReactBlockSpec } from '@blocknote/react'
import { calloutConfig, CALLOUT_LINE_REGEX } from '@memry/editor-schema/blocks'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { Info, AlertTriangle, XCircle, CheckCircle } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

const CALLOUT_TYPES = [
  {
    value: 'info' as const,
    label: 'Info',
    icon: Info,
    color: 'text-blue-500',
    bg: 'bg-blue-500/10',
    darkBg: 'dark:bg-blue-500/20',
    border: 'border-s-blue-500'
  },
  {
    value: 'warning' as const,
    label: 'Warning',
    icon: AlertTriangle,
    color: 'text-amber-500',
    bg: 'bg-amber-500/10',
    darkBg: 'dark:bg-amber-500/20',
    border: 'border-s-amber-500'
  },
  {
    value: 'error' as const,
    label: 'Error',
    icon: XCircle,
    color: 'text-red-500',
    bg: 'bg-red-500/10',
    darkBg: 'dark:bg-red-500/20',
    border: 'border-s-red-500'
  },
  {
    value: 'success' as const,
    label: 'Success',
    icon: CheckCircle,
    color: 'text-green-500',
    bg: 'bg-green-500/10',
    darkBg: 'dark:bg-green-500/20',
    border: 'border-s-green-500'
  }
] as const

type CalloutTypeValue = (typeof CALLOUT_TYPES)[number]['value']

interface CalloutBlock {
  props: {
    type: string
  }
}

interface CalloutEditor {
  getTextCursorPosition: () => { block: CalloutBlock }
  updateBlock: (
    block: CalloutBlock,
    update: { type: 'callout'; props: { type: CalloutTypeValue } }
  ) => void
}

interface CalloutBlockRendererProps {
  block: CalloutBlock
  editor: unknown
  contentRef: React.Ref<HTMLDivElement>
}

function getCalloutConfig(type: string) {
  return CALLOUT_TYPES.find((t) => t.value === type) ?? CALLOUT_TYPES[0]
}

function CalloutBlockRenderer({ block, editor, contentRef }: CalloutBlockRendererProps) {
  const { t } = useT('notes')
  const calloutEditor = editor as CalloutEditor
  const calloutType = getCalloutConfig(block.props.type)
  const Icon = calloutType.icon
  const labels: Record<CalloutTypeValue, string> = {
    info: t('editor.callout.info'),
    warning: t('editor.callout.warning'),
    error: t('editor.callout.error'),
    success: t('editor.callout.success')
  }

  return (
    <div
      className={cn(
        'flex items-center rounded-md border-s-4 px-3 py-2',
        calloutType.bg,
        calloutType.darkBg,
        calloutType.border
      )}
      data-callout-type={block.props.type}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'me-3 flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded',
              calloutType.color
            )}
            contentEditable={false}
            aria-label={t('editor.callout.changeType')}
          >
            <Icon className="h-[18px] w-[18px]" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={8}>
          <DropdownMenuLabel>{t('editor.callout.menuLabel')}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {CALLOUT_TYPES.map((type) => {
            const ItemIcon = type.icon
            return (
              <DropdownMenuItem
                key={type.value}
                onClick={() =>
                  calloutEditor.updateBlock(block, {
                    type: 'callout',
                    props: { type: type.value }
                  })
                }
              >
                <ItemIcon className={cn('h-4 w-4', type.color)} />
                {labels[type.value]}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="inline-content min-w-0 flex-1" ref={contentRef} />
    </div>
  )
}

// Type/props/content come from the shared config so this block and the main
// process's headless twin cannot disagree; only the React presentation is here.
export const createCalloutBlock = createReactBlockSpec(calloutConfig, {
  render: (props) => (
    <CalloutBlockRenderer
      block={props.block as CalloutBlock}
      editor={props.editor}
      contentRef={props.contentRef}
    />
  )
})

export function getCalloutSlashMenuItem(
  editor: unknown,
  labels: { title: string; group: string; subtext: string }
) {
  return {
    title: labels.title,
    onItemClick: () => {
      const calloutEditor = editor as CalloutEditor
      const currentBlock = calloutEditor.getTextCursorPosition().block
      calloutEditor.updateBlock(currentBlock, {
        type: 'callout',
        props: { type: 'info' }
      })
    },
    aliases: ['callout', 'admonition', 'alert', 'notice', 'tip'],
    group: labels.group,
    subtext: labels.subtext
  }
}

// ============================================================================
// Callout Block Serialization (> [!type]\n> content)
// ============================================================================

// The `> [!type]` form lives in @memry/editor-schema/blocks so the main process
// writes the same bytes. The splitter below stays here: it is the editor's
// lenient reader (an unknown type falls back to `info`, a title on the marker
// line moves into the body), which is fine for a paste but would rewrite every
// `> [!note]` in an Obsidian vault if the CRDT parser used it.
export { serializeCalloutBlock } from '@memry/editor-schema/blocks'

export type CalloutSegment = { kind: 'callout'; type: CalloutTypeValue; content: string }
export type MarkdownSegment = { kind: 'markdown'; text: string }
export type ContentSegment = CalloutSegment | MarkdownSegment

export function splitMarkdownByCallouts(markdown: string): ContentSegment[] {
  const validTypes: readonly string[] = CALLOUT_TYPES.map((t) => t.value)
  const lines = markdown.split('\n')
  const segments: ContentSegment[] = []

  let mdLines: string[] = []
  let i = 0

  const flushMarkdown = (): void => {
    const text = mdLines.join('\n').trim()
    if (text) segments.push({ kind: 'markdown', text })
    mdLines = []
  }

  while (i < lines.length) {
    const match = lines[i].match(CALLOUT_LINE_REGEX)
    if (match) {
      flushMarkdown()

      const rawType = match[1]
      const type = validTypes.includes(rawType) ? (rawType as CalloutTypeValue) : 'info'
      const contentLines: string[] = []

      const titleText = match[2].trim()
      if (titleText) contentLines.push(titleText)

      i++
      while (i < lines.length && (lines[i].startsWith('> ') || lines[i] === '>')) {
        if (lines[i] === '>') {
          contentLines.push('')
        } else {
          contentLines.push(lines[i].slice(2))
        }
        i++
      }

      segments.push({ kind: 'callout', type, content: contentLines.join('\n').trim() })
    } else {
      mdLines.push(lines[i])
      i++
    }
  }

  flushMarkdown()
  return segments
}
