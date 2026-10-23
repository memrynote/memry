import { useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import type { FolderNoteShortcut, ShortcutBinding } from '@memry/contracts/settings-schemas'
import { Button } from '@/components/ui/button'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Picker, usePickerContext, usePickerSearch } from '@/components/ui/picker'
import { SettingsGroup } from '@/components/settings/settings-primitives'
import { AlertTriangle, Folder, Pencil, Plus, Trash2, X } from '@/lib/icons'
import { useNoteFoldersQuery } from '@/hooks/use-notes-query'
import { bindingFromKeyboardEvent } from '@/hooks/use-keyboard-shortcuts-base'
import { bindingParts, findConflicts, folderNoteShortcutId } from '@/lib/shortcut-catalog'
import { trackRendererLog } from '@/lib/telemetry-diagnostics'
import { cn } from '@/lib/utils'
import {
  ICON_BUTTON,
  KEYCAP,
  MODIFIER_KEYS,
  PENCIL,
  PILL,
  REBIND_BUTTON,
  RECORDING_ROW,
  ROW,
  RecordingBar,
  conflictMessage,
  useShortcutCapture
} from './shortcut-capture'

interface FolderOption {
  path: string
}

const SEARCH_FIELDS: (keyof FolderOption)[] = ['path']

function FolderOptions({ folders }: { folders: FolderOption[] }): React.JSX.Element {
  const { t } = useT('settings')
  const { searchQuery } = usePickerContext()
  const visible = usePickerSearch(folders, SEARCH_FIELDS, searchQuery)
  return (
    <Picker.List>
      {visible.length === 0 && <Picker.Empty message={t('shortcuts.folderNotes.noFolders')} />}
      {visible.map((folder) => (
        <Picker.Item
          key={folder.path}
          value={folder.path}
          label={folder.path}
          indicator="check"
          icon={<Folder className="size-3.5 shrink-0 text-muted-foreground" />}
        />
      ))}
    </Picker.List>
  )
}

interface FolderPickerProps {
  value: string | null
  folders: FolderOption[]
  onSelect: (folder: string) => void
  children: React.ReactNode
  label: string
}

function FolderPicker({
  value,
  folders,
  onSelect,
  children,
  label
}: FolderPickerProps): React.JSX.Element {
  const { t } = useT('settings')
  return (
    <Picker value={value} onValueChange={onSelect}>
      <Picker.Trigger variant="inline" aria-label={label} className="min-w-0 max-w-full">
        {children}
      </Picker.Trigger>
      <Picker.Content width={260} align="start">
        <Picker.Search placeholder={t('shortcuts.folderNotes.searchFolders')} />
        <FolderOptions folders={folders} />
      </Picker.Content>
    </Picker>
  )
}

interface RowProps {
  /** `null` for the row being added, which has no chord yet. */
  entry: FolderNoteShortcut | { folder: string; binding: null }
  folderExists: boolean
  pickableFolders: FolderOption[]
  others: FolderNoteShortcut[]
  overrides: Record<string, ShortcutBinding>
  onSave: (next: FolderNoteShortcut) => void
  onFolderChange: (folder: string) => void
  onRemove: () => void
}

