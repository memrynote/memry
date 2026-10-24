import { FileText, Image, Link, Mic, Paperclip } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { tint } from './parts'
import type { Translate } from './types'

type Row = {
  icon: React.ReactNode
  color: string
  title: string
  meta: string
  age: string
}

function Group({ title, rows }: { title: string; rows: Row[] }): React.JSX.Element {
  return (
    <div className="flex flex-col">
      <span className="flex items-center gap-1.5 px-1.5 pb-1">
        <span className="text-xs font-semibold leading-4">{title}</span>
        <span className="text-[11px] text-text-tertiary">{rows.length}</span>
      </span>
      {rows.map((row) => (
        <span key={row.title} className="flex h-[34px] items-center gap-2.5 px-1.5">
          <span
            className="flex size-[22px] shrink-0 items-center justify-center rounded-md [&_svg]:size-3"
            style={{ color: row.color, ...tint(row.color, 18) }}
          >
            {row.icon}
          </span>
          <span className="flex min-w-0 grow basis-0 flex-col gap-px">
            <span className="truncate text-xs font-medium leading-[15px]">{row.title}</span>
            <span className="truncate text-[10.5px] leading-[13px] text-text-tertiary">
              {row.meta}
            </span>
          </span>
          <span className="w-6 text-end text-[10.5px] text-text-tertiary">{row.age}</span>
        </span>
      ))}
    </div>
  )
}

/** Quick capture, then what landed today and yesterday. */
export function InboxPane({ p, name }: { p: Translate; name: string }): React.JSX.Element {
  const today: Row[] = [
    {
      icon: <Link />,
      color: 'var(--accent-purple)',
      title: p('inboxLink'),
      meta: p('inboxLinkSource'),
      age: p('minutesAgo', { count: 2 })
    },
    {
      icon: <Mic />,
      color: 'var(--task-star)',
      title: p('inboxVoice'),
      meta: p('inboxTranscribing'),
      age: p('hoursAgo', { count: 1 })
    },
    {
      icon: <FileText />,
      color: 'var(--task-progress)',
      title: p('inboxThought'),
      meta: p('inboxThoughtBody'),
      age: p('hoursAgo', { count: 3 })
    }
  ]
  const yesterday: Row[] = [
    {
      icon: <Image />,
      color: 'var(--task-complete)',
      title: p('inboxImage'),
      meta: p('inboxImageKind'),
      age: p('daysAgo', { count: 1 })
    }
  ]
  return (
    <div className="flex flex-col gap-3.5 px-[18px] pt-3.5 text-foreground">
      <div className="flex items-center gap-2">
        <span className="flex gap-0.5 rounded-lg border border-border bg-surface p-0.5 text-[11px]">
          {[name, p('archived')].map((label, index) => (
            <span
              key={label}
              className={cn(
                'flex h-[22px] items-center rounded-md px-[9px]',
                index === 0 ? 'bg-surface-active font-medium' : 'text-text-tertiary'
              )}
            >
              {label}
            </span>
          ))}
        </span>
        <span className="flex h-[30px] min-w-0 grow basis-0 items-center gap-2 rounded-lg bg-surface px-2.5 text-text-tertiary ring-1 ring-text-tertiary/60">
          <span className="min-w-0 grow basis-0 truncate text-[11.5px]">{p('quickCapture')}</span>
          <Paperclip className="size-3" />
          <Mic className="size-3" />
        </span>
      </div>
      <Group title={p('today')} rows={today} />
      <Group title={p('yesterday')} rows={yesterday} />
    </div>
  )
}
