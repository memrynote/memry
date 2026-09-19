/**
 * Apple Notes folder picker inside the import dialog.
 *
 * Apple Notes is file-picked, not account-based: the user first grants access
 * to the `group.com.apple.notes` container, then this panel reads the folder
 * tree from that path (`import:apple-notes:folders`, no note bodies decoded)
 * and reports the picked folders upward so the dialog's Start button can fire
 * `import:start` with them in `options`.
 *
 * A scan that fails is not a dead end: the panel shows the error and stays
 * ready with an empty selection, which the importer reads as "import
 * everything" — the pre-picker behavior.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import type {
  AppleNotesFolderNode,
  AppleNotesFoldersResult,
  AppleNotesImportOptionsInput
} from '@memry/contracts/import-channels'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Spinner } from '@/components/ui/spinner'
import { extractErrorMessage } from '@/lib/ipc-error'

export interface AppleNotesPanelState {
  /** False while the tree loads or when the user cleared every folder. */
  ready: boolean
  options: AppleNotesImportOptionsInput
}

interface AppleNotesFolderPanelProps {
  /** The folder/file the user picked; the scan reads its NoteStore.sqlite. */
  sourcePath: string
  disabled: boolean
  onStateChange: (state: AppleNotesPanelState) => void
}

function folderIdsOf(node: AppleNotesFolderNode): string[] {
  return [node.id, ...node.children.flatMap(folderIdsOf)]
}

function allFolderIds(tree: AppleNotesFoldersResult): string[] {
  return tree.accounts.flatMap((account) => account.folders.flatMap(folderIdsOf))
}

export function AppleNotesFolderPanel({
  sourcePath,
  disabled,
  onStateChange
}: AppleNotesFolderPanelProps) {
  const { t } = useT('settings')
  const [tree, setTree] = useState<AppleNotesFoldersResult | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [includeUnfiled, setIncludeUnfiled] = useState(true)

  // The dialog keys this panel by source path, so one mount scans one source:
  // the loading/error state starts correct and is only written on resolution.
  useEffect(() => {
    let active = true
    void window.api.import.appleNotes
      .folders({ sourcePath })
      .then((result) => {
        if (!active) return
        setTree(result)
        // Everything on by default — the common case is "import my notes".
        setSelected(new Set(allFolderIds(result)))
        setIncludeUnfiled(true)
      })
      .catch((err) => {
        if (active) setError(extractErrorMessage(err, t('import.dialog.appleNotes.foldersError')))
      })
      .finally(() => {
        if (active) setIsLoading(false)
      })
    return () => {
      active = false
    }
  }, [sourcePath, t])

  // Wrapped in queueMicrotask so the parent state update happens asynchronously
  // (same handoff pattern as onenote-import-panel).
  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      // No tree (still loading, or the scan failed) → no selection, which the
      // importer reads as the whole library.
      if (!tree) {
        onStateChange({ ready: !isLoading, options: {} })
        return
      }
      onStateChange({
        ready: selected.size > 0 || includeUnfiled,
        options: { folderIds: [...selected], includeUnfiledNotes: includeUnfiled }
      })
    })
    return () => {
      cancelled = true
    }
  }, [tree, isLoading, selected, includeUnfiled, onStateChange])

  const toggleFolder = useCallback((node: AppleNotesFolderNode, checked: boolean) => {
    const ids = folderIdsOf(node)
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (checked) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }, [])

  const everyId = useMemo(() => (tree ? allFolderIds(tree) : []), [tree])
  const allSelected =
    everyId.length > 0 && everyId.every((id) => selected.has(id)) && includeUnfiled

  const countLabel = (node: AppleNotesFolderNode): string =>
    node.totalNoteCount === node.noteCount
      ? t('import.dialog.appleNotes.noteCount', { count: node.noteCount })
      : t('import.dialog.appleNotes.noteCountWithSubfolders', {
          count: node.noteCount,
          total: node.totalNoteCount
        })

  const renderRow = (
    key: string,
    label: string,
    count: string,
    checked: boolean | 'indeterminate',
    onChange: (checked: boolean) => void,
    depth: number
  ): React.ReactNode => (
    <label
      key={key}
      className="flex cursor-pointer items-center gap-2 py-0.5"
      style={{ paddingInlineStart: `${depth * 16}px` }}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
        disabled={disabled}
        className="border-muted-foreground/30"
      />
      <span className="min-w-0 flex-1 truncate text-[13px]/4 text-foreground">{label}</span>
      <span className="text-xs/4 text-muted-foreground">{count}</span>
    </label>
  )

  const renderFolder = (node: AppleNotesFolderNode, depth: number): React.ReactNode => {
    const ids = folderIdsOf(node)
    const picked = ids.filter((id) => selected.has(id)).length
    const checked = picked === ids.length ? true : picked === 0 ? false : 'indeterminate'
    return (
      <div key={node.id} className="flex flex-col">
        {renderRow(
          node.id,
          node.title,
          countLabel(node),
          checked,
          (next) => toggleFolder(node, next),
          depth
        )}
        {node.children.map((child) => renderFolder(child, depth + 1))}
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-[13px]/4 text-foreground">
        <Spinner />
        <span>{t('import.dialog.appleNotes.loadingFolders')}</span>
      </div>
    )
  }

  if (error || !tree) {
    return <p className="text-xs/4 text-destructive">{error}</p>
  }

  const multiAccount = tree.accounts.length > 1

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs/4 text-muted-foreground">
          {t('import.dialog.appleNotes.foldersSelected', { count: selected.size })}
        </p>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => {
            setSelected(allSelected ? new Set() : new Set(everyId))
            setIncludeUnfiled(!allSelected)
          }}
        >
          {allSelected
            ? t('import.dialog.appleNotes.deselectAll')
            : t('import.dialog.appleNotes.selectAll')}
        </Button>
      </div>

      <div className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-md border border-border p-3">
        {tree.accounts.map((account, index) => (
          <div key={account.name || index} className="flex flex-col">
            {multiAccount && account.name && (
              <p className="text-[13px]/4 font-medium text-foreground">{account.name}</p>
            )}
            {account.folders.map((folder) => renderFolder(folder, multiAccount ? 1 : 0))}
          </div>
        ))}
        {tree.unfiledNoteCount > 0 &&
          renderRow(
            'unfiled',
            t('import.dialog.appleNotes.unfiled'),
            t('import.dialog.appleNotes.noteCount', { count: tree.unfiledNoteCount }),
            includeUnfiled,
            setIncludeUnfiled,
            0
          )}
      </div>
    </div>
  )
}
