import { Bookmark, ChevronDown, Clock, FileText } from '@/lib/icons'
import type { Translate } from './types'

function Card({
  icon,
  title,
  children
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 grow basis-0 flex-col gap-1.5 rounded-xl border border-border bg-card px-3 pb-2.5 pt-3">
      <span className="flex items-center gap-1.5 pb-0.5 text-tint [&_svg]:size-3">
        {icon}
        <span className="text-[9px] font-semibold uppercase leading-3 tracking-[0.08em] text-text-tertiary">
          {title}
        </span>
      </span>
      {children}
    </div>
  )
}

/** The start page: a greeting, what was edited last, and bookmarks. */
export function HomePane({ p, name }: { p: Translate; name: string }): React.JSX.Element {
  const recent = [
    [p('launchPlan'), p('launchPlanMeta')],
    [p('readingList'), p('readingListMeta')],
    [p('q4Plan'), p('q4PlanMeta')]
  ]
  return (
    <div className="flex flex-col gap-4 px-6 pt-[22px] text-foreground">
      <div className="flex items-end justify-between">
        <div className="flex flex-col gap-[3px]">
          <span className="font-serif text-[26px] font-medium leading-[30px] tracking-[-0.01em]">
            {p('homeGreeting')}
          </span>
          <span className="text-[11.5px] leading-[14px] text-text-tertiary">{p('homeMeta')}</span>
        </div>
        <span className="flex h-6 items-center gap-1 rounded-xl border border-border px-[9px] text-[11px] font-medium text-text-secondary">
          {name}
          <ChevronDown className="size-[9px] text-text-tertiary" />
        </span>
      </div>
      <div className="flex items-start gap-3">
        <Card icon={<Clock />} title={p('recentlyEdited')}>
          {recent.map(([title, meta]) => (
            <span key={title} className="flex items-start gap-2 py-[3px]">
              <FileText className="mt-0.5 size-3 shrink-0 text-text-tertiary" />
              <span className="flex min-w-0 flex-col gap-px">
                <span className="truncate text-xs font-medium leading-4">{title}</span>
                <span className="truncate text-[10.5px] leading-[13px] text-text-tertiary">
                  {meta}
                </span>
              </span>
            </span>
          ))}
        </Card>
        <Card icon={<Bookmark />} title={p('bookmarks')}>
          {[p('ideas'), p('task2'), p('fitnessRoutine')].map((title) => (
            <span key={title} className="flex h-6 items-center gap-2 text-xs leading-4">
              <FileText className="size-3 shrink-0 text-text-tertiary" />
              <span className="truncate">{title}</span>
            </span>
          ))}
        </Card>
      </div>
    </div>
  )
}
