import { Check, ChevronLeft, ChevronRight } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { Translate } from './types'

/** One page for the day: a date nav, a heading, a line of prose and its tasks. */
export function JournalPane({ p }: { p: Translate }): React.JSX.Element {
  return (
    <div className="relative flex flex-col overflow-hidden px-[30px] pt-3.5 text-foreground">
      <span className="pointer-events-none absolute start-2.5 top-5 h-[90px] w-[260px] rounded-full bg-amber-500 opacity-[0.14] blur-[36px]" />
      <span className="relative flex items-center gap-2 text-text-tertiary">
        <span className="flex gap-0.5 [&_svg]:size-3">
          <ChevronLeft />
          <ChevronRight />
        </span>
        <span className="text-[11px] leading-[14px]">{p('journalDate')}</span>
        <span className="flex h-4 items-center rounded bg-amber-500/18 px-1.5 text-[8.5px] font-semibold uppercase leading-3 tracking-[0.08em] text-amber-600 dark:text-amber-300">
          {p('today')}
        </span>
      </span>
      <span className="relative pt-[18px] font-serif text-[32px] font-medium leading-9 tracking-[-0.01em]">
        {p('journalHeading')}
      </span>
      <span className="relative max-w-[440px] pt-3 text-[12.5px] leading-5">
        {p('journalLine')}
      </span>
      <div className="relative flex flex-col gap-0.5 pt-2 text-[12.5px]">
        {[p('task1'), p('task2'), p('task3')].map((task, index) => (
          <span key={task} className="flex h-[22px] items-center gap-2">
            {index === 0 ? (
              <span className="flex size-3 items-center justify-center rounded-[3px] bg-foreground text-background">
                <Check className="size-[9px]" />
              </span>
            ) : (
              <span className="size-3 rounded-[3px] border-[1.25px] border-text-tertiary" />
            )}
            <span className={cn(index === 0 && 'text-text-tertiary line-through')}>{task}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
