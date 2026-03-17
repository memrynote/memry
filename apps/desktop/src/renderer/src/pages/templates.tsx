/**
 * Templates Page - Editorial Collection Design
 *
 * A refined, list-style template gallery that treats templates
 * as curated design artifacts. Features elegant typography,
 * subtle hover states, and thoughtful micro-interactions.
 */

import { useState, useCallback, useMemo } from 'react'
import { useTabs } from '@/contexts/tabs'
import { useTemplates } from '@/hooks/use-templates'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import {
  Plus,
  FileText,
  Lock,
  Pencil,
  Trash2,
  Copy,
  Sparkles,
  LayoutTemplate,
  ChevronRight
} from '@/lib/icons'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { createLogger } from '@/lib/logger'

const log = createLogger('Page:Templates')

// ============================================================================
// Types
// ============================================================================

interface TemplateListItem {
  id: string
  name: string
  description?: string
  icon?: string | null
  isBuiltIn: boolean
}

// ============================================================================
// Template Icon Component - Renders emoji or fallback
// ============================================================================

function TemplateIcon({
  icon,
  size = 'md',
  className
}: {
  icon?: string | null
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  const sizeClasses = {
    sm: 'text-base',
    md: 'text-xl',
    lg: 'text-2xl'
  }

  if (icon) {
    return <span className={cn(sizeClasses[size], className)}>{icon}</span>
  }

  const iconSizes = {
    sm: 'w-4 h-4',
    md: 'w-5 h-5',
    lg: 'w-6 h-6'
  }

  return <FileText className={cn(iconSizes[size], 'text-muted-foreground/50', className)} />
}

// ============================================================================
// Main Component
// ============================================================================

export function TemplatesPage() {
  const { templates, isLoading, deleteTemplate, duplicateTemplate } = useTemplates()
  const { openTab } = useTabs()

  // Delete dialog state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [templateToDelete, setTemplateToDelete] = useState<TemplateListItem | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  // Separate built-in and custom templates
  const builtInTemplates = useMemo(() => templates.filter((t) => t.isBuiltIn), [templates])
  const customTemplates = useMemo(() => templates.filter((t) => !t.isBuiltIn), [templates])

  // Total count for header display
  const totalCount = templates.length

  // Handle creating a new template
  const handleNewTemplate = useCallback(() => {
    openTab({
      type: 'template-editor',
      title: 'New Template',
      icon: 'layout-template',
      path: '/templates/new',
      isPinned: false,
      isModified: false,
      isPreview: false,
      isDeleted: false
    })
  }, [openTab])

  // Handle editing a template
  const handleEditTemplate = useCallback(
    (template: TemplateListItem) => {
      openTab({
        type: 'template-editor',
        title: template.name,
        icon: 'layout-template',
        path: `/templates/${template.id}`,
        entityId: template.id,
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false
      })
    },
    [openTab]
  )

  // Handle duplicate template
  const handleDuplicateTemplate = useCallback(
    async (template: TemplateListItem) => {
      const result = await duplicateTemplate(template.id, `${template.name} (Copy)`)
      if (result) {
        toast.success(`Duplicated "${template.name}"`)
      } else {
        toast.error('Failed to duplicate template')
      }
    },
    [duplicateTemplate]
  )

  // Handle delete confirmation
  const handleDeleteClick = useCallback((template: TemplateListItem) => {
    setTemplateToDelete(template)
    setDeleteDialogOpen(true)
  }, [])

  // Handle delete confirmation
  const handleDeleteConfirm = useCallback(async () => {
    if (!templateToDelete) return

    setIsDeleting(true)
    try {
      const success = await deleteTemplate(templateToDelete.id)
      if (success) {
        toast.success(`Deleted "${templateToDelete.name}"`)
      } else {
        toast.error('Failed to delete template')
      }
    } catch (err) {
      log.error('Failed to delete template:', err)
      toast.error('Failed to delete template')
    } finally {
      setIsDeleting(false)
      setDeleteDialogOpen(false)
      setTemplateToDelete(null)
    }
  }, [templateToDelete, deleteTemplate])

  // Loading state with editorial elegance
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <div className="w-12 h-12 rounded-xl bg-muted/50 animate-pulse" />
            <div className="absolute inset-0 rounded-xl border border-border/50" />
          </div>
          <p className="font-serif text-sm text-muted-foreground/60 italic">
            Loading collection...
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Editorial Header */}
      <header
        className={cn('relative px-8 lg:px-12 pt-10 lg:pt-14 pb-8', 'border-b border-border/30')}
      >
        {/* Decorative large count watermark */}
        {totalCount > 0 && (
          <div
            className={cn(
              'absolute -right-4 lg:right-8 top-4 lg:top-8',
              'text-[7rem] lg:text-[9rem]',
              'font-display font-light leading-none',
              'text-foreground/[0.025] dark:text-foreground/[0.035]',
              'pointer-events-none select-none'
            )}
            aria-hidden="true"
          >
            {totalCount}
          </div>
        )}

        {/* Content layer */}
        <div className="relative z-10 max-w-4xl">
          {/* Eyebrow label */}
          <div className="flex items-center gap-2 mb-3">
            <LayoutTemplate className="w-3.5 h-3.5 text-amber-600/70 dark:text-amber-400/70" />
            <span className="text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground/60">
              Template Collection
            </span>
          </div>

          {/* Main title */}
          <h1
            className={cn(
              'font-display text-3xl lg:text-4xl font-normal tracking-tight',
              'text-foreground/90 mb-2'
            )}
          >
            Templates
          </h1>

          {/* Subtitle */}
          <p className={cn('font-serif text-base text-muted-foreground/70', 'max-w-md')}>
            Curated structures for your notes.{' '}
            <span className="text-muted-foreground/50">
              {customTemplates.length === 0
                ? 'Create your first template to get started.'
                : `${customTemplates.length} custom template${customTemplates.length !== 1 ? 's' : ''} in your collection.`}
            </span>
          </p>

          {/* New Template Button */}
          <div className="mt-6">
            <Button
              onClick={handleNewTemplate}
              className={cn(
                'gap-2.5 h-10 px-5',
                'bg-foreground hover:bg-foreground/90',
                'text-background font-medium',
                'shadow-sm hover:shadow-md',
                'transition-all duration-200'
              )}
            >
              <Plus className="w-4 h-4" />
              <span>New Template</span>
            </Button>
          </div>
        </div>
      </header>

      {/* Template List */}
      <ScrollArea className="flex-1">
        <div className="px-8 lg:px-12 py-10 space-y-12">
          {/* Custom Templates Section */}
          <section>
            {/* Section Header */}
            <div className="flex items-center gap-4 mb-4">
              <div className="flex items-center gap-2">
                <Sparkles className="w-3.5 h-3.5 text-amber-600/60 dark:text-amber-400/60" />
                <h2 className="text-xs font-semibold uppercase tracking-[0.15em] text-muted-foreground/50">
                  My Templates
                </h2>
              </div>
              <div className="flex-1 h-px bg-gradient-to-r from-border/40 to-transparent" />
              <span className="text-xs text-muted-foreground/40 tabular-nums">
                {customTemplates.length}
              </span>
            </div>

            {customTemplates.length > 0 ? (
              /* Template List */
              <div className="space-y-1">
                {customTemplates.map((template) => (
                  <TemplateListRow
                    key={template.id}
                    template={template}
                    onEdit={handleEditTemplate}
                    onDuplicate={handleDuplicateTemplate}
                    onDelete={handleDeleteClick}
                  />
                ))}
              </div>
            ) : (
              /* Empty State - Editorial Style */
              <EmptyTemplatesState onCreateTemplate={handleNewTemplate} />
            )}
          </section>

          {/* Built-in Templates Section */}
          {builtInTemplates.length > 0 && (
            <section>
              {/* Section Header */}
              <div className="flex items-center gap-4 mb-4">
                <div className="flex items-center gap-2">
                  <Lock className="w-3.5 h-3.5 text-muted-foreground/40" />
                  <h2 className="text-xs font-semibold uppercase tracking-[0.15em] text-muted-foreground/50">
                    Built-in
                  </h2>
                </div>
                <div className="flex-1 h-px bg-gradient-to-r from-border/40 to-transparent" />
              </div>

              {/* Template List */}
              <div className="space-y-1">
                {builtInTemplates.map((template) => (
                  <TemplateListRow
                    key={template.id}
                    template={template}
                    onEdit={handleEditTemplate}
                    onDuplicate={handleDuplicateTemplate}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      </ScrollArea>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-display text-xl">Delete Template</AlertDialogTitle>
            <AlertDialogDescription className="font-serif">
              Are you sure you want to delete "{templateToDelete?.name}"?
              <span className="block mt-2 text-muted-foreground/60 text-sm">
                Notes created from this template will not be affected.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel disabled={isDeleting} className="font-medium">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              disabled={isDeleting}
              className={cn(
                'bg-destructive text-destructive-foreground',
                'hover:bg-destructive/90 font-medium'
              )}
            >
              {isDeleting ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ============================================================================
// Template List Row - Clean List Item Style
// ============================================================================

interface TemplateListRowProps {
  template: TemplateListItem
  onEdit: (template: TemplateListItem) => void
  onDuplicate: (template: TemplateListItem) => void
  onDelete?: (template: TemplateListItem) => void
}

function TemplateListRow({ template, onEdit, onDuplicate, onDelete }: TemplateListRowProps) {
  return (
    <div
      className={cn(
        'group relative flex items-center gap-4',
        'px-4 py-3 -mx-4',
        'rounded-lg',
        'transition-all duration-200 ease-out',
        'hover:bg-muted/50',
        'cursor-pointer'
      )}
      onClick={() => onEdit(template)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onEdit(template)
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`Edit template: ${template.name}`}
    >
      {/* Icon */}
      <div
        className={cn(
          'flex-shrink-0',
          'w-10 h-10 rounded-lg',
          'bg-muted/60 dark:bg-muted/40',
          'flex items-center justify-center',
          'transition-all duration-200',
          'group-hover:bg-muted group-hover:scale-105'
        )}
      >
        <TemplateIcon icon={template.icon} size="md" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className={cn('font-medium text-sm', 'text-foreground/90', 'truncate')}>
            {template.name}
          </h3>
          {template.isBuiltIn && (
            <span
              className={cn(
                'flex-shrink-0',
                'inline-flex items-center gap-1',
                'px-1.5 py-0.5 rounded',
                'bg-muted/80 dark:bg-muted/60',
                'text-[0.6rem] font-medium uppercase tracking-wide',
                'text-muted-foreground/60'
              )}
            >
              <Lock className="w-2.5 h-2.5" />
              Built-in
            </span>
          )}
        </div>
        {template.description && (
          <p className={cn('text-sm text-muted-foreground/60', 'truncate mt-0.5')}>
            {template.description}
          </p>
        )}
      </div>

      {/* Actions - Icon buttons */}
      <div
        className={cn(
          'flex items-center gap-0.5',
          'opacity-0 group-hover:opacity-100',
          'transition-opacity duration-150'
        )}
        role="group"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          onClick={() => onEdit(template)}
          title={template.isBuiltIn ? 'View' : 'Edit'}
        >
          <Pencil className="w-4 h-4" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          onClick={() => onDuplicate(template)}
          title="Duplicate"
        >
          <Copy className="w-4 h-4" />
        </Button>

        {!template.isBuiltIn && onDelete && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            onClick={() => onDelete(template)}
            title="Delete"
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        )}
      </div>

      {/* Chevron indicator */}
      <ChevronRight
        className={cn(
          'w-4 h-4 text-muted-foreground/30',
          'transition-all duration-200',
          'group-hover:text-muted-foreground/60 group-hover:translate-x-0.5'
        )}
      />
    </div>
  )
}

// ============================================================================
// Empty State - Editorial Elegance
// ============================================================================

interface EmptyTemplatesStateProps {
  onCreateTemplate: () => void
}

function EmptyTemplatesState({ onCreateTemplate }: EmptyTemplatesStateProps) {
  return (
    <div
      className={cn(
        'relative py-16 px-6',
        'flex flex-col items-center justify-center',
        'text-center',
        'rounded-xl',
        'border border-dashed border-border/50'
      )}
    >
      {/* Decorative icon composition */}
      <div className="relative mb-6">
        {/* Background glow */}
        <div
          className={cn(
            'absolute inset-0 -m-6',
            'bg-amber-500/5 dark:bg-amber-400/5',
            'rounded-full blur-2xl'
          )}
          aria-hidden="true"
        />

        {/* Icon stack */}
        <div className="relative">
          <div
            className={cn(
              'w-16 h-16 rounded-xl',
              'bg-gradient-to-br from-muted/60 to-muted',
              'border border-border/50',
              'flex items-center justify-center',
              'shadow-sm'
            )}
          >
            <FileText className="w-8 h-8 text-muted-foreground/30" />
          </div>

          {/* Floating plus indicator */}
          <div
            className={cn(
              'absolute -bottom-1.5 -right-1.5',
              'w-6 h-6 rounded-md',
              'bg-amber-500 dark:bg-amber-400',
              'flex items-center justify-center',
              'shadow-md shadow-amber-500/20 dark:shadow-amber-400/20'
            )}
          >
            <Plus className="w-3.5 h-3.5 text-white dark:text-amber-950" />
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="relative z-10 max-w-xs">
        <h3 className="font-display text-lg text-foreground/80 mb-1.5">Start Your Collection</h3>
        <p className="font-serif text-sm text-muted-foreground/60 mb-5 leading-relaxed">
          Templates help you create notes with consistent structure.
        </p>
        <Button
          onClick={onCreateTemplate}
          variant="outline"
          className={cn(
            'gap-2 h-9 px-4',
            'font-medium',
            'transition-all duration-200',
            'hover:bg-foreground hover:text-background',
            'hover:border-foreground'
          )}
        >
          <Plus className="w-4 h-4" />
          Create Template
        </Button>
      </div>
    </div>
  )
}

export default TemplatesPage
