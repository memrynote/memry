import type { FolderList } from '@/lib/capture-client'

// Native select: one tab stop, keyboard and screen-reader behavior for free, and
// untouched it stays on Inbox so the save flow gains no step. '' = Inbox.
export function FolderPicker({
  list,
  value,
  onChange,
  disabled
}: {
  list: FolderList
  value: string
  onChange: (folder: string) => void
  disabled?: boolean
}) {
  return (
    <label className="flex min-w-0 items-center gap-1.5 text-[12px] text-text-tertiary">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        className="size-3.5 shrink-0"
        aria-hidden
      >
        <path
          d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z"
          strokeLinejoin="round"
        />
      </svg>
      <span className="sr-only">Save to</span>
      <span className="max-w-[40%] shrink-0 truncate" title={list.vaultName}>
        {list.vaultName}
      </span>
      <span aria-hidden>/</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 flex-1 truncate rounded-md border border-transparent bg-transparent py-0.5 pe-1 text-[12.5px] text-foreground outline-none hover:border-border focus-visible:border-text-tertiary disabled:opacity-60"
      >
        <option value="">Inbox</option>
        {list.folders.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
    </label>
  )
}
