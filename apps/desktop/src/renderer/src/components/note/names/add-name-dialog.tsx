import { useEffect, useMemo, useState } from 'react'
import { Command } from 'cmdk'
import { useT } from '@memry/i18n/renderer'
import { FileText } from '@/lib/icons'
import { createLogger } from '@/lib/logger'
import {
  folderOf,
  linkTargetFor,
  rankNoteNames,
  sharedTitles,
  type NamedNote
} from '@/lib/note-name-rank'
import { notesService } from '@/services/notes-service'

const log = createLogger('AddNameDialog')
const MAX_ROWS = 10

interface AddNameDialogProps {
  name: string | null
  onClose: () => void
  onPick: (note: NamedNote, target: string) => void
}

export function AddNameDialog({ name, onClose, onPick }: AddNameDialogProps) {
  const { t } = useT('notes')
  const [notes, setNotes] = useState<NamedNote[]>([])
  const [query, setQuery] = useState('')
  const open = name !== null

  useEffect(() => {
    if (!open) return
    let cancelled = false
    notesService
      .list({ limit: 500, sortBy: 'modified' })
      .then((result) => {
        if (cancelled) return
        setNotes(
          result.notes
            .filter((note) => (note.fileType ?? 'markdown') === 'markdown')
            .map((note) => ({
              id: note.id,
              title: note.title,
              path: note.path,
              aliases: note.aliases ?? []
            }))
        )
      })
      .catch((error: unknown) => log.error('Failed to list notes for the name picker', error))
    return () => {
      cancelled = true
      setQuery('')
    }
  }, [open])

  const shared = useMemo(() => sharedTitles(notes), [notes])
  const rows = useMemo(() => rankNoteNames(query, notes).slice(0, MAX_ROWS), [query, notes])

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      shouldFilter={false}
      label={t('names.pickerTitle', { name: name ?? '' })}
      overlayClassName="fixed inset-0 z-50 bg-black/50"
      className="fixed start-1/2 top-24 z-50 w-[28rem] max-w-[90vw] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-card shadow-lg rtl:translate-x-1/2"
    >
      <div className="border-b border-border px-3 pt-3 text-xs text-text-tertiary">
        {t('names.pickerTitle', { name: name ?? '' })}
      </div>
      <Command.Input
        value={query}
        onValueChange={setQuery}
        placeholder={t('names.pickerPlaceholder')}
        className="w-full border-b border-border bg-transparent px-3 py-3 text-sm outline-none"
      />
      <Command.List className="max-h-80 overflow-y-auto p-2">
        <Command.Empty className="px-2 py-6 text-center text-sm text-text-tertiary">
          {t('names.pickerEmpty')}
        </Command.Empty>
        {rows.map(({ note }) => (
          <Command.Item
            key={note.id}
            value={note.id}
            onSelect={() => onPick(note, linkTargetFor(note, shared))}
            className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-sm data-[selected=true]:bg-muted"
          >
            <FileText className="size-4 shrink-0 text-text-tertiary" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-start">{note.title}</span>
            {shared.has(note.title.toLowerCase()) && (
              <span className="shrink-0 truncate text-xs text-text-tertiary">
                {folderOf(note.path)}
              </span>
            )}
          </Command.Item>
        ))}
      </Command.List>
    </Command.Dialog>
  )
}
