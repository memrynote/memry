import { useEffect, useState } from 'react'

import type { AttachmentInput } from '@memry/contracts/ipc-agent'
import type { SearchResultItem } from '@memry/contracts/search-api'
import { useT } from '@memry/i18n/renderer'

interface RefPickerProps {
  query: string
  onPick: (attachment: AttachmentInput) => void
  onClose: () => void
}

interface RefPickerResult {
  kind: AttachmentInput['kind']
  id: string
  label: string
}

function toAttachmentResult(item: SearchResultItem): RefPickerResult | null {
  if (item.type !== 'note' && item.type !== 'journal' && item.type !== 'task') return null
  return {
    kind: item.type,
    id: item.id,
    label: item.title
  }
}

export function RefPicker({ query, onPick, onClose }: RefPickerProps): React.JSX.Element {
  const { t } = useT('common')
  const [results, setResults] = useState<RefPickerResult[]>([])

  useEffect(() => {
    const text = query.trim()
    if (!text) {
      setResults([])
      return
    }

    let cancelled = false
    void window.api.search
      .query({ text, limit: 20 })
      .then((response) => {
        if (cancelled) return
        setResults(
          response.groups.flatMap((group) =>
            group.results.flatMap((item) => {
              const result = toAttachmentResult(item)
              return result ? [result] : []
            })
          )
        )
      })
      .catch(() => {
        if (!cancelled) setResults([])
      })

    return () => {
      cancelled = true
    }
  }, [query])

  return (
    <div
      role="listbox"
      className="absolute inset-x-2 bottom-full z-50 mb-2 max-h-64 overflow-y-auto rounded-md border border-sidebar-border bg-popover p-1 text-popover-foreground shadow-md"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      {results.length === 0 && (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          {t('agentChat.refPicker.noMatches')}
        </div>
      )}
      {results.map((result) => (
        <button
          key={`${result.kind}-${result.id}`}
          type="button"
          role="option"
          aria-selected={false}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-accent hover:text-accent-foreground"
          onClick={() => onPick({ kind: result.kind, ref_id: result.id, label: result.label })}
        >
          <span className="text-xs uppercase text-muted-foreground">{result.kind}</span>
          <span className="min-w-0 flex-1 truncate">{result.label}</span>
        </button>
      ))}
    </div>
  )
}
