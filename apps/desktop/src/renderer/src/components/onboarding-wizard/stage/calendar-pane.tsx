import { cn } from '@/lib/utils'
import { TaskCircle, tint } from './parts'
import type { Translate } from './types'

/** A fixed week, so the stage reads the same on any day the user opens it. */
const MONDAY = new Date(2025, 9, 13)
const DAYS = [0, 1, 2, 3, 4].map((offset) => new Date(2025, 9, 13 + offset))

type Hue = 'indigo' | 'green' | 'violet'

type Event = {
  column: number
  top: number
  height: number
  hue: Hue
  title: string
  meta: string
}

const HOURS = [10, 11, 12, 13].map((hour) => new Date(2025, 9, 13, hour))

function EventChip({ event }: { event: Event }): React.JSX.Element {
  const rail = `var(--cal-${event.hue}-rail)`
  return (
    <span
      className="absolute inset-x-[3px] flex flex-col gap-px overflow-hidden rounded-[5px] border-s-[2.5px] px-1.5 py-1"
      style={{ top: event.top, height: event.height, borderColor: rail, ...tint(rail, 22) }}
    >
      <span className="truncate text-[10.5px] font-semibold leading-[13px] text-foreground">
        {event.title}
      </span>
      <span className="truncate text-[9.5px] leading-3 text-text-secondary">{event.meta}</span>
    </span>
  )
}

function AllDayTask({ title }: { title: string }): React.JSX.Element {
  return (
    <span
      className="flex h-[18px] items-center gap-1 overflow-hidden rounded border-s-2 px-[5px]"
      style={{
        borderColor: 'var(--task-complete)',
        ...tint('var(--task-complete)', 16)
      }}
    >
      <TaskCircle className="size-2 rounded-[2px] border-[1.2px] border-[var(--task-complete)]" />
      <span className="truncate text-[10px] font-medium leading-3 text-foreground">{title}</span>
    </span>
  )
}

/** Week view: header, all-day tasks and a short run of the timeline with a now line. */
export function CalendarPane({ p, locale }: { p: Translate; locale: string }): React.JSX.Element {
  const format = (options: Intl.DateTimeFormatOptions, date: Date): string =>
    new Intl.DateTimeFormat(locale, options).format(date)
  const events: Event[] = [
    { column: 0, top: 41, height: 57, hue: 'indigo', title: p('eventQ4'), meta: p('eventQ4Meta') },
    {
      column: 1,
      top: 1,
      height: 37,
      hue: 'indigo',
      title: p('eventLaunchSync'),
      meta: '9:00 – 10:00'
    },
    { column: 2, top: 81, height: 37, hue: 'green', title: p('eventGym'), meta: '11:00 – 12:00' },
    {
      column: 3,
      top: 21,
      height: 37,
      hue: 'indigo',
      title: p('eventDemoPrep'),
      meta: '9:30 – 10:30'
    },
    { column: 4, top: 101, height: 47, hue: 'violet', title: p('eventLunch'), meta: '11:30' }
  ]
  return (
    <div className="flex min-h-0 grow flex-col text-foreground">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
        <span className="flex grow basis-0 gap-1 text-[13px] leading-4">
          <span className="font-bold">{format({ month: 'long' }, MONDAY)}</span>
          <span className="text-text-tertiary">{format({ year: 'numeric' }, MONDAY)}</span>
        </span>
        <span className="flex gap-px rounded-[7px] border border-border bg-surface p-0.5 text-[10.5px]">
          {[p('calendarDay'), p('calendarWeek'), p('calendarMonth')].map((label, index) => (
            <span
              key={label}
              className={cn(
                'flex h-5 items-center rounded-[5px] px-2',
                index === 1 ? 'bg-tint/18 font-medium text-tint' : 'text-text-tertiary'
              )}
            >
              {label}
            </span>
          ))}
        </span>
        <span className="flex h-6 items-center rounded-md border border-border px-2 text-[10.5px] font-medium text-text-secondary">
          {p('today')}
        </span>
      </div>
      <div className="flex border-b border-border ps-10">
        {DAYS.map((day, index) => (
          <span
            // oxlint-disable-next-line react/no-array-index-key -- static positional list; items have no id and never reorder
            key={index}
            className={cn(
              'flex h-[30px] grow basis-0 items-center justify-center gap-[5px]',
              index > 0 && 'border-s border-border'
            )}
          >
            <span className="text-[10px] leading-3 text-text-tertiary">
              {format({ weekday: 'short' }, day)}
            </span>
            <span
              className={cn(
                'flex items-center justify-center text-[11px] leading-[14px]',
                index === 0
                  ? 'size-5 rounded-full bg-tint font-semibold text-tint-foreground'
                  : 'font-medium'
              )}
            >
              {format({ day: 'numeric' }, day)}
            </span>
          </span>
        ))}
      </div>
      <div className="flex border-b border-border">
        <span className="flex w-10 shrink-0 items-center justify-end pe-1.5 text-[9px] leading-3 text-text-tertiary">
          {p('allDay')}
        </span>
        {DAYS.map((_, index) => (
          <span
            // oxlint-disable-next-line react/no-array-index-key -- static positional list; items have no id and never reorder
            key={index}
            className={cn(
              'flex grow basis-0 flex-col gap-0.5 px-[3px] py-1',
              index > 0 && 'border-s border-border'
            )}
          >
            {index === 0 && <AllDayTask title={p('task1')} />}
            {index === 1 && <AllDayTask title={p('task3')} />}
          </span>
        ))}
      </div>
      <div className="relative flex h-[220px] shrink-0 overflow-hidden">
        {HOURS.map((_, index) => (
          <span
            // oxlint-disable-next-line react/no-array-index-key -- static positional list; items have no id and never reorder
            key={index}
            className="absolute inset-x-0 border-t border-border/60"
            style={{ top: 40 * (index + 1) }}
          />
        ))}
        <span className="absolute inset-x-0 top-0 border-t border-border/60" />
        <span className="relative w-10 shrink-0 border-e border-border">
          {HOURS.map((hour, index) => (
            <span
              // oxlint-disable-next-line react/no-array-index-key -- static positional list; items have no id and never reorder
              key={index}
              className="absolute end-1.5 text-[9px] leading-3 text-text-tertiary"
              style={{ top: 40 * (index + 1) - 6 }}
            >
              {format({ hour: 'numeric' }, hour)}
            </span>
          ))}
        </span>
        {DAYS.map((_, column) => (
          <span
            // oxlint-disable-next-line react/no-array-index-key -- static positional list; items have no id and never reorder
            key={column}
            className={cn('relative grow basis-0', column > 0 && 'border-s border-border')}
          >
            {events
              .filter((event) => event.column === column)
              .map((event) => (
                <EventChip key={event.title} event={event} />
              ))}
            {column === 0 && (
              <>
                <span className="absolute inset-x-0 top-6 h-[1.5px] bg-tint" />
                <span className="absolute -start-1 top-[21px] size-2 rounded-full bg-tint shadow-[0_0_6px_var(--tint)]" />
              </>
            )}
          </span>
        ))}
      </div>
    </div>
  )
}
