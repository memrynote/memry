/**
 * TemplateSelector Component
 *
 * A dialog for selecting a template when creating a new note.
 * Shows available templates with option to set folder default.
 */

import { useState, useMemo, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Search, FileText, Lock } from 'lucide-react'
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
}

export function TemplateSelector({
  isOpen,
  onClose,
  onSelect,
  folderPath,
  onSetFolderDefault
}: TemplateSelectorProps) {
  const { templates, isLoading } = useTemplates()
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>('blank')
  const [setAsFolderDefault, setSetAsFolderDefault] = useState(false)

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

    // Reset state
    setSearch('')
    setSelectedId('blank')
    setSetAsFolderDefault(false)
  }, [selectedId, setAsFolderDefault, onSelect, onSetFolderDefault])

  const handleClose = useCallback(() => {
    setSearch('')
    setSelectedId('blank')
    setSetAsFolderDefault(false)
    onClose()
  }, [onClose])

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-[500px] p-0 gap-0">
        <DialogHeader className="px-4 pt-4 pb-2">
          <DialogTitle>Select Template</DialogTitle>
          <DialogDescription>Choose a template to start your new note</DialogDescription>
        </DialogHeader>

        {/* Search input */}
        <div className="px-4 pb-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search templates..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
              autoFocus
            />
          </div>
        </div>

        {/* Template list */}
        <ScrollArea className="h-[300px] px-4">
          {isLoading ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              Loading templates...
            </div>
          ) : filteredTemplates.length === 0 ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              No templates found
            </div>
          ) : (
            <div className="space-y-4 py-2">
              {/* Built-in templates */}
              {builtInTemplates.length > 0 && (
                <div>
                  <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                    Built-in Templates
                  </div>
                  <div className="space-y-1">
                    {builtInTemplates.map((template) => (
                      <TemplateItem
                        key={template.id}
                        template={template}
                        isSelected={selectedId === template.id}
                        onClick={() => setSelectedId(template.id)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Custom templates */}
              {customTemplates.length > 0 && (
                <div>
                  <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                    My Templates
                  </div>
                  <div className="space-y-1">
                    {customTemplates.map((template) => (
                      <TemplateItem
                        key={template.id}
                        template={template}
                        isSelected={selectedId === template.id}
                        onClick={() => setSelectedId(template.id)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </ScrollArea>

        <DialogFooter className="px-4 py-3 border-t bg-muted/30">
          <div className="flex items-center justify-between w-full">
            {/* Set as folder default checkbox */}
            {folderPath && onSetFolderDefault && (
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={setAsFolderDefault}
                  onCheckedChange={(checked) => setSetAsFolderDefault(checked === true)}
                />
                <span className="text-sm text-muted-foreground">Set as folder default</span>
              </label>
            )}
            {!folderPath && <div />}

            <div className="flex gap-2">
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button onClick={handleSelect}>Create Note</Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ============================================================================
// Template Item Component
// ============================================================================

interface TemplateItemProps {
  template: {
    id: string
    name: string
    description?: string
    icon?: string | null
    isBuiltIn: boolean
  }
  isSelected: boolean
  onClick: () => void
}

function TemplateItem({ template, isSelected, onClick }: TemplateItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full flex items-start gap-3 p-3 rounded-lg text-left transition-colors',
        'hover:bg-accent/50',
        isSelected && 'bg-accent ring-2 ring-primary/50'
      )}
    >
      {/* Icon */}
      <div className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-md bg-muted text-lg">
        {template.icon || <FileText className="w-4 h-4 text-muted-foreground" />}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">{template.name}</span>
          {template.isBuiltIn && <Lock className="w-3 h-3 text-muted-foreground flex-shrink-0" />}
        </div>
        {template.description && (
          <p className="text-sm text-muted-foreground truncate mt-0.5">{template.description}</p>
        )}
      </div>
    </button>
  )
}

export default TemplateSelector
