import { useCallback, useRef, useEffect, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { HugeiconsIcon } from '@hugeicons/react'
import { useHugeIconPicker } from './use-hugeicon-picker'
import { cn } from '@/lib/utils'
import { Loader } from '@/lib/icons'

const COLS = 8
const ROW_HEIGHT = 36
const ROW_GAP = 2

interface HugeIconGridProps {
  onSelect: (iconName: string) => void
}

export function HugeIconGrid({ onSelect }: HugeIconGridProps): React.JSX.Element {
  const { icons, search, setSearch, isLoading } = useHugeIconPicker()
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const rows = useMemo(() => {
    const result: (typeof icons)[] = []
    for (let i = 0; i < icons.length; i += COLS) {
      result.push(icons.slice(i, i + COLS))
    }
    return result
  }, [icons])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT + ROW_GAP,
    overscan: 5
  })

  useEffect(() => {
    virtualizer.scrollToIndex(0)
  }, [search, virtualizer])

  const handleClearSearch = useCallback(() => {
    setSearch('')
    inputRef.current?.focus()
  }, [setSearch])

  return (
    <div
      className="flex flex-col w-full h-full relative"
      style={
        {
          '--padding': '12px',
          '--sidebar-width': '16px',
          '--font-size': '15px',
          '--duration': '225ms',
          '--easing': 'cubic-bezier(.4, 0, .2, 1)'
        } as React.CSSProperties
      }
    >
      {/* Search — mirrors emoji-mart: .padding-lr > div > .spacer + .flex.flex-middle > .search.relative.flex-grow */}
      <div className="shrink-0 px-[var(--padding)]">
        <div>
          <div style={{ height: 10 }} />
          <div className="flex items-center">
            <div className="relative z-[2] flex-auto [&_input,&_button]:text-[calc(var(--font-size)-1px)]">
              <input
                ref={inputRef}
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search"
                autoComplete="off"
                className={cn(
                  'block w-full border-0 outline-none appearance-none',
                  'text-inherit placeholder:text-inherit placeholder:opacity-60',
                  'bg-[var(--em-color-border,rgba(0,0,0,.05))]',
                  'dark:bg-[var(--em-color-border,rgba(255,255,255,.1))]',
                  'focus:bg-[rgb(var(--em-rgb-input,255,255,255))]',
                  'dark:focus:bg-[rgb(var(--em-rgb-input,0,0,0))]',
                  'focus:shadow-[inset_0_0_0_1px_rgb(var(--em-rgb-accent,34,102,237)),0_1px_3px_rgba(65,69,73,0.2)]',
                  'dark:focus:shadow-[inset_0_0_0_1px_rgb(var(--em-rgb-accent,58,130,247)),0_1px_3px_rgba(65,69,73,0.2)]',
                  'transition-[background-color,box-shadow] duration-[var(--duration)] ease-[var(--easing)]'
                )}
                style={{
                  padding: '10px 2em 10px 2.2em',
                  borderRadius: 10
                }}
              />
              <span className="pointer-events-none absolute left-[.7em] top-1/2 -translate-y-1/2 z-[1] flex text-[color:rgba(var(--em-rgb-color,34,36,39),.7)] dark:text-[color:rgba(var(--em-rgb-color,222,222,221),.7)]">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                  className="h-[1em] w-[1em] fill-current"
                >
                  <path d="M12.9 14.32a8 8 0 1 1 1.41-1.41l5.35 5.33-1.42 1.42-5.33-5.34zM8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z" />
                </svg>
              </span>
              {search && (
                <button
                  type="button"
                  onClick={handleClearSearch}
                  className="absolute right-[.7em] top-1/2 -translate-y-1/2 z-[1] flex text-[color:rgba(var(--em-rgb-color,34,36,39),.7)] dark:text-[color:rgba(var(--em-rgb-color,222,222,221),.7)] hover:opacity-80"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 20 20"
                    className="h-[1em] w-[1em] fill-current"
                  >
                    <path d="M10 0a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm5.34 14.28-1.06 1.06L10 11.06l-4.28 4.28-1.06-1.06L8.94 10 4.66 5.72l1.06-1.06L10 8.94l4.28-4.28 1.06 1.06L11.06 10l4.28 4.28z" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Grid — mirrors emoji-mart: .scroll with padding-left via padding-lr, scrollbar in sidebar-width space */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-x-hidden overflow-y-auto pl-[var(--padding)] pr-0"
      >
        {isLoading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <Loader className="h-5 w-5 animate-spin" />
          </div>
        ) : icons.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            <span className="text-sm">No icons found</span>
            <button
              type="button"
              onClick={handleClearSearch}
              className="text-xs hover:text-foreground underline"
            >
              Clear search
            </button>
          </div>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index]
              return (
                <div
                  key={virtualRow.index}
                  className="absolute left-0 top-0 flex w-full justify-between"
                  style={{
                    height: ROW_HEIGHT,
                    transform: `translateY(${virtualRow.start}px)`
                  }}
                >
                  {row.map((entry) => (
                    <button
                      key={entry.name}
                      type="button"
                      onClick={() => onSelect(entry.name)}
                      title={entry.name.replace(/Icon$/, '')}
                      className={cn(
                        'flex items-center justify-center shrink-0',
                        'h-[36px] w-[36px]',
                        'text-foreground transition-colors duration-75',
                        'hover:bg-[var(--em-color-border,rgba(0,0,0,.05))]',
                        'dark:hover:bg-[var(--em-color-border,rgba(255,255,255,.1))]',
                        'rounded-[8px]'
                      )}
                    >
                      <HugeiconsIcon icon={entry.data} size={20} />
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
