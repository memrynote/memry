/**
 * OneNote panel inside the import dialog (account-based importer): Microsoft
 * sign-in state, the notebook → section group → section picker, and the two
 * import options. The dialog owns the actual run; this panel only reports
 * "ready + options" upward so the generic Start button can fire
 * `import:start` with the panel's choices.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import type {
  OneNoteAuthStatusResult,
  OneNoteImportOptionsInput,
  OneNoteNotebookDto,
  OneNoteSectionGroupDto
} from '@memry/contracts/import-channels'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { LabeledCheckbox } from '@/components/ui/labeled-checkbox'
import { extractErrorMessage } from '@/lib/ipc-error'

export interface OneNotePanelState {
  /** True when an import can start (connected + at least one section picked). */
  ready: boolean
  options: OneNoteImportOptionsInput
}

interface OneNoteImportPanelProps {
  disabled: boolean
  onStateChange: (state: OneNotePanelState) => void
}

/**
 * IPC commands resolve failures as `{ success: false, error }` instead of
 * rejecting, so every response has to be checked before it is used — an
 * unchecked envelope surfaces as a property-access crash instead of the real
 * error (see `lib/ipc-error`).
 */
function unwrap<T>(result: T | { success: false; error?: string }, fallback: string): T {
  if (result && typeof result === 'object' && (result as { success?: boolean }).success === false) {
    throw new Error((result as { error?: string }).error || fallback)
  }
  return result as T
}

function sectionIdsOfGroup(group: OneNoteSectionGroupDto): string[] {
  return [...group.sections.map((s) => s.id), ...group.sectionGroups.flatMap(sectionIdsOfGroup)]
}

function sectionIdsOfNotebook(notebook: OneNoteNotebookDto): string[] {
  return [
    ...notebook.sections.map((s) => s.id),
    ...notebook.sectionGroups.flatMap(sectionIdsOfGroup)
  ]
}

