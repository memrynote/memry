import { ArrowUp, Check, ChevronDown, FileText } from '@/lib/icons'
import { TaskCircle } from './parts'
import type { Translate } from './types'

/** One agent turn: the question with a mention, a finished step, the answer, and the composer. */
export function AgentPane({ p }: { p: Translate }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 px-[26px] pt-4 text-foreground">
      <div className="flex justify-end">
        <span className="flex items-center gap-1 rounded-xl bg-foreground px-[11px] py-[7px] text-xs leading-4 text-background">
          {p('agentAskBefore')}
          <span className="rounded bg-indigo-400/20 px-1 font-semibold text-indigo-300 dark:text-indigo-600">
            {p('launch')}
          </span>
          {p('agentAskAfter')}
        </span>
      </div>
      <span className="flex items-center gap-1.5 text-[10.5px] leading-[14px] text-text-tertiary">
        <Check className="size-[11px] text-green-400" />
        {p('agentSteps')}
        <ChevronDown className="size-[9px]" />
      </span>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs leading-[17px] text-text-secondary">{p('agentAnswer')}</span>
        <div className="flex flex-col gap-[3px] ps-0.5">
          {[
            [p('task2'), p('agentDueToday')],
            [p('task6'), p('agentDueThursday')]
          ].map(([title, due]) => (
            <span key={title} className="flex items-center gap-2 text-xs leading-[17px]">
              <TaskCircle className="size-[11px]" />
              {title}
              <span className="text-text-tertiary">{due}</span>
            </span>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2 rounded-[14px] border border-border bg-card px-[11px] py-[9px]">
        <span className="text-[11.5px] leading-[14px] text-text-tertiary">
          {p('agentComposer')}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="flex h-5 items-center gap-1 rounded-md bg-surface px-[7px] text-[10.5px] text-text-secondary">
            <FileText className="size-2.5 text-text-tertiary" />
            {p('launchPlan')}
          </span>
          <span className="grow basis-0" />
          <span className="text-[10.5px] text-text-tertiary">{p('agentModel')}</span>
          <span className="flex size-[22px] items-center justify-center rounded-full bg-foreground text-background">
            <ArrowUp className="size-[11px]" />
          </span>
        </span>
      </div>
    </div>
  )
}
