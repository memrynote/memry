/**
 * TemplateSelector Component
 *
 * A refined, editorial-style dialog for selecting a template when creating a new note.
 * Uses reusable SelectableList, LabeledCheckbox, and PrimaryActionButton components.
 */

import { useState, useMemo, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SelectableListSection, SelectableListItem } from '@/components/ui/selectable-list'
import { LabeledCheckbox } from '@/components/ui/labeled-checkbox'
import { PrimaryActionButton } from '@/components/ui/primary-action-button'
import { Search, Lock, Sparkles, PenLine } from '@/lib/icons'
import { useTemplates } from '@/hooks/use-templates'
import { cn } from '@/lib/utils'

interface TemplateSelectorProps {
  /** Whether the dialog is open */
  isOpen: boolean
  /** Callback when dialog is closed */
  onClose: () => void
  /** Callback when a template is selected */
  onSelect: (templateId: string | null) => void
  /** Current folder path (for "Set as folder default" option) */
  folderPath?: string
  /** Callback when "Set as folder default" is selected */
  onSetFolderDefault?: (templateId: string) => void
  /** Whether this is a journal context (shows "Set as journal default" option) */
  isJournalContext?: boolean
  /** Current journal default template ID */
  journalDefaultTemplateId?: string | null
  /** Callback when "Set as journal default" is selected */
  onSetJournalDefault?: (templateId: string) => void
}

