import { cn } from '@/lib/utils'
import { FileText } from '@/lib/icons'
import { TaskCircle } from './parts'
import type { Translate } from './types'

/** The canvas glyph, drawn once for the sidebar item and the tab. */
export function CanvasGlyph({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect x="3.5" y="3.5" width="8" height="8" rx="2" />
      <rect x="12.5" y="12.5" width="8" height="8" rx="2" />
      <path d="M11.5 7.5h3a2 2 0 0 1 2 2v3" />
    </svg>
  )
}

/** One path per canvas tool: select, hand, rectangle, ellipse, arrow, pen, text, image. */
const TOOLS: string[][] = [
  ['M5 4l14 6-6 2-2 6z'],
  [
    'M7 11V5.5a1.5 1.5 0 0 1 3 0V10',
    'M10 10V4.5a1.5 1.5 0 0 1 3 0V10',
    'M13 10V5.5a1.5 1.5 0 0 1 3 0V12',
    'M16 9a1.5 1.5 0 0 1 3 0v5a7 7 0 0 1-12.5 4.3L4 15a1.5 1.5 0 0 1 2.3-2L7 14V11'
  ],
  ['M5 5h14v14H5z'],
  ['M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z'],
  ['M5 19 19 5', 'M11 5h8v8'],
  ['M4 20l4-1 11-11-3-3L5 16z'],
  ['M6 6h12M12 6v13'],
  ['M5 5h14v14H5z', 'm5 16 4-4 4 4 2-2 4 4']
]

const cardClass =
  'absolute w-[150px] rounded-lg border border-border bg-card px-[11px] pb-3 pt-2.5 shadow-[0_2px_8px_rgb(0_0_0/0.25)]'

function NoteCard({
  title,
  body,
  className
}: {
  title: string
  body: string
  className: string
}): React.JSX.Element {
  return (
    <div className={cn(cardClass, 'flex flex-col gap-[5px]', className)}>
      <span className="flex items-center gap-1.5 text-xs font-semibold leading-[15px]">
        <FileText className="size-[11px] text-text-tertiary" />
        {title}
      </span>
      <span className="text-[10.5px] leading-[15px] text-text-secondary">{body}</span>
    </div>
  )
}

/** A board with a toolbar, two note cards, a sticky, a task card and two arrows. */
export function CanvasPane({ p }: { p: Translate }): React.JSX.Element {
  return (
    <div className="relative min-h-0 grow overflow-hidden bg-[var(--graph-bg)] text-foreground">
      <div dir="ltr" className="absolute start-0 top-0 h-[290px] w-[498px]">
        <div className="absolute start-[139px] top-3 flex items-center gap-0.5 rounded-[9px] border border-border bg-surface p-[3px] shadow-[0_4px_14px_rgb(0_0_0/0.3)]">
          {TOOLS.map((paths, index) => (
            <span
              // oxlint-disable-next-line react/no-array-index-key -- static positional list; items have no id and never reorder
              key={index}
              className={cn(
                'flex size-6 items-center justify-center rounded-md text-text-secondary',
                index === 0 && 'bg-tint/18 text-tint'
              )}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-[13px]"
              >
                {paths.map((d) => (
                  <path key={d} d={d} />
                ))}
              </svg>
            </span>
          ))}
        </div>
        <NoteCard title={p('launchPlan')} body={p('canvasLaunchBody')} className="start-7 top-16" />
        <NoteCard
          title={p('readingList')}
          body={p('canvasReadingBody')}
          className="start-[290px] top-32"
        />
        <div className="absolute start-[300px] top-[52px] h-[58px] w-28 rotate-[2.5deg] rounded-[3px] bg-[#e8c547] px-2.5 py-[9px] text-[11px] font-medium leading-[14px] text-[#2a2410] shadow-[0_3px_8px_rgb(0_0_0/0.35)]">
          {p('canvasSticky')}
        </div>
        <div className="absolute start-[60px] top-[190px] flex w-[186px] items-center gap-2 rounded-lg border border-border bg-card px-[11px] py-[9px] text-[11.5px] leading-[14px] shadow-[0_2px_8px_rgb(0_0_0/0.25)]">
          <TaskCircle />
          <span className="grow basis-0">{p('task2')}</span>
          <span className="size-[7px] rounded-[2px] bg-indigo-400" />
        </div>
        <svg
          width="498"
          height="290"
          viewBox="0 0 498 290"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="absolute start-0 top-0 text-text-secondary"
        >
          <path d="M180 100 C 230 100, 250 150, 286 160" />
          <path d="m279 154 8 6-9 4" />
          <path d="M100 160 C 98 172, 104 180, 112 187" />
          <path d="m104 185 8 3-2-8" />
        </svg>
        <span className="absolute start-[206px] top-[104px] -rotate-6 font-serif text-[15px] italic leading-[18px] text-text-secondary">
          {p('canvasAnnotation')}
        </span>
      </div>
    </div>
  )
}