function FolderNoteShortcutRow({
  entry,
  folderExists,
  pickableFolders,
  others,
  overrides,
  onSave,
  onFolderChange,
  onRemove
}: RowProps): React.JSX.Element {
  const { t } = useT('settings')
  const [conflict, setConflict] = useState<string | null>(null)
  const capture = useShortcutCapture(
    (e, stop) => {
      if (MODIFIER_KEYS.includes(e.key)) return
      const binding = bindingFromKeyboardEvent(e)
      const id = folderNoteShortcutId(entry.folder)
      const conflicts = findConflicts(id, binding, overrides, others)
      if (conflicts.length > 0) {
        setConflict(conflictMessage(t, conflicts))
        return
      }
      setConflict(null)
      stop()
      onSave({ folder: entry.folder, binding })
    },
    {
      // The row being added starts out recording; cancelling it abandons the row.
      initiallyCapturing: entry.binding === null,
      onCancel: () => {
        setConflict(null)
        if (entry.binding === null) onRemove()
      }
    }
  )
  const { isCapturing, captureRef, start, cancel } = capture

  const description = conflict
    ? conflict
    : isCapturing
      ? t('shortcuts.v2.recordingHint')
      : folderExists
        ? t('shortcuts.folderNotes.rowDescription')
        : t('shortcuts.folderNotes.missing')

  return (
    <div className={cn(ROW, isCapturing && RECORDING_ROW)} data-testid="folder-note-shortcut-row">
      {isCapturing && <RecordingBar />}
      <div className="flex flex-col gap-0.5 min-w-0">
        <FolderPicker
          value={entry.folder}
          folders={pickableFolders}
          onSelect={onFolderChange}
          label={t('shortcuts.folderNotes.changeFolder')}
        >
          <span className="flex min-w-0 items-center gap-1.5 text-[13px]/4 text-foreground">
            {folderExists ? (
              <Folder aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0 text-destructive" />
            )}
            <span className="truncate">{entry.folder}</span>
          </span>
        </FolderPicker>
        <span
          role={conflict || !folderExists ? 'alert' : undefined}
          className={cn(
            'text-xs/4',
            conflict || (!folderExists && !isCapturing)
              ? 'text-destructive'
              : 'text-muted-foreground'
          )}
        >
          {description}
        </span>
      </div>

      <div ref={captureRef} className="flex items-center gap-2.5 min-w-0">
        {isCapturing ? (
          <>
            <span className="text-xs/4 text-foreground">{t('shortcuts.pressShortcut')}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={cancel}
              className="size-6 p-0 text-muted-foreground hover:text-foreground"
              title={t('shortcuts.cancelTitle')}
            >
              <X className="size-3" />
            </Button>
          </>
        ) : (
          entry.binding && (
            <button
              type="button"
              onClick={start}
              className={REBIND_BUTTON}
              title={t('shortcuts.rebindTitle')}
            >
              <KbdGroup className={PILL}>
                {bindingParts(entry.binding).map((part) => (
                  <Kbd key={part} className={KEYCAP}>
                    {part}
                  </Kbd>
                ))}
              </KbdGroup>
              <Pencil aria-hidden="true" className={PENCIL} />
            </button>
          )
        )}
      </div>

      <div className="flex justify-end">
        {!isCapturing && (
          <button
            type="button"
            onClick={onRemove}
            className={ICON_BUTTON}
            title={t('shortcuts.folderNotes.remove')}
            aria-label={t('shortcuts.folderNotes.remove')}
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

interface FolderNoteShortcutsGroupProps {
  entries: FolderNoteShortcut[]
  overrides: Record<string, ShortcutBinding>
  onChange: (next: FolderNoteShortcut[]) => Promise<boolean>
}

/** Settings → Shortcuts → "New note in folder": one chord per folder. */
export function FolderNoteShortcutsGroup({
  entries,
  overrides,
  onChange
}: FolderNoteShortcutsGroupProps): React.JSX.Element {
  const { t } = useT('settings')
  const { folders } = useNoteFoldersQuery()
  const [draftFolder, setDraftFolder] = useState<string | null>(null)

  const existing = new Set(folders.map((folder) => folder.path))
  const assigned = new Set(entries.map((entry) => entry.folder))
  const unassigned = folders.filter((folder) => !assigned.has(folder.path))

  const save = async (next: FolderNoteShortcut[]): Promise<void> => {
    if (await onChange(next)) return
    trackRendererLog('warn', 'keyboard_settings_save_failed', 'Settings')
    toast.error(t('shortcuts.toasts.saveFailed'))
  }

  const rowFor = (entry: FolderNoteShortcut, index: number): React.JSX.Element => {
    const others = entries.filter((_, i) => i !== index)
    return (
      <FolderNoteShortcutRow
        key={entry.folder}
        entry={entry}
        folderExists={existing.has(entry.folder)}
        pickableFolders={folders.filter(
          (folder) => folder.path === entry.folder || !assigned.has(folder.path)
        )}
        others={others}
        overrides={overrides}
        onSave={(next) => void save(entries.map((e, i) => (i === index ? next : e)))}
        onFolderChange={(folder) =>
          void save(entries.map((e, i) => (i === index ? { ...e, folder } : e)))
        }
        onRemove={() => void save(others)}
      />
    )
  }

  return (
    <SettingsGroup
      label={t('shortcuts.folderNotes.title')}
      description={t('shortcuts.folderNotes.description')}
      action={
        <FolderPicker
          value={null}
          folders={unassigned}
          onSelect={setDraftFolder}
          label={t('shortcuts.folderNotes.add')}
        >
          <span className="flex items-center gap-1 text-xs/4 text-muted-foreground hover:text-foreground">
            <Plus aria-hidden="true" className="size-3.5" />
            {t('shortcuts.folderNotes.add')}
          </span>
        </FolderPicker>
      }
    >
      {entries.map(rowFor)}
      {draftFolder !== null && (
        <FolderNoteShortcutRow
          key={`draft:${draftFolder}`}
          entry={{ folder: draftFolder, binding: null }}
          folderExists
          pickableFolders={unassigned}
          others={entries}
          overrides={overrides}
          onSave={(next) => {
            setDraftFolder(null)
            void save([...entries, next])
          }}
          onFolderChange={setDraftFolder}
          onRemove={() => setDraftFolder(null)}
        />
      )}
      {entries.length === 0 && draftFolder === null && (
        <p className="py-3 text-xs/4 text-muted-foreground">{t('shortcuts.folderNotes.empty')}</p>
      )}
    </SettingsGroup>
  )
}
