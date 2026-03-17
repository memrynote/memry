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
        toast.success(`Note exported successfully`, {
          description: result.path
        })

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
        toast.error('Export failed', {
          description: extractErrorMessage(result.error, 'An unknown error occurred')
        })
      }
    } catch (error) {
      toast.error('Export failed', {
        description: extractErrorMessage(error, 'An unknown error occurred')
      })
    } finally {
      setIsExporting(false)
    }
  }, [format, noteId, includeMetadata, pageSize, onOpenChange])

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
            Export Note
          </DialogTitle>
          <DialogDescription>Export &quot;{noteTitle}&quot; to a file</DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Format Selection */}
          <div className="space-y-3">
            <Label className="text-sm font-medium">Format</Label>
            <RadioGroup
              value={format}
              onValueChange={(value) => setFormat(value as ExportFormat)}
              className="grid grid-cols-2 gap-3"
              disabled={isExporting}
            >
              <Label
                htmlFor="format-pdf"
                className={cn(
                  'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
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
                  <div className="font-medium text-sm">PDF</div>
                  <div className="text-xs text-muted-foreground">Print-ready document</div>
                </div>
              </Label>

              <Label
                htmlFor="format-html"
                className={cn(
                  'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
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
                  <div className="font-medium text-sm">HTML</div>
                  <div className="text-xs text-muted-foreground">Web-ready file</div>
                </div>
              </Label>
            </RadioGroup>
          </div>

          {/* Page Size (PDF only) */}
          {format === 'pdf' && (
            <div className="space-y-3">
              <Label htmlFor="page-size" className="text-sm font-medium">
                Page Size
              </Label>
              <Select
                value={pageSize}
                onValueChange={(value) => setPageSize(value as PageSize)}
                disabled={isExporting}
              >
                <SelectTrigger id="page-size" className="w-full">
                  <SelectValue placeholder="Select page size" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="A4">A4 (210 x 297 mm)</SelectItem>
                  <SelectItem value="Letter">Letter (8.5 x 11 in)</SelectItem>
                  <SelectItem value="Legal">Legal (8.5 x 14 in)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Options */}
          <div className="space-y-3">
            <Label className="text-sm font-medium">Options</Label>
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
                Include metadata (tags, dates)
              </Label>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isExporting}>
            Cancel
          </Button>
          <Button onClick={handleExport} disabled={isExporting || exportSuccess}>
            {isExporting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Exporting...
              </>
            ) : exportSuccess ? (
              <>
                <CheckCircle className="mr-2 h-4 w-4" />
                Exported!
              </>
            ) : (
              'Export'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
