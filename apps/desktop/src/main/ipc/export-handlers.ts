import { ipcMain, dialog, BrowserWindow } from 'electron'
import * as fs from 'fs/promises'
import { NotesChannels } from '@memry/contracts/notes-api'
import { ExportNoteSchema } from './notes-schemas'
import { createValidatedHandler } from './validate'
import { getNoteById } from '../vault/notes'
import { renderNoteAsHtml, sanitizeFilename } from '../lib/export-utils'
import { extractError } from './handler-utils'

type ExportFormat = 'pdf' | 'html'

interface ExportConfig {
  format: ExportFormat
  dialogTitle: string
  extension: string
  filterName: string
  filterExtensions: string[]
}

const EXPORT_CONFIGS: Record<ExportFormat, ExportConfig> = {
  pdf: {
    format: 'pdf',
    dialogTitle: 'Export as PDF',
    extension: 'pdf',
    filterName: 'PDF Document',
    filterExtensions: ['pdf']
  },
  html: {
    format: 'html',
    dialogTitle: 'Export as HTML',
    extension: 'html',
    filterName: 'HTML Document',
    filterExtensions: ['html', 'htm']
  }
}

async function exportNote(
  input: { noteId: string; includeMetadata: boolean; pageSize: string },
  format: ExportFormat
): Promise<{ success: boolean; path?: string; error?: string }> {
  const config = EXPORT_CONFIGS[format]

  const note = await getNoteById(input.noteId)
  if (!note) {
    return { success: false, error: 'Note not found' }
  }

  const defaultFilename = `${sanitizeFilename(note.title)}.${config.extension}`
  const result = await dialog.showSaveDialog({
    title: config.dialogTitle,
    defaultPath: defaultFilename,
    filters: [{ name: config.filterName, extensions: config.filterExtensions }]
  })

  if (result.canceled || !result.filePath) {
    return { success: false, error: 'Export cancelled' }
  }

  const html = renderNoteAsHtml(
    {
      id: note.id,
      title: note.title,
      content: note.content,
      emoji: note.emoji,
      tags: note.tags,
      created: note.created,
      modified: note.modified
    },
    { includeMetadata: input.includeMetadata }
  )

  if (format === 'pdf') {
    const win = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      webPreferences: { javascript: false }
    })

    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    await new Promise((resolve) => setTimeout(resolve, 100))

    const pageSizeMap: Record<string, Electron.PrintToPDFOptions['pageSize']> = {
      A4: 'A4',
      Letter: 'Letter',
      Legal: 'Legal'
    }

    const pdfData = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: pageSizeMap[input.pageSize] || 'A4',
      margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 }
    })

    win.destroy()
    await fs.writeFile(result.filePath, pdfData)
  } else {
    await fs.writeFile(result.filePath, html, 'utf-8')
  }

  return { success: true, path: result.filePath }
}

export function registerExportHandlers(): void {
  ipcMain.handle(
    NotesChannels.invoke.EXPORT_PDF,
    createValidatedHandler(ExportNoteSchema, async (input) => {
      try {
        return await exportNote(input, 'pdf')
      } catch (error) {
        return { success: false, error: extractError(error, 'Failed to export PDF') }
      }
    })
  )

  ipcMain.handle(
    NotesChannels.invoke.EXPORT_HTML,
    createValidatedHandler(ExportNoteSchema, async (input) => {
      try {
        return await exportNote(input, 'html')
      } catch (error) {
        return { success: false, error: extractError(error, 'Failed to export HTML') }
      }
    })
  )
}

export function unregisterExportHandlers(): void {
  ipcMain.removeHandler(NotesChannels.invoke.EXPORT_PDF)
  ipcMain.removeHandler(NotesChannels.invoke.EXPORT_HTML)
}