export function OneNoteImportPanel({ disabled, onStateChange }: OneNoteImportPanelProps) {
  const { t } = useT('settings')
  const [status, setStatus] = useState<OneNoteAuthStatusResult | null>(null)
  const [isConnecting, setIsConnecting] = useState(false)
  const [notebooks, setNotebooks] = useState<OneNoteNotebookDto[] | null>(null)
  const [isLoadingNotebooks, setIsLoadingNotebooks] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [includeIncompatible, setIncludeIncompatible] = useState(false)
  const [skipPrevious, setSkipPrevious] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadNotebooks = useCallback(async () => {
    setIsLoadingNotebooks(true)
    setError(null)
    try {
      const result = unwrap(await window.api.import.onenote.notebooks(), t('import.dialog.error'))
      if (!mountedRef.current) return
      setNotebooks(result.notebooks)
      // Preselect everything — the common case is "import my notebooks".
      setSelected(new Set(result.notebooks.flatMap(sectionIdsOfNotebook)))
    } catch (err) {
      if (!mountedRef.current) return
      setError(extractErrorMessage(err, t('import.dialog.error')))
    } finally {
      if (mountedRef.current) setIsLoadingNotebooks(false)
    }
  }, [t])

  useEffect(() => {
    let active = true
    void window.api.import.onenote
      .status()
      .then((raw) => {
        if (!active) return
        const result = unwrap(raw, t('import.dialog.error'))
        setStatus(result)
        if (result.connected) void loadNotebooks()
      })
      .catch((err) => {
        if (active) setError(extractErrorMessage(err, t('import.dialog.error')))
      })
    return () => {
      active = false
    }
  }, [loadNotebooks, t])

  // Wrapped in queueMicrotask so the parent state update happens
  // asynchronously — keeps the no-pass-{data,live-state}-to-parent rules
  // happy without changing observable behavior beyond a single microtask of
  // latency (same pattern as sidebar-tag-list.tsx's actions handoff).
  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      onStateChange({
        ready: Boolean(status?.connected) && selected.size > 0,
        options: {
          sectionIds: [...selected],
          includeIncompatibleAttachments: includeIncompatible,
          skipPreviouslyImported: skipPrevious
        }
      })
    })
    return () => {
      cancelled = true
    }
  }, [status, selected, includeIncompatible, skipPrevious, onStateChange])

  const connect = async () => {
    setIsConnecting(true)
    setError(null)
    try {
      const result = unwrap(await window.api.import.onenote.connect(), t('import.dialog.error'))
      if (!mountedRef.current) return
      setStatus(result)
      void loadNotebooks()
    } catch (err) {
      if (!mountedRef.current) return
      setError(extractErrorMessage(err, t('import.dialog.error')))
    } finally {
      if (mountedRef.current) setIsConnecting(false)
    }
  }

  const switchAccount = async () => {
    setError(null)
    try {
      unwrap(await window.api.import.onenote.disconnect(), t('import.dialog.error'))
      if (!mountedRef.current) return
      setStatus({ configured: true, connected: false, account: null })
      setNotebooks(null)
      setSelected(new Set())
    } catch (err) {
      if (mountedRef.current) setError(extractErrorMessage(err, t('import.dialog.error')))
    }
  }

  const toggleSection = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const allSectionIds = useMemo(() => (notebooks ?? []).flatMap(sectionIdsOfNotebook), [notebooks])
  const allSelected = allSectionIds.length > 0 && allSectionIds.every((id) => selected.has(id))

  const renderSections = (
    sections: { id: string; displayName: string }[],
    depth: number
  ): React.ReactNode =>
    sections.map((section) => (
      <div key={section.id} style={{ paddingInlineStart: `${depth * 16}px` }}>
        <LabeledCheckbox
          checked={selected.has(section.id)}
          onCheckedChange={(checked) => toggleSection(section.id, checked)}
          label={section.displayName}
          disabled={disabled}
        />
      </div>
    ))

  const renderGroups = (groups: OneNoteSectionGroupDto[], depth: number): React.ReactNode =>
    groups.map((group) => (
      <div key={group.id} className="flex flex-col gap-1">
        <p
          className="text-xs/4 font-medium text-muted-foreground"
          style={{ paddingInlineStart: `${depth * 16}px` }}
        >
          {group.displayName}
        </p>
        {renderSections(group.sections, depth + 1)}
        {renderGroups(group.sectionGroups, depth + 1)}
      </div>
    ))

  const connected = Boolean(status?.connected)

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {!connected && (
        <div className="flex flex-col gap-2">
          <Button size="sm" onClick={() => void connect()} disabled={disabled || isConnecting}>
            {isConnecting
              ? t('import.dialog.onenote.connecting')
              : t('import.dialog.onenote.connect')}
          </Button>
        </div>
      )}

      {connected && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-xs/4 text-muted-foreground">
            {t('import.dialog.onenote.connectedAs', {
              name: status?.account?.name || status?.account?.email || 'Microsoft',
              email: status?.account?.email ?? ''
            })}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void switchAccount()}
            disabled={disabled}
          >
            {t('import.dialog.onenote.switchAccount')}
          </Button>
        </div>
      )}

      {connected && isLoadingNotebooks && (
        <div className="flex items-center gap-2 text-[13px]/4 text-foreground">
          <Spinner />
          <span>{t('import.dialog.onenote.loadingNotebooks')}</span>
        </div>
      )}

      {connected && !isLoadingNotebooks && notebooks && notebooks.length === 0 && (
        <p className="text-xs/4 text-muted-foreground">
          {t('import.dialog.onenote.notebooksEmpty')}
        </p>
      )}

      {connected && !isLoadingNotebooks && notebooks && notebooks.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs/4 text-muted-foreground">
              {t('import.dialog.onenote.sectionsSelected', { count: selected.size })}
            </p>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => setSelected(allSelected ? new Set() : new Set(allSectionIds))}
            >
              {allSelected
                ? t('import.dialog.onenote.deselectAll')
                : t('import.dialog.onenote.selectAll')}
            </Button>
          </div>

          <div className="flex max-h-56 flex-col gap-2 overflow-y-auto rounded-md border border-border p-3">
            {notebooks.map((notebook) => (
              <div key={notebook.id} className="flex flex-col gap-1">
                <p className="text-[13px]/4 font-medium text-foreground">{notebook.displayName}</p>
                {renderSections(notebook.sections, 1)}
                {renderGroups(notebook.sectionGroups, 1)}
              </div>
            ))}
          </div>

          <LabeledCheckbox
            checked={skipPrevious}
            onCheckedChange={setSkipPrevious}
            label={t('import.dialog.onenote.skipPrevious')}
            description={t('import.dialog.onenote.skipPreviousHint')}
            disabled={disabled}
          />
          <LabeledCheckbox
            checked={includeIncompatible}
            onCheckedChange={setIncludeIncompatible}
            label={t('import.dialog.onenote.includeIncompatible')}
            description={t('import.dialog.onenote.includeIncompatibleHint')}
            disabled={disabled}
          />
        </div>
      )}

      {error && <p className="text-xs/4 text-destructive">{error}</p>}
    </div>
  )
}