export function TemplateSelector({
  isOpen,
  onClose,
  onSelect,
  folderPath,
  onSetFolderDefault,
  isJournalContext = false,
  journalDefaultTemplateId,
  onSetJournalDefault
}: TemplateSelectorProps) {
  const { templates, isLoading } = useTemplates()
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>('blank')
  const [setAsFolderDefault, setSetAsFolderDefault] = useState(false)
  const [setAsJournalDefault, setSetAsJournalDefault] = useState(false)

  // Filter templates based on search
  const filteredTemplates = useMemo(() => {
    if (!search.trim()) return templates

    const searchLower = search.toLowerCase()
    return templates.filter(
      (t) =>
        t.name.toLowerCase().includes(searchLower) ||
        t.description?.toLowerCase().includes(searchLower)
    )
  }, [templates, search])

  // Separate built-in and custom templates
  const builtInTemplates = useMemo(
    () => filteredTemplates.filter((t) => t.isBuiltIn),
    [filteredTemplates]
  )
  const customTemplates = useMemo(
    () => filteredTemplates.filter((t) => !t.isBuiltIn),
    [filteredTemplates]
  )

  const handleSelect = useCallback(() => {
    onSelect(selectedId)

    // Set as folder default if checkbox is checked
    if (setAsFolderDefault && selectedId && onSetFolderDefault) {
      onSetFolderDefault(selectedId)
    }

    // Set as journal default if checkbox is checked
    if (setAsJournalDefault && selectedId && onSetJournalDefault) {
      onSetJournalDefault(selectedId)
    }

    // Reset state
    setSearch('')
    setSelectedId('blank')
    setSetAsFolderDefault(false)
    setSetAsJournalDefault(false)
  }, [
    selectedId,
    setAsFolderDefault,
    setAsJournalDefault,
    onSelect,
    onSetFolderDefault,
    onSetJournalDefault
  ])

  const handleClose = useCallback(() => {
    setSearch('')
    setSelectedId('blank')
    setSetAsFolderDefault(false)
    onClose()
  }, [onClose])

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent
        className={cn(
          'sm:max-w-[580px] p-0 gap-0 overflow-hidden',
          'bg-background',
          'border-border/60',
          'shadow-2xl shadow-stone-900/10 dark:shadow-black/40'
        )}
      >
        {/* Decorative header accent */}
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-amber-600/80 via-orange-500/60 to-amber-600/80" />

        {/* Header with editorial styling */}
        <DialogHeader className="px-6 pt-7 pb-4 relative">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-100 to-orange-100 dark:from-amber-900/40 dark:to-orange-900/30 flex items-center justify-center border border-amber-200/50 dark:border-amber-800/30 shadow-sm">
              <PenLine className="w-5 h-5 text-amber-700 dark:text-amber-400" />
            </div>
            <div>
              <DialogTitle className="text-xl font-semibold tracking-tight text-foreground">
                Choose Your Canvas
              </DialogTitle>
              <DialogDescription className="text-muted-foreground text-sm mt-0.5">
                Select a template to begin your note
              </DialogDescription>
            </div>
          </div>

          {/* Decorative flourish */}
          <div className="absolute right-6 top-6 opacity-[0.04] dark:opacity-[0.03]">
            <svg width="80" height="80" viewBox="0 0 80 80" fill="currentColor">
              <path d="M40 0C40 22.0914 22.0914 40 0 40C22.0914 40 40 57.9086 40 80C40 57.9086 57.9086 40 80 40C57.9086 40 40 22.0914 40 0Z" />
            </svg>
          </div>
        </DialogHeader>

        {/* Search input with refined styling */}
        <div className="px-6 pb-4">
          <div className="relative group">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/50 transition-colors group-focus-within:text-amber-600 dark:group-focus-within:text-amber-500" />
            <Input
              placeholder="Search templates..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className={cn(
                'pl-10 h-11',
                'bg-card/50',
                'border-border',
                'focus:border-amber-400 dark:focus:border-amber-600',
                'focus:ring-1 focus:ring-amber-100 dark:focus:ring-amber-900/30',
                'placeholder:text-muted-foreground/50',
                'transition-all duration-200'
              )}
              autoFocus
            />
          </div>
        </div>

        {/* Template list */}
        <ScrollArea className="h-[340px] px-6">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
              <div className="w-8 h-8 border-2 border-amber-200 dark:border-amber-800 border-t-amber-500 dark:border-t-amber-500 rounded-full animate-spin" />
              <span className="text-sm">Loading templates...</span>
            </div>
          ) : filteredTemplates.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
              <Search className="w-10 h-10 opacity-30" />
              <span className="text-sm">No templates found</span>
            </div>
          ) : (
            <div className="space-y-6 py-2 pb-4">
              {/* Custom templates first */}
              {customTemplates.length > 0 && (
                <SelectableListSection
                  title="My Templates"
                  count={customTemplates.length}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                >
                  {customTemplates.map((template) => (
                    <SelectableListItem
                      key={template.id}
                      id={template.id}
                      label={template.name}
                      description={template.description}
                      icon={template.icon}
                    />
                  ))}
                </SelectableListSection>
              )}

              {/* Built-in templates - collapsible, hidden by default */}
              {builtInTemplates.length > 0 && (
                <SelectableListSection
                  title="Essentials"
                  icon={<Sparkles className="w-3.5 h-3.5" />}
                  count={builtInTemplates.length}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  collapsible
                  defaultCollapsed
                >
                  {builtInTemplates.map((template) => (
                    <SelectableListItem
                      key={template.id}
                      id={template.id}
                      label={template.name}
                      description={template.description}
                      icon={template.icon}
                      badge={<Lock className="w-3 h-3 text-muted-foreground/40 flex-shrink-0" />}
                    />
                  ))}
                </SelectableListSection>
              )}
            </div>
          )}
        </ScrollArea>

        {/* Footer with refined actions */}
        <div className={cn('px-6 py-4 border-t', 'bg-muted/30', 'border-border/60')}>
          <div className="flex items-center justify-between">
            {/* Set as default checkboxes */}
            <div className="flex flex-col gap-1.5">
              {/* Folder default checkbox - for notes */}
              {folderPath && onSetFolderDefault && (
                <LabeledCheckbox
                  checked={setAsFolderDefault}
                  onCheckedChange={setSetAsFolderDefault}
                  label="Set as folder default"
                />
              )}
              {/* Journal default checkbox - for journal context */}
              {isJournalContext && onSetJournalDefault && selectedId && selectedId !== 'blank' && (
                <LabeledCheckbox
                  checked={setAsJournalDefault}
                  onCheckedChange={setSetAsJournalDefault}
                  label={
                    journalDefaultTemplateId === selectedId
                      ? 'Current journal default'
                      : 'Set as journal default'
                  }
                  disabled={journalDefaultTemplateId === selectedId}
                />
              )}
              {/* Empty div for spacing when no checkbox is shown */}
              {!folderPath &&
                !onSetFolderDefault &&
                (!isJournalContext || !onSetJournalDefault) && <div />}
            </div>

            <div className="flex gap-2.5">
              <Button variant="outline" onClick={handleClose} className="px-4">
                Cancel
              </Button>
              <PrimaryActionButton onClick={handleSelect}>
                <PenLine className="w-4 h-4" />
                {isJournalContext ? 'Use Template' : 'Create Note'}
              </PrimaryActionButton>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default TemplateSelector
