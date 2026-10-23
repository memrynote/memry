import { getI18n } from 'react-i18next'
/**
 * ExportDialog Component
 *
 * Dialog for exporting a note to PDF or HTML format.
 * Provides format selection, page size options (for PDF), and metadata toggle.
 *
 * @module components/note/export-dialog
 */

import React, { useState, useCallback, useEffect } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import { trackTelemetry } from '@/lib/telemetry'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { FileText, FileCode, Loader2, CheckCircle } from '@/lib/icons'
import { notesService, type ExportNoteResponse } from '@/services/notes-service'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

// ============================================================================
// Types
// ============================================================================

interface ExportDialogProps {
  /** Whether the dialog is open */
  open: boolean
  /** Callback when dialog open state changes */
  onOpenChange: (open: boolean) => void
  /** ID of the note to export */
  noteId: string
  /** Title of the note (for display) */
  noteTitle: string
}

type ExportFormat = 'pdf' | 'html'
type PageSize = 'A4' | 'Letter' | 'Legal'

// ============================================================================
// Component
// ============================================================================

export function ExportDialog({
  open,
  onOpenChange,
  noteId,
  noteTitle
}: ExportDialogProps): React.ReactElement {
  const { t: tPhaseF } = useT('notes')
  const { t } = useT('notes')
  const { t: tCommon } = useT('common')
  // Form state
  const [format, setFormat] = useState<ExportFormat>('pdf')
  const [pageSize, setPageSize] = useState<PageSize>('A4')
  const [includeMetadata, setIncludeMetadata] = useState(true)

  // Export state
  const [isExporting, setIsExporting] = useState(false)
  const [exportSuccess, setExportSuccess] = useState(false)

  /**
   * Handle Escape key to close dialog
   */
  useEffect(() => {
    if (!open) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isExporting) {
        e.preventDefault()
        onOpenChange(false)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, isExporting, onOpenChange])

  /**
   * Handle export action
   */
  const handleExport = useCallback(async () => {
    setIsExporting(true)
    setExportSuccess(false)

    try {
      let result: ExportNoteResponse

      if (format === 'pdf') {
        result = await notesService.exportPdf({
          noteId,
          includeMetadata,
          pageSize
        })
      } else {
        result = await notesService.exportHtml({
          noteId,
          includeMetadata
        })
      }

      if (result.success) {
        setExportSuccess(true)
        void trackTelemetry('note_exported', {
          surface: 'notes',
          action: 'exported',
          objectType: 'note',
          result: 'success',
          dimensions: { format }
        })
        toast.success(
          getI18n().getFixedT(null, 'notes')('phaseI.toasts.noteExportedSuccessfully'),
          {
            description: result.path
          }
        )

        // Close dialog after short delay to show success state
        setTimeout(() => {
          onOpenChange(false)
          // Reset state after dialog closes
          setTimeout(() => {
            setExportSuccess(false)
            setFormat('pdf')
            setPageSize('A4')
            setIncludeMetadata(true)
          }, 200)
        }, 800)
      } else if (result.error === 'Export cancelled') {
        // User cancelled - do nothing
      } else {
        trackRendererError('note_export_failed', result.error)
        toast.error(t('exportDialog.toast.failed'), {
          description: extractErrorMessage(
            result.error,
            getI18n().getFixedT(null, 'errors')('generic.unknown')
          )
        })
      }
    } catch (error) {
      trackRendererError('note_export_failed', error)
      toast.error(t('exportDialog.toast.failed'), {
        description: extractErrorMessage(
          error,
          getI18n().getFixedT(null, 'errors')('generic.unknown')
        )
      })
    } finally {
      setIsExporting(false)
    }
  }, [format, noteId, includeMetadata, pageSize, onOpenChange, t])

  /**
   * Handle dialog close - reset state
   */
  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (!newOpen) {
        // Reset state when closing
        setTimeout(() => {
          setExportSuccess(false)
          setFormat('pdf')
          setPageSize('A4')
          setIncludeMetadata(true)
        }, 200)
      }
      onOpenChange(newOpen)
    },
    [onOpenChange]
  )

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {exportSuccess ? (
              <CheckCircle className="h-5 w-5 text-green-500" />
            ) : format === 'pdf' ? (
              <FileText className="h-5 w-5 text-red-500" />
            ) : (
              <FileCode className="h-5 w-5 text-blue-500" />
            )}
            {t('exportDialog.title')}
          </DialogTitle>
          <DialogDescription>
            {t('exportDialog.description', { title: noteTitle })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Format Selection */}
          <div className="space-y-3">
            <Label className="text-sm font-medium">{t('exportDialog.format')}</Label>
            <RadioGroup
              value={format}
              onValueChange={(value) => setFormat(value as ExportFormat)}
              className="grid grid-cols-2 gap-3"
              disabled={isExporting}
            >
              <Label
                htmlFor="format-pdf"
                className={cn(
                  'flex items-center gap-3 p-3 rounded-md border cursor-pointer transition-colors',
                  format === 'pdf'
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-muted/50'
                )}
              >
                <RadioGroupItem value="pdf" id="format-pdf" className="sr-only" />
                <FileText
                  className={cn(
                    'h-5 w-5',
                    format === 'pdf' ? 'text-red-500' : 'text-muted-foreground'
                  )}
                />
                <div>
                  <div className="font-medium text-sm">
                    {tPhaseF('phaseF.componentsNoteExportDialog.pdf')}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t('exportDialog.pdfDescription')}
                  </div>
                </div>
              </Label>

              <Label
                htmlFor="format-html"
                className={cn(
                  'flex items-center gap-3 p-3 rounded-md border cursor-pointer transition-colors',
                  format === 'html'
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-muted/50'
                )}
              >
                <RadioGroupItem value="html" id="format-html" className="sr-only" />
                <FileCode
                  className={cn(
                    'h-5 w-5',
                    format === 'html' ? 'text-blue-500' : 'text-muted-foreground'
                  )}
                />
                <div>
                  <div className="font-medium text-sm">
                    {tPhaseF('phaseF.componentsNoteExportDialog.html')}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t('exportDialog.htmlDescription')}
                  </div>
                </div>
              </Label>
            </RadioGroup>
          </div>

          {/* Page Size (PDF only) */}
          {format === 'pdf' && (
            <div className="space-y-3">
              <Label htmlFor="page-size" className="text-sm font-medium">
                {t('exportDialog.pageSize')}
              </Label>
              <Select
                value={pageSize}
                onValueChange={(value) => setPageSize(value as PageSize)}
                disabled={isExporting}
              >
                <SelectTrigger id="page-size" className="w-full">
                  <SelectValue placeholder={t('exportDialog.selectPageSize')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="A4">
                    {tPhaseF('phaseF.componentsNoteExportDialog.a4210X297Mm')}
                  </SelectItem>
                  <SelectItem value="Letter">
                    {tPhaseF('phaseF.componentsNoteExportDialog.letter85X11In')}
                  </SelectItem>
                  <SelectItem value="Legal">
                    {tPhaseF('phaseF.componentsNoteExportDialog.legal85X14In')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Options */}
          <div className="space-y-3">
            <Label className="text-sm font-medium">{t('exportDialog.options')}</Label>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="include-metadata"
                checked={includeMetadata}
                onCheckedChange={(checked) => setIncludeMetadata(checked === true)}
                disabled={isExporting}
              />
              <Label
                htmlFor="include-metadata"
                className="text-sm text-muted-foreground cursor-pointer"
              >
                {t('exportDialog.includeMetadata')}
              </Label>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isExporting}>
            {tCommon('button.cancel')}
          </Button>
          <Button onClick={() => void handleExport()} disabled={isExporting || exportSuccess}>
            {isExporting ? (
              <>
                <Loader2 className="me-2 h-4 w-4 animate-spin" />
                {t('exportDialog.exporting')}
              </>
            ) : exportSuccess ? (
              <>
                <CheckCircle className="me-2 h-4 w-4" />
                {t('exportDialog.exported')}
              </>
            ) : (
              t('exportDialog.export')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
