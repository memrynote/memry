import { createReactBlockSpec } from '@blocknote/react'
import {
  CALLOUT_TYPE_VALUES,
  calloutConfig,
  readCalloutRun,
  readStructuredQuoteRun,
  type CalloutRun,
  type CalloutTypeDefinition,
  type CalloutTypeValue,
  type QuoteRun
} from '@memry/editor-schema/blocks'
import { createFenceTracker } from '@memry/shared/markdown-fences'
import { parseSidecarMarkerLine } from '@memry/shared/block-markers'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import {
  Info,
  AlertTriangle,
  XCircle,
  CheckCircle,
  Pencil,
  FileText,
  ListChecks,
  Lightbulb,
  Flag,
  HelpCircle,
  List,
  Quote,
  Bug,
  ChevronRight,
  type AppIcon
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'
import { calloutIcon } from './callout-icons'
import { getCalloutTypes, useCalloutTypes } from './callout-types-store'

interface CalloutStyle {
  icon: AppIcon
  color: string
  bg: string
  darkBg: string
  border: string
}

const CALLOUT_STYLES: Record<CalloutTypeValue, CalloutStyle> = {
  info: {
    icon: Info,
    color: 'text-blue-500',
    bg: 'bg-blue-500/10',
    darkBg: 'dark:bg-blue-500/20',
    border: 'border-s-blue-500'
  },
  warning: {
    icon: AlertTriangle,
    color: 'text-amber-500',
    bg: 'bg-amber-500/10',
    darkBg: 'dark:bg-amber-500/20',
    border: 'border-s-amber-500'
  },
  error: {
    icon: XCircle,
    color: 'text-red-500',
    bg: 'bg-red-500/10',
    darkBg: 'dark:bg-red-500/20',
    border: 'border-s-red-500'
  },
  success: {
    icon: CheckCircle,
    color: 'text-green-500',
    bg: 'bg-green-500/10',
    darkBg: 'dark:bg-green-500/20',
    border: 'border-s-green-500'
  },
  note: {
    icon: Pencil,
    color: 'text-indigo-500',
    bg: 'bg-indigo-500/10',
    darkBg: 'dark:bg-indigo-500/20',
    border: 'border-s-indigo-500'
  },
  abstract: {
    icon: FileText,
    color: 'text-teal-500',
    bg: 'bg-teal-500/10',
    darkBg: 'dark:bg-teal-500/20',
    border: 'border-s-teal-500'
  },
  todo: {
    icon: ListChecks,
    color: 'text-sky-500',
    bg: 'bg-sky-500/10',
    darkBg: 'dark:bg-sky-500/20',
    border: 'border-s-sky-500'
  },
  tip: {
    icon: Lightbulb,
    color: 'text-cyan-500',
    bg: 'bg-cyan-500/10',
    darkBg: 'dark:bg-cyan-500/20',
    border: 'border-s-cyan-500'
  },
  important: {
    icon: Flag,
    color: 'text-fuchsia-500',
    bg: 'bg-fuchsia-500/10',
    darkBg: 'dark:bg-fuchsia-500/20',
    border: 'border-s-fuchsia-500'
  },
  question: {
    icon: HelpCircle,
    color: 'text-orange-500',
    bg: 'bg-orange-500/10',
    darkBg: 'dark:bg-orange-500/20',
    border: 'border-s-orange-500'
  },
  example: {
    icon: List,
    color: 'text-purple-500',
    bg: 'bg-purple-500/10',
    darkBg: 'dark:bg-purple-500/20',
    border: 'border-s-purple-500'
  },
  quote: {
    icon: Quote,
    color: 'text-stone-500',
    bg: 'bg-stone-500/10',
    darkBg: 'dark:bg-stone-500/20',
    border: 'border-s-stone-500'
  },
  bug: {
    icon: Bug,
    color: 'text-rose-500',
    bg: 'bg-rose-500/10',
    darkBg: 'dark:bg-rose-500/20',
    border: 'border-s-rose-500'
  }
}

interface CalloutBlock {
  props: {
    type: string
    fold?: string
  }
}

interface CalloutEditor {
  getTextCursorPosition: () => { block: CalloutBlock }
  updateBlock: (
    block: CalloutBlock,
    update: { type: 'callout'; props: { type?: string; fold?: 'closed' | 'open' } }
  ) => void
}

interface CalloutBlockRendererProps {
  block: CalloutBlock
  editor: unknown
  contentRef: React.Ref<HTMLDivElement>
}

interface ResolvedCalloutStyle {
  icon: AppIcon
  label: string
  /** Built-in types colour through classes; a custom type through its own hex. */
  classes?: Pick<CalloutStyle, 'color' | 'bg' | 'darkBg' | 'border'>
  accent?: string
}

function isBuiltIn(type: string): type is CalloutTypeValue {
  return (CALLOUT_TYPE_VALUES as readonly string[]).includes(type)
}

// A type with no definition (a newer build's, or one deleted here) renders as
// info and keeps its value.
function resolveCalloutStyle(
  type: string,
  custom: readonly CalloutTypeDefinition[],
  builtInLabels: Record<CalloutTypeValue, string>
): ResolvedCalloutStyle {
  if (isBuiltIn(type)) {
    const { icon, ...classes } = CALLOUT_STYLES[type]
    return { icon, label: builtInLabels[type], classes }
  }
  const definition = custom.find((candidate) => candidate.name === type)
  if (definition) {
    return { icon: calloutIcon(definition.icon), label: definition.label, accent: definition.color }
  }
  const { icon, ...classes } = CALLOUT_STYLES.info
  return { icon, label: type, classes }
}

function CalloutBlockRenderer({ block, editor, contentRef }: CalloutBlockRendererProps) {
  const { t } = useT('notes')
  const calloutEditor = editor as CalloutEditor
  const customTypes = useCalloutTypes()
  const labels: Record<CalloutTypeValue, string> = {
    info: t('editor.callout.info'),
    warning: t('editor.callout.warning'),
    error: t('editor.callout.error'),
    success: t('editor.callout.success'),
    note: t('editor.callout.note'),
    abstract: t('editor.callout.abstract'),
    todo: t('editor.callout.todo'),
    tip: t('editor.callout.tip'),
    important: t('editor.callout.important'),
    question: t('editor.callout.question'),
    example: t('editor.callout.example'),
    quote: t('editor.callout.quote'),
    bug: t('editor.callout.bug')
  }
  const calloutType = resolveCalloutStyle(block.props.type, customTypes, labels)
  const Icon = calloutType.icon

  const closed = block.props.fold === 'closed'
  // Toggling rewrites the `> [!type]-` / `+` marker in the note (#3206).
  const toggleFold = () => {
    calloutEditor.updateBlock(block, {
      type: 'callout',
      props: { fold: closed ? 'open' : 'closed' }
    })
  }

  return (
    <div
      className={cn(
        'flex items-center rounded-md border-s-4 px-3 py-2',
        calloutType.classes?.bg,
        calloutType.classes?.darkBg,
        calloutType.classes?.border
      )}
      style={
        calloutType.accent
          ? {
              borderInlineStartColor: calloutType.accent,
              backgroundColor: `color-mix(in srgb, ${calloutType.accent} 12%, transparent)`
            }
          : undefined
      }
      data-callout-type={block.props.type}
      data-callout-fold={block.props.fold ?? 'none'}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'me-3 flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded',
              calloutType.classes?.color
            )}
            style={calloutType.accent ? { color: calloutType.accent } : undefined}
            contentEditable={false}
            aria-label={t('editor.callout.changeType')}
          >
            <Icon className="h-[18px] w-[18px]" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={8}>
          <DropdownMenuLabel>{t('editor.callout.menuLabel')}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {CALLOUT_TYPE_VALUES.map((value) => {
            const { icon: ItemIcon, color } = CALLOUT_STYLES[value]
            return (
              <DropdownMenuItem
                key={value}
                onClick={() => {
                  calloutEditor.updateBlock(block, {
                    type: 'callout',
                    props: { type: value }
                  })
                }}
              >
                <ItemIcon className={cn('h-4 w-4', color)} />
                {labels[value]}
              </DropdownMenuItem>
            )
          })}
          {customTypes.length > 0 && <DropdownMenuSeparator />}
          {customTypes.map((definition) => {
            const ItemIcon = calloutIcon(definition.icon)
            return (
              <DropdownMenuItem
                key={definition.name}
                onClick={() => {
                  calloutEditor.updateBlock(block, {
                    type: 'callout',
                    props: { type: definition.name }
                  })
                }}
              >
                <ItemIcon className="h-4 w-4" style={{ color: definition.color }} />
                {definition.label}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      {closed && (
        <span className="min-w-0 flex-1 font-medium" contentEditable={false}>
          {calloutType.label}
        </span>
      )}
      <div className={cn('inline-content min-w-0 flex-1', closed && 'hidden')} ref={contentRef} />
      <button
        type="button"
        className="ms-2 flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground"
        contentEditable={false}
        aria-expanded={!closed}
        aria-label={closed ? t('editor.callout.expand') : t('editor.callout.collapse')}
        onClick={toggleFold}
      >
        <ChevronRight
          className={cn(
            'h-4 w-4 transition-transform motion-reduce:transition-none',
            !closed && 'rotate-90 rtl:-rotate-90',
            closed && 'rtl:rotate-180'
          )}
        />
      </button>
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

/** One slash row per custom type, read at call time so a new type shows without a reload. */
export function getCustomCalloutSlashMenuItems(
  editor: unknown,
  labels: { group: string; subtext: string }
) {
  return getCalloutTypes().map((definition) => ({
    id: `callout:${definition.name}`,
    title: definition.label,
    onItemClick: () => {
      const calloutEditor = editor as CalloutEditor
      calloutEditor.updateBlock(calloutEditor.getTextCursorPosition().block, {
        type: 'callout',
        props: { type: definition.name }
      })
    },
    aliases: ['callout', definition.name],
    group: labels.group,
    subtext: labels.subtext
  }))
}

// ============================================================================
// Callout Block Serialization (> [!type]\n> content)
// ============================================================================

// The `> [!type]` form AND the claim rules live in @memry/editor-schema/blocks
// so both processes read and write the same bytes. The reader is strict on
// purpose: only the exact shape `serializeCalloutBlock` writes (plus the bare
// damaged shape #1846 heals) is claimed — `> [!danger]` and a title after the
// marker are someone else's bytes and stay quote blocks, on this path exactly
// as on the CRDT one.
export { serializeCalloutBlock } from '@memry/editor-schema/blocks'

export type CalloutSegment = { kind: 'callout'; run: CalloutRun; markers: string[] }
/**
 * A blockquote run whose inner structure BlockNote's flat quote block loses —
 * claimed under the same byte-round-trip proof as a callout, and for the same
 * reason: the bytes belong to whoever wrote the file (#1881).
 */
export type QuoteSegment = { kind: 'quote'; run: QuoteRun; markers: string[] }
export type MarkdownSegment = { kind: 'markdown'; text: string }
/**
 * Blank lines beyond the standard paragraph break at a callout's or a quote's
 * edge. Callers emit `extraLines` empty paragraphs, exactly as for the toggle
 * splitter's gap segment (#1877).
 */
export type GapSegment = { kind: 'gap'; extraLines: number }
export type ContentSegment = CalloutSegment | QuoteSegment | MarkdownSegment | GapSegment

/**
 * Split markdown into claimed callout / structured quote runs and the markdown
 * between them.
 *
 * This runs BEFORE `splitMarkdownPreservingBlanks`, so the blank lines at each
 * run's edge never reach the blank-line scanner: they are this function's to
 * carry, as `gap` segments, or they collapse to a single paragraph break on the
 * next write-back (#1892). Same rules as `splitMarkdownByToggles`.
 */
export function splitMarkdownByBlockquoteRuns(markdown: string): ContentSegment[] {
  const lines = markdown.split('\n')
  const segments: ContentSegment[] = []
  const fence = createFenceTracker()

  let mdLines: string[] = []
  let i = 0

  // One blank line is the paragraph break assembly writes on its own, so only
  // the lines beyond it are carried. A gap before the first segment is dropped:
  // with nothing in front, assembly's `\n\n` would add blank lines, not extend
  // a separator (see `splitMarkdownByToggles`).
  const pushGap = (blankLines: number): void => {
    if (segments.length > 0 && blankLines > 1) {
      segments.push({ kind: 'gap', extraLines: blankLines - 1 })
    }
  }

  const flushMarkdown = (): void => {
    let first = 0
    while (first < mdLines.length && mdLines[first].trim() === '') first++
    let afterLast = mdLines.length
    while (afterLast > first && mdLines[afterLast - 1].trim() === '') afterLast--

    const text = mdLines.slice(first, afterLast).join('\n').trim()
    if (text) {
      pushGap(first)
      segments.push({ kind: 'markdown', text })
      pushGap(mdLines.length - afterLast)
    } else {
      // Nothing but blanks: a single seam between two runs, counted once.
      pushGap(mdLines.length)
    }
    mdLines = []
  }

  const isMarkerLine = (line: string): boolean => parseSidecarMarkerLine(line.trim()) !== null

  // Sidecar marker lines belong to the block below them, so a run that sits
  // under one still starts its paragraph: main's `afterSidecarMarker` twin.
  const startsParagraph = (index: number): boolean => {
    let above = index - 1
    while (above >= 0 && isMarkerLine(lines[above])) above--
    return above < 0 || lines[above].trim() === ''
  }

  const popTrailingMarkers = (): string[] => {
    const markers: string[] = []
    while (mdLines.length > 0 && isMarkerLine(mdLines[mdLines.length - 1])) {
      markers.unshift((mdLines.pop() as string).trim())
    }
    return markers
  }

  while (i < lines.length) {
    const insideFence = fence.consume(lines[i])
    const atParagraphStart = startsParagraph(i)
    const run = insideFence ? null : readCalloutRun(lines, i, atParagraphStart)

    const quoteRun =
      run || insideFence || !atParagraphStart ? null : readStructuredQuoteRun(lines, i)

    const claimed: { kind: 'callout'; run: CalloutRun } | { kind: 'quote'; run: QuoteRun } | null =
      run ? { kind: 'callout', run } : quoteRun ? { kind: 'quote', run: quoteRun } : null

    if (claimed) {
      const markers = popTrailingMarkers()
      flushMarkdown()
      segments.push({ ...claimed, markers })
      for (let consumed = i + 1; consumed < claimed.run.end; consumed++) {
        fence.consume(lines[consumed])
      }
      i = claimed.run.end
    } else {
      mdLines.push(lines[i])
      i++
    }
  }

  flushMarkdown()
  return segments
}
